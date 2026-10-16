import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

// Set private, empty test roots BEFORE importing the SDK. Never read operator credentials.
const root = mkdtempSync(join(tmpdir(), "pi-wx-sdk-"));
// Drop ambient API/cloud credentials too; model availability checks must be offline test-only.
process.env = { PATH: process.env.PATH, NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT, HOME: root, PI_CODING_AGENT_DIR: join(root, "agent") };
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
const { wrapSession, createSessionFactory } = await import("../dist/pi-session.js");
const { SessionManager, SettingsManager, createAgentSession, ModelRuntime } = await import("@earendil-works/pi-coding-agent");

test("reply wrapper rejects old text, handled prompts, error/abort/length; uses fresh final text", async () => {
  let listener;
  let mode = "none";
  let unsubscribed = 0;
  const fake = {
    isIdle: true,
    getLastAssistantText: () => "STALE DREAM TEXT",
    subscribe(fn) { listener = fn; return () => { unsubscribed++; }; },
    async prompt() {
      if (mode !== "none") listener({ type: "message_end", message: { role: "assistant", stopReason: mode, content: [{ type: "text", text: "fresh" }] } });
    },
    async abort() {}, dispose() {},
  };
  const wrapped = wrapSession(fake);
  for (mode of ["none", "error", "aborted", "length", "toolUse"]) {
    await assert.rejects(wrapped.run("input"), error => {
      assert.match(error.message, /fresh successful/);
      assert.equal(error.stopReason, mode);
      return true;
    });
  }
  mode = "stop";
  assert.equal(await wrapped.run("input"), "fresh");
  assert.equal(unsubscribed, 6);
  fake.isIdle = false;
  await assert.rejects(wrapped.run("input"), /busy/);
});

test("installed Pi API: exact JSONL identity, lazy intent recovery, native compaction and AGENTS injection (no model calls)", async () => {
  try {
    const cwd = join(root, "workspace");
    mkdirSync(cwd);
    writeFileSync(join(cwd, "AGENTS.md"), "Read MEMORY.md before answering. Test-only public instructions.");
    writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify({ providers: { "offline-test": {
      baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "not-a-real-key",
      models: [{ id: "test-model", contextWindow: 64000, maxTokens: 4096 }],
    } } }));
    const id = randomUUID();
    const manager = SessionManager.create(cwd, undefined, { id });
    assert.equal(SessionManager.findById(cwd, id), undefined);
    manager.appendMessage({ role: "user", content: "persist without calling any model", timestamp: Date.now() });
    const path = SessionManager.findById(cwd, id);
    assert.ok(path.startsWith(join(root, "agent", "sessions")));
    assert.equal(SessionManager.open(path).getSessionId(), id);
    assert.equal(SessionManager.open(path).buildSessionContext().messages.at(-1).content, "persist without calling any model");
    assert.match(readFileSync(path, "utf8"), /persist without/);

    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
    const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
    const model = modelRuntime.getModel("offline-test", "test-model");
    const { session } = await createAgentSession({ cwd, settingsManager, modelRuntime, model, sessionManager: SessionManager.open(path) });
    assert.equal(session.autoCompactionEnabled, false); // SDK loader resets pre-creation overrides.
    settingsManager.applyOverrides({ compaction: { enabled: true } });
    assert.equal(session.autoCompactionEnabled, true);
    assert.match(session.systemPrompt, /Read MEMORY.md before answering/);
    assert.equal(session.sessionId, id);
    session.dispose();

    // Factory must force native compaction even when the dedicated user's default disables it.
    writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "settings.json"), JSON.stringify({ compaction: { enabled: false } }));
    const factory = await createSessionFactory({ dataDir: root, model: { provider: "offline-test", id: "test-model" }, dream: { enabled: false, hour: 3 } });
    const record = { sessionId: id, started: true, activity: 1, reflectedActivity: 0, pendingSince: Date.now(), lastDreamSuccess: 0 };
    const restored = await factory(cwd, record);
    assert.equal(restored.isIdle, true);
    restored.dispose();
    await assert.rejects(factory(cwd, { ...record, sessionId: randomUUID() }), /Mapped Pi session is missing/);
    const lazy = await factory(cwd, { ...record, sessionId: randomUUID(), started: false });
    lazy.dispose();
    await assert.rejects(createSessionFactory({ dataDir: root, model: { provider: "offline-test", id: "missing" }, dream: { enabled: false, hour: 3 } }), /No available configured Pi model/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
