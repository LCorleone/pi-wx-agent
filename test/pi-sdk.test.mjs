import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

// Set private, empty test roots BEFORE importing the SDK. Never read operator credentials.
const root = mkdtempSync(join(tmpdir(), "pi-wx-sdk-"));
// Drop ambient API/cloud credentials too; model availability checks must be offline test-only.
process.env = { PATH: process.env.PATH, NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT, HOME: root, PI_CODING_AGENT_DIR: join(root, "agent") };
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
const { wrapSession, createSessionFactory, extensionResourceLoader } = await import("../dist/pi-session.js");
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

test("extensions: exactly the listed files load, global discovery stays off; unconfigured adds no loader", async () => {
  // The previous test removed the shared offline roots; rebuild them for this test.
  mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify({ providers: { "offline-test": {
    baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "not-a-real-key",
    models: [{ id: "test-model", contextWindow: 64000, maxTokens: 4096 }],
  } } }));
  // Self-authored offline stubs only: a configured extension file plus one that would be
  // picked up by scanning the agent directory (the operator's global extension dir).
  const configured = join(root, "configured-stub.js");
  writeFileSync(configured, `export default (pi) => {
  pi.registerTool({
    name: "configured_stub", label: "Configured stub", description: "offline test stub tool",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() { return { output: "stub" }; },
  });
};
`);
  const ambientDir = join(process.env.PI_CODING_AGENT_DIR, "extensions");
  mkdirSync(ambientDir, { recursive: true });
  writeFileSync(join(ambientDir, "ambient-stub.js"), `export default (pi) => {
  pi.registerTool({
    name: "ambient_stub", label: "Ambient stub", description: "tool found by directory scanning",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() { return { output: "stub" }; },
  });
};
`);
  try {
    const cwd = join(root, "ext-workspace");
    mkdirSync(cwd);
    const settings = SettingsManager.create(cwd, process.env.PI_CODING_AGENT_DIR);
    // Unconfigured (absent or empty): no resourceLoader at all, so createAgentSession
    // builds its own default exactly as before the extensions option existed.
    assert.equal(await extensionResourceLoader(cwd, settings, undefined), undefined);
    assert.equal(await extensionResourceLoader(cwd, settings, []), undefined);
    // Configured: the listed file loads; agentDir/extensions scanning is suppressed.
    const loader = await extensionResourceLoader(cwd, settings, [configured]);
    const result = loader.getExtensions();
    assert.deepEqual(result.errors, []);
    const tools = result.extensions.flatMap(extension => [...extension.tools.keys()]);
    assert.ok(tools.includes("configured_stub"), `configured stub must load, got ${tools.join(",")}`);
    assert.ok(!tools.includes("ambient_stub"), "noExtensions:true must suppress agentDir extension scanning");
    // End to end through the bridge session factory: creation still works offline.
    const factory = await createSessionFactory({
      dataDir: root, model: { provider: "offline-test", id: "test-model" },
      dream: { enabled: false, hour: 3 }, extensions: [configured],
    });
    const session = await factory(cwd, { sessionId: randomUUID(), started: false, activity: 0, reflectedActivity: 0, pendingSince: Date.now(), lastDreamSuccess: 0 });
    assert.equal(session.isIdle, true);
    session.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("extensionFlags: a flag-gated extension activates only when flags are configured", async () => {
  const originalArgv = process.argv.slice(); // createSessionFactory appends flag tokens to argv
  // The previous tests removed the shared offline roots; rebuild them for this test.
  mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify({ providers: { "offline-test": {
    baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "not-a-real-key",
    models: [{ id: "test-model", contextWindow: 64000, maxTokens: 4096 }],
  } } }));
  // Realistic flag-gated stub: it registers the flag at load, but registers its tool only
  // when the flag reads true — lazily, in session_start, because extension factories run
  // during loader.reload() before any flag value can exist (verified in the installed SDK:
  // the CLI itself injects flags only after load, via applyExtensionFlagValues).
  const marker = join(root, "flag-gate.marker");
  const stub = join(root, "flag-gated-stub.js");
  writeFileSync(stub, `import { writeFileSync } from "node:fs";
export default (pi) => {
  pi.registerFlag("feature-gate", { type: "boolean", default: false, description: "offline test gate" });
  pi.on("session_start", () => {
    if (pi.getFlag("feature-gate") === true) {
      pi.registerTool({
        name: "gated_tool", label: "Gated", description: "offline gated tool",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        async execute() { return { output: "ok" }; },
      });
      writeFileSync(${JSON.stringify(marker)}, "registered");
    }
  });
};
`);
  try {
    const settings = SettingsManager.create(join(root, "flag-seam-ws"), process.env.PI_CODING_AGENT_DIR);
    // Loader seam: flags land in the runtime map pi.getFlag() reads; unknown names warn once.
    const flagged = await extensionResourceLoader(join(root, "flag-seam-ws"), settings, [stub], { "feature-gate": true });
    assert.equal(flagged.getExtensions().runtime.flagValues.get("feature-gate"), true);
    const warnings = [];
    const originalError = console.error;
    console.error = line => warnings.push(line);
    try {
      const warned = await extensionResourceLoader(join(root, "flag-seam-ws"), settings, [stub], { "not-registered": true });
      assert.equal(warned.getExtensions().runtime.flagValues.get("not-registered"), true);
    } finally { console.error = originalError; }
    assert.equal(warnings.filter(line => line.includes("not-registered")).length, 1);
    // Once per process, not once per loader: a second creation must not warn again.
    const repeated = [];
    console.error = line => repeated.push(line);
    try {
      await extensionResourceLoader(join(root, "flag-seam-ws"), settings, [stub], { "not-registered": true });
    } finally { console.error = originalError; }
    assert.equal(repeated.filter(line => line.includes("not-registered")).length, 0);

    // End to end through the bridge factory: without flags the extension registers nothing
    // (the live failure mode); with extensionFlags it activates during session bring-up.
    const base = { dataDir: root, model: { provider: "offline-test", id: "test-model" }, dream: { enabled: false, hour: 3 } };
    const record = () => ({ sessionId: randomUUID(), started: false, activity: 0, reflectedActivity: 0, pendingSince: Date.now(), lastDreamSuccess: 0 });
    const off = await createSessionFactory({ ...base, extensions: [stub] });
    const offSession = await off(join(root, "flag-off-ws"), record());
    assert.ok(!existsSync(marker), "without extensionFlags the gated extension must register nothing");
    offSession.dispose();
    const on = await createSessionFactory({ ...base, extensions: [stub], extensionFlags: { "feature-gate": true } });
    const onSession = await on(join(root, "flag-on-ws"), record());
    assert.ok(existsSync(marker), "extensionFlags must let the gated extension register its tool");
    onSession.dispose();
  } finally {
    process.argv = originalArgv;
    rmSync(root, { recursive: true, force: true });
  }
});

test("extensionFlags argv supplement: factory-time gates see CLI-style flag tokens", async () => {
  const originalArgv = process.argv.slice();
  // The previous tests removed the shared offline roots; rebuild them for this test.
  mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify({ providers: { "offline-test": {
    baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "not-a-real-key",
    models: [{ id: "test-model", contextWindow: 64000, maxTokens: 4096 }],
  } } }));
  // Mirrors the documented factory-gate pattern: the default-export body checks the flag
  // value AND falls back to scanning process.argv, all during loader.reload() — before any
  // runtime flagValues injection can exist. Only the argv channel can open this gate.
  const marker = join(root, "factory-gate.marker");
  const stub = join(root, "factory-gated-stub.js");
  writeFileSync(stub, `import { writeFileSync } from "node:fs";
export default (pi) => {
  pi.registerFlag("factory-gate", { type: "boolean", default: false, description: "offline test gate" });
  if (pi.getFlag("factory-gate") === true || process.argv.slice(2).includes("--factory-gate")) {
    pi.registerTool({
      name: "factory_gated_tool", label: "Factory gated", description: "offline factory-gated tool",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute() { return { output: "ok" }; },
    });
    writeFileSync(${JSON.stringify(marker)}, "registered");
  }
};
`);
  try {
    // Realistic bridge argv shape (node dist/main.js start); slice(2) keeps later tokens.
    process.argv = [originalArgv[0], "dist/main.js", "start"];
    const base = { dataDir: root, model: { provider: "offline-test", id: "test-model" }, dream: { enabled: false, hour: 3 } };
    const record = () => ({ sessionId: randomUUID(), started: false, activity: 0, reflectedActivity: 0, pendingSince: Date.now(), lastDreamSuccess: 0 });
    // Without extensionFlags: no token is pushed, the factory gate stays closed.
    const off = await createSessionFactory({ ...base, extensions: [stub] });
    const offSession = await off(join(root, "argv-off-ws"), record());
    assert.ok(!existsSync(marker), "without extensionFlags the factory gate must stay closed");
    offSession.dispose();
    // With flags: tokens are pushed before the first loader.reload() can run, in CLI style.
    const on = await createSessionFactory({ ...base, extensions: [stub],
      extensionFlags: { "factory-gate": true, "text-flag": "value", "off-flag": false } });
    assert.ok(process.argv.slice(2).includes("--factory-gate"), "boolean true pushes --name");
    assert.ok(process.argv.slice(2).includes("--text-flag=value"), "string pushes --name=value");
    assert.ok(!process.argv.some(token => token.startsWith("--off-flag")), "boolean false pushes nothing");
    const onSession = await on(join(root, "argv-on-ws"), record());
    assert.ok(existsSync(marker), "the factory-time gate must see the CLI-style flag token");
    onSession.dispose();
    // Double-push guard: recreating the factory must not duplicate tokens.
    await createSessionFactory({ ...base, extensions: [stub], extensionFlags: { "factory-gate": true } });
    assert.equal(process.argv.filter(token => token === "--factory-gate").length, 1);
  } finally {
    process.argv = originalArgv;
    rmSync(root, { recursive: true, force: true });
  }
});

test("extension failures are reported, not swallowed: load errors and throwing handlers", async () => {
  // The previous tests removed the shared offline roots; rebuild them for this test.
  mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify({ providers: { "offline-test": {
    baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "not-a-real-key",
    models: [{ id: "test-model", contextWindow: 64000, maxTokens: 4096 }],
  } } }));
  // One stub that fails to import (syntax error) and one whose session_start handler throws.
  const broken = join(root, "broken-stub.js");
  writeFileSync(broken, "export default (pi) => { this is not valid javascript (; }\n");
  const throwing = join(root, "throwing-stub.js");
  const marker = join(root, "throwing-ran.marker");
  writeFileSync(throwing, `import { writeFileSync } from "node:fs";
export default (pi) => {
  pi.on("session_start", () => {
    writeFileSync(${JSON.stringify(marker)}, "ran");
    throw new Error("offline handler failure");
  });
};
`);
  try {
    const settings = SettingsManager.create(join(root, "fail-seam-ws"), process.env.PI_CODING_AGENT_DIR);
    // Load failure: reported per failing path, and the loader result still carries the error.
    const loadLines = [];
    const originalError = console.error;
    console.error = line => loadLines.push(line);
    let loader;
    try { loader = await extensionResourceLoader(join(root, "fail-seam-ws"), settings, [broken], undefined); }
    finally { console.error = originalError; }
    assert.ok(loader.getExtensions().errors.length >= 1, "the loader result carries the failure");
    assert.ok(loadLines.some(line => line.includes("Extension failed to load") && line.includes(broken)),
      "the load failure must be logged naming the path");

    // Handler failure: contained (session creation succeeds) and reported via onError.
    const base = { dataDir: root, model: { provider: "offline-test", id: "test-model" }, dream: { enabled: false, hour: 3 } };
    const factory = await createSessionFactory({ ...base, extensions: [throwing] });
    const handlerLines = [];
    console.error = line => handlerLines.push(line);
    let session;
    try {
      session = await factory(join(root, "throw-ws"), { sessionId: randomUUID(), started: false, activity: 0, reflectedActivity: 0, pendingSince: Date.now(), lastDreamSuccess: 0 });
    } finally { console.error = originalError; }
    assert.ok(existsSync(marker), "the session_start handler ran");
    assert.equal(session.isIdle, true, "a throwing handler must not fail session creation");
    assert.ok(handlerLines.some(line => line.includes("session_start") && line.includes(throwing) && line.includes("offline handler failure")),
      "the handler failure must be logged naming the path and event");
    session.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
