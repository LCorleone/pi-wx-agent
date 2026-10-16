import {
  createAgentSession, getAgentDir, ModelRuntime, SessionManager, SettingsManager,
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

export async function createSessionFactory(config: Config): Promise<SessionFactory> {
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
    const { session } = await createAgentSession({ cwd, model, modelRuntime, sessionManager, settingsManager });
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
