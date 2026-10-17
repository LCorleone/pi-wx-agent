import {
  createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ResourceLoader, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Config } from "./config.js";
import { AssistantResponseError, MissingMappedSessionError } from "./diagnostics.js";
import type { BridgeSession, SessionFactory, SessionIntrospection } from "./pi-agent.js";

/** Only completed assistant events from THIS prompt may become a WeChat reply. */
export function wrapSession(session: AgentSession): BridgeSession {
  // External-reply hook: a LIFETIME subscription that fires when a completed assistant
  // message (stopReason "stop") ends a turn the bridge itself did not initiate — e.g.
  // another Pi session steering this one through a control extension. Two guards make
  // bridge-initiated activity invisible to the hook:
  // - `busyDepth` is held for the ENTIRE duration of run() and compact() (every
  //   bridge-driven window; dream goes through run(), so dreams never push), so the
  //   bridge's own chat replies, dream replies and compaction emissions are suppressed,
  //   and an assistant message_end landing mid-run is ignored rather than pushed.
  // - stopReason "stop": pi-agent-core's loop emits message_end for EVERY assistant
  //   segment, with stopReason "toolUse" on intermediate tool-calling segments; only the
  //   final one carries "stop". Without this filter each tool segment of an external
  //   turn would fire the hook separately.
  let externalHook: ((text: string) => void) | undefined;
  let busyDepth = 0;
  session.subscribe(event => {
    if (busyDepth > 0 || !externalHook || event.type !== "message_end" ||
        event.message.role !== "assistant" || event.message.stopReason !== "stop") return;
    externalHook(event.message.content.filter(block => block.type === "text").map(block => block.text).join("\n"));
  });
  return {
    get isIdle() { return session.isIdle; },
    async run(text) {
      if (!session.isIdle) throw new Error("Session is busy");
      busyDepth++;
      let reply: string | undefined;
      let stopReason: string = "none";
      const unsubscribe = session.subscribe(event => {
        if (event.type === "message_end" && event.message.role === "assistant") {
          stopReason = event.message.stopReason;
          reply = event.message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
        }
      });
      try {
        await session.prompt(text);
        if (stopReason !== "stop" || reply === undefined) throw new AssistantResponseError(stopReason);
        return reply || "（本轮无文字回复）";
      } finally { unsubscribe(); busyDepth--; }
    },
    abort: () => session.abort(),
    compact: async instructions => {
      busyDepth++;
      try { return await session.compact(instructions); }
      finally { busyDepth--; }
    },
    introspect: (): SessionIntrospection => ({
      model: session.model ? { provider: session.model.provider, id: session.model.id, contextWindow: session.model.contextWindow } : undefined,
      thinkingLevel: session.thinkingLevel,
      isIdle: session.isIdle,
      stats: session.getSessionStats(),
      contextUsage: session.getContextUsage(),
      activeTools: session.getActiveToolNames(),
    }),
    setExternalReplyHook: hook => { externalHook = hook; },
    dispose: () => session.dispose(),
  };
}

/** Unknown flag names already warned about in this process: one warning per name, not per session. */
const warnedUnknownFlags = new Set<string>();

/** Heading of the generated system-prompt section that describes extension-provided tools. */
const EXTENSION_TOOLS_HEADING = "Additional tools provided by the deployer's extensions";

/** True for tools the addendum should describe: snippet-less (the system prompt's
 *  Available-tools section already lists snippet-carrying tools, extensions/types.d.ts
 *  promptSnippet: "Custom tools are omitted from that section when this is not provided"),
 *  declarable exposure, and not defaultActive:false. */
function describableTool(definition: ToolDefinition): boolean {
  return definition.promptSnippet === undefined && definition.defaultActive !== false &&
    (definition.exposure === undefined || definition.exposure === "direct" || definition.exposure === "model-only");
}

/**
 * Make extension tools MODEL-VISIBLE, not just registered. pi already activates them —
 * load-time ones in the AgentSession constructor's includeAllExtensionTools pass
 * (agent-session.js:211-213) and lazily-registered ones in _refreshToolRegistry's
 * no-activeToolNames branch — and active tools are declared as API tool schemas. But the
 * system prompt's "Available tools" section lists only tools whose definition carries a
 * promptSnippet ("Tools without a snippet are not listed", agent-session.js
 * _rebuildSystemPrompt; system-prompt.js filters to toolSnippets), so extensions that omit
 * promptSnippet register active yet undescribed tools the model will not discover. This
 * delegating ResourceLoader appends a generated description section: getAppendSystemPrompt
 * is re-read on every system-prompt rebuild (agent-session.js:1282 -> promptSections.addendum)
 * and reads the live extension tool maps, so load-time AND later (session_start)
 * registrations are covered alike. defaultActive:false and non-declarable tools are left out.
 */
function describeExtensionTools(loader: DefaultResourceLoader): ResourceLoader {
  const describedSections = () => {
    const tools = new Map<string, ToolDefinition>();
    for (const extension of loader.getExtensions().extensions) {
      for (const tool of extension.tools.values()) {
        if (!tools.has(tool.definition.name)) tools.set(tool.definition.name, tool.definition);
      }
    }
    const lines = [...tools.values()].filter(describableTool)
      .map(definition => `- ${definition.name}: ${definition.description}`).sort();
    return lines.length ? [`${EXTENSION_TOOLS_HEADING}:\n${lines.join("\n")}`] : [];
  };
  return {
    getExtensions: () => loader.getExtensions(),
    getSkills: () => loader.getSkills(),
    getPrompts: () => loader.getPrompts(),
    getThemes: () => loader.getThemes(),
    getAgentsFiles: () => loader.getAgentsFiles(),
    getSystemPrompt: () => loader.getSystemPrompt(),
    getSystemPromptSource: () => loader.getSystemPromptSource(),
    getAppendSystemPrompt: () => [...loader.getAppendSystemPrompt(), ...describedSections()],
    getAppendSystemPromptSources: () => loader.getAppendSystemPromptSources(),
    extendResources: paths => loader.extendResources(paths),
    reload: options => loader.reload(options),
  };
}

/**
 * ResourceLoader for deployer-configured extensions, or undefined when none are listed
 * (createAgentSession then builds its own default loader, exactly as before this option
 * existed — no operator extensions are loaded unless explicitly listed).
 *
 * DefaultResourceLoader normally merges `additionalExtensionPaths` with every extension it
 * discovers from the operator's global settings and <agentDir>/extensions plus the
 * workspace project dir (package-manager resolve() + addAutoDiscoveredResources).
 * `noExtensions: true` restricts the load set to exactly the additional paths: in the
 * installed pi 1.3.0 (dist/core/resource-loader.js, both reload() and
 * loadCurrentExtensionSet()) the set is
 *   noExtensions ? cliEnabledExtensions : mergePaths(cliEnabledExtensions, enabledExtensions)
 * where cliEnabledExtensions are precisely additionalExtensionPaths ("cli"/temporary
 * scope) and enabledExtensions are the settings/auto-discovered ones. Verified, not
 * guessed: noExtensions:true still loads additional paths while suppressing all
 * global/user/project extension discovery.
 */
export async function extensionResourceLoader(
  cwd: string,
  settingsManager: SettingsManager,
  extensions: readonly string[] | undefined,
  extensionFlags: Readonly<Record<string, boolean | string>> | undefined,
): Promise<ResourceLoader | undefined> {
  if (!extensions?.length) return undefined;
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    settingsManager,
    additionalExtensionPaths: [...extensions],
    noExtensions: true,
  });
  // createAgentSession only reloads a loader it built itself (core/sdk.js), so reload here.
  await loader.reload();
  const result = loader.getExtensions();
  // The loader itself prints nothing; pi's CLI surfaces these because the embedder is expected
  // to report them (dist/main.js:652/:747). Report each failure so a broken extension is
  // visible instead of silently absent (paths are the deployer's own config, local logs only).
  for (const failure of result.errors) {
    console.error(`Extension failed to load; ${failure.path}: ${failure.error}`);
  }
  // Flag values go into extensionsResult.runtime.flagValues AFTER the load and BEFORE the
  // session is created — the exact mechanism every SDK caller uses: the CLI's
  // applyExtensionFlagValues() (core/agent-session-services.js) and AgentSession's
  // options.flagValues handling (core/agent-session.js) both write into that same map, which
  // pi.getFlag() reads live (core/extensions/loader.js) and which createAgentSession and
  // ExtensionRunner keep by reference without resetting. Factory code has already run inside
  // reload() on a fresh runtime that no public API can pre-seed, so extensions are expected
  // to read flags lazily (e.g. in session_start) — see the bindExtensions() call below.
  const registered = new Set(result.extensions.flatMap(extension => [...extension.flags.keys()]));
  for (const [name, flag] of Object.entries(extensionFlags ?? {})) {
    result.runtime.flagValues.set(name, flag);
    if (!registered.has(name) && !warnedUnknownFlags.has(name)) {
      warnedUnknownFlags.add(name);
      console.error(`Extension flag "${name}" is registered by none of the configured extensions; it has no effect unless an extension reads it later.`);
    }
  }
  // Model visibility last: wrap so the generated tool descriptions ride along everywhere
  // the loader goes (session creation, later system-prompt rebuilds, session reloads).
  return describeExtensionTools(loader);
}

/**
 * Surface extensionFlags on process.argv as CLI-style tokens so FACTORY-time gates can
 * see them. The documented extension pattern reads a flag's runtime value and falls back
 * to scanning argv (`process.argv.slice(2).includes("--name")`) when the value is absent;
 * factory bodies run inside loader.reload() on a fresh runtime before any flagValues
 * injection can exist, and argv is the only channel they can read at that point. This
 * mirrors how CLI-launched pi passes extension flags. Guards:
 * - Tokens are pushed exactly once (factory re-creation must not duplicate them).
 * - A boolean false is skipped: argv can only express a flag's presence, never falseness,
 *   so false travels via the runtime flagValues injection only.
 * - main.ts parses its own arguments before createSessionFactory runs, so late tokens
 *   cannot affect command dispatch (--config, start/login/claim).
 */
function pushExtensionFlagArgv(
  extensions: readonly string[] | undefined,
  extensionFlags: Readonly<Record<string, boolean | string>> | undefined,
): void {
  if (!extensions?.length || !extensionFlags) return;
  for (const [name, value] of Object.entries(extensionFlags)) {
    if (value === false) continue;
    const token = value === true ? `--${name}` : `--${name}=${value}`;
    if (!process.argv.includes(token)) process.argv.push(token);
  }
}

export async function createSessionFactory(config: Config): Promise<SessionFactory> {
  // Before anything can load extensions: factory-time gates read argv during the first
  // loader.reload(), which happens inside the session factory closure below.
  pushExtensionFlagArgv(config.extensions, config.extensionFlags);
  const modelRuntime = await ModelRuntime.create();
  if (modelRuntime.getError()) throw new Error("Pi model configuration failed; check models.json and provider settings.");
  const available = await modelRuntime.getAvailable();
  const settings = SettingsManager.create(config.dataDir);
  const provider = config.model?.provider ?? settings.getDefaultProvider();
  const id = config.model?.id ?? settings.getDefaultModel();
  const model = provider && id
    ? available.find(model => model.provider === provider && model.id === id)
    : available[0];
  if (!model) throw new Error("No available configured Pi model. Run the local Pi CLI /login and /model as this service user, or supply provider API credentials. Check config.model provider/id.");

  return async (cwd, record, opts) => {
    const path = SessionManager.findById(cwd, record.sessionId);
    if (!path && record.started) throw new MissingMappedSessionError();
    const sessionManager = path
      ? SessionManager.open(path, undefined, cwd)
      : SessionManager.create(cwd, undefined, { id: record.sessionId });
    if (sessionManager.getSessionId() !== record.sessionId) throw new Error("Session identity mismatch");
    const settingsManager = SettingsManager.create(cwd, getAgentDir());
    // Extensions are OWNER-ONLY: the loader (with its tools, flags and prompt addendum) is
    // built solely for the owner's conversations. Everyone else gets no resourceLoader at
    // all — createAgentSession's own default loader, bit-identical to an unconfigured
    // deployment, so member sessions never register, activate or describe operator
    // extensions. `opts.owner` omitted or false is fail-closed.
    const owner = opts?.owner === true;
    const resourceLoader = owner
      ? await extensionResourceLoader(cwd, settingsManager, config.extensions, config.extensionFlags)
      : undefined;
    const { session } = await createAgentSession({
      cwd, model, modelRuntime, sessionManager, settingsManager,
      ...(resourceLoader ? { resourceLoader } : {}),
    });
    if (resourceLoader) {
      // Bring-up the CLI modes perform but createAgentSession does not (print/rpc/interactive
      // all call bindExtensions): it emits session_start, the point where lazily-registering
      // extensions — including flag-gated ones, since factories run before any flag value can
      // exist — register their tools. Without it such extensions silently register nothing.
      // A throwing handler is contained by ExtensionRunner.emit; onError reports it (without
      // a listener it vanishes into emitError with zero listeners). The unconfigured default
      // path stays untouched.
      await session.bindExtensions({
        mode: "print",
        onError: failure => console.error(`Extension failed in ${failure.event}; ${failure.extensionPath}: ${failure.error}`),
      });
    }
    // ResourceLoader.reload() discards pre-creation overrides: apply AFTER factory loading.
    // Native setting, without mutating the operator's global settings.
    settingsManager.applyOverrides({ compaction: { enabled: true } });
    if (!session.autoCompactionEnabled) {
      session.dispose();
      throw new Error("Pi auto-compaction must be enabled");
    }
    return wrapSession(session);
  };
}
