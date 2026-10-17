import {
  createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { Config } from "./config.js";
import { AssistantResponseError, MissingMappedSessionError } from "./diagnostics.js";
import type { BridgeSession, SessionFactory, SessionIntrospection } from "./pi-agent.js";

/** Only completed assistant events from THIS prompt may become a WeChat reply. */
export function wrapSession(session: AgentSession): BridgeSession {
  return {
    get isIdle() { return session.isIdle; },
    async run(text) {
      if (!session.isIdle) throw new Error("Session is busy");
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
      } finally { unsubscribe(); }
    },
    abort: () => session.abort(),
    compact: instructions => session.compact(instructions),
    introspect: (): SessionIntrospection => ({
      model: session.model ? { provider: session.model.provider, id: session.model.id, contextWindow: session.model.contextWindow } : undefined,
      thinkingLevel: session.thinkingLevel,
      isIdle: session.isIdle,
      stats: session.getSessionStats(),
      contextUsage: session.getContextUsage(),
    }),
    dispose: () => session.dispose(),
  };
}

/** Unknown flag names already warned about in this process: one warning per name, not per session. */
const warnedUnknownFlags = new Set<string>();

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
): Promise<DefaultResourceLoader | undefined> {
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
  return loader;
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

  return async (cwd, record) => {
    const path = SessionManager.findById(cwd, record.sessionId);
    if (!path && record.started) throw new MissingMappedSessionError();
    const sessionManager = path
      ? SessionManager.open(path, undefined, cwd)
      : SessionManager.create(cwd, undefined, { id: record.sessionId });
    if (sessionManager.getSessionId() !== record.sessionId) throw new Error("Session identity mismatch");
    const settingsManager = SettingsManager.create(cwd, getAgentDir());
    // Only pass a resourceLoader when extensions are configured; otherwise omit the
    // option entirely so session creation is bit-identical to the pre-extension bridge.
    const resourceLoader = await extensionResourceLoader(cwd, settingsManager, config.extensions, config.extensionFlags);
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
