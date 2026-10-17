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

test("wrapSession external-reply hook: only completed assistant turns outside run()/compact() fire it", async () => {
  // Real dispatcher semantics: every live subscription receives every event (a run's
  // own subscription coexists with the lifetime one; unsubscribing removes just itself).
  const listeners = new Set();
  const emit = event => { for (const fn of [...listeners]) fn(event); };
  const fake = {
    isIdle: true,
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    async prompt() {
      // An external turn finishing while the bridge run is still in flight.
      emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "mid-run external" }] } });
      await gated;
      emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "run reply" }] } });
    },
    async abort() {},
    async compact() {
      emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "compaction emission" }] } });
      return { summary: "s", firstKeptEntryId: "x", tokensBefore: 10, estimatedTokensAfter: 5 };
    },
    dispose() {},
  };
  let release;
  const gated = new Promise(done => { release = done; });
  const wrapped = wrapSession(fake);
  const fired = [];
  wrapped.setExternalReplyHook(text => fired.push(text));
  // Non-completed segments, other roles and non-stop reasons never fire the hook.
  emit({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "tool segment" }] } });
  emit({ type: "message_end", message: { role: "assistant", stopReason: "error", content: [] } });
  emit({ type: "message_end", message: { role: "user", stopReason: "stop", content: [{ type: "text", text: "user echo" }] } });
  assert.deepEqual(fired, []);
  // An idle completed external turn fires once, with text blocks joined.
  emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "part one" }, { type: "text", text: "part two" }] } });
  assert.deepEqual(fired, ["part one\npart two"]);
  // A bridge run: the mid-run event is suppressed synchronously (busy flag), the run's
  // own reply never reaches the hook either.
  const run = wrapped.run("input");
  assert.deepEqual(fired, ["part one\npart two"], "message_end landing mid-run must not push");
  release();
  assert.equal(await run, "run reply");
  assert.deepEqual(fired, ["part one\npart two"], "the bridge's own reply must not push");
  // Compaction emissions are suppressed for the whole compact() window.
  await wrapped.compact();
  assert.deepEqual(fired, ["part one\npart two"], "compaction must not push");
  // Back to idle: external turns fire again.
  emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "after compact" }] } });
  assert.deepEqual(fired, ["part one\npart two", "after compact"]);
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
    const session = await factory(cwd, { sessionId: randomUUID(), started: false, activity: 0, reflectedActivity: 0, pendingSince: Date.now(), lastDreamSuccess: 0 }, { owner: true });
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
    const offSession = await off(join(root, "flag-off-ws"), record(), { owner: true });
    assert.ok(!existsSync(marker), "without extensionFlags the gated extension must register nothing");
    offSession.dispose();
    const on = await createSessionFactory({ ...base, extensions: [stub], extensionFlags: { "feature-gate": true } });
    const onSession = await on(join(root, "flag-on-ws"), record(), { owner: true });
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
    const offSession = await off(join(root, "argv-off-ws"), record(), { owner: true });
    assert.ok(!existsSync(marker), "without extensionFlags the factory gate must stay closed");
    offSession.dispose();
    // With flags: tokens are pushed before the first loader.reload() can run, in CLI style.
    const on = await createSessionFactory({ ...base, extensions: [stub],
      extensionFlags: { "factory-gate": true, "text-flag": "value", "off-flag": false } });
    assert.ok(process.argv.slice(2).includes("--factory-gate"), "boolean true pushes --name");
    assert.ok(process.argv.slice(2).includes("--text-flag=value"), "string pushes --name=value");
    assert.ok(!process.argv.some(token => token.startsWith("--off-flag")), "boolean false pushes nothing");
    const onSession = await on(join(root, "argv-on-ws"), record(), { owner: true });
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
      session = await factory(join(root, "throw-ws"), { sessionId: randomUUID(), started: false, activity: 0, reflectedActivity: 0, pendingSince: Date.now(), lastDreamSuccess: 0 }, { owner: true });
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

test("extension tools are model-visible: active, and described in the system prompt", async () => {
  // The previous tests removed the shared offline roots; rebuild them for this test.
  mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify({ providers: { "offline-test": {
    baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "not-a-real-key",
    models: [{ id: "test-model", contextWindow: 64000, maxTokens: 4096 }],
  } } }));
  // Load-time stub WITHOUT promptSnippet — the live failure shape: pi activates such tools,
  // but the prompt's Available-tools section lists only snippet-carrying tools.
  const quiet = join(root, "quiet-stub.js");
  writeFileSync(quiet, `export default (pi) => {
  pi.registerTool({
    name: "quiet_tool", label: "Quiet", description: "offline undescribed tool",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() { return { output: "ok" }; },
  });
};
`);
  // Late stub: registers its tool in session_start, also without a snippet.
  const late = join(root, "late-stub.js");
  writeFileSync(late, `export default (pi) => {
  pi.on("session_start", () => {
    pi.registerTool({
      name: "late_tool", label: "Late", description: "offline late tool",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute() { return { output: "ok" }; },
    });
  });
};
`);
  try {
    const base = { dataDir: root, model: { provider: "offline-test", id: "test-model" }, dream: { enabled: false, hour: 3 } };
    const id = randomUUID();
    const record = started => ({ sessionId: id, started, activity: 0, reflectedActivity: 0, pendingSince: Date.now(), lastDreamSuccess: 0 });
    // Through the REAL bridge factory: the tool is in the model-declared active set and the
    // built-ins stay active.
    // Seed the session file first: pi persists sessions on prompt, and the offline model
    // never prompts, so the resume path needs an existing JSONL (same pattern as the
    // identity-restore test above).
    const cwd = join(root, "vis-ws");
    SessionManager.create(cwd, undefined, { id }).appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
    const factory = await createSessionFactory({ ...base, extensions: [quiet] });
    const session = await factory(cwd, record(false), { owner: true });
    const view = session.introspect();
    assert.ok(view.activeTools.includes("quiet_tool"), "the extension tool must be in the active set");
    for (const builtin of ["read", "bash", "edit", "write"]) {
      assert.ok(view.activeTools.includes(builtin), `builtin ${builtin} must stay active`);
    }
    session.dispose();
    // A resumed session (same identity, started) sees the tool too.
    const resumed = await factory(cwd, record(true), { owner: true });
    assert.ok(resumed.introspect().activeTools.includes("quiet_tool"), "a resumed session must keep the tool active");
    resumed.dispose();
    // The live bug itself: the system prompt must DESCRIBE the tools. The loader appends a
    // generated section; it is re-read at every prompt rebuild, so the late tool appears
    // once session_start has registered it.
    const seamCwd = join(root, "vis-seam-ws");
    const settings = SettingsManager.create(seamCwd, process.env.PI_CODING_AGENT_DIR);
    const loader = await extensionResourceLoader(seamCwd, settings, [quiet, late], undefined);
    assert.ok(loader.getAppendSystemPrompt().some(part => part.includes("quiet_tool") && part.includes("offline undescribed tool")),
      "the loader must append a description section");
    const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
    const { session: direct } = await createAgentSession({
      cwd: seamCwd, model: modelRuntime.getModel("offline-test", "test-model"), modelRuntime,
      settingsManager: settings, resourceLoader: loader,
      sessionManager: SessionManager.create(seamCwd, undefined, { id: randomUUID() }),
    });
    assert.ok(direct.systemPrompt.includes("quiet_tool"), "the prompt must describe the load-time tool");
    assert.ok(!direct.systemPrompt.includes("late_tool"), "the late tool is not described before bring-up");
    await direct.bindExtensions({ mode: "print" });
    assert.ok(direct.systemPrompt.includes("late_tool"), "the prompt must describe the late tool after bring-up");
    assert.ok(direct.getActiveToolNames().includes("late_tool"));
    direct.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("extensions are owner-only: member sessions never load them", async () => {
  // The previous tests removed the shared offline roots; rebuild them for this test.
  mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify({ providers: { "offline-test": {
    baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "not-a-real-key",
    models: [{ id: "test-model", contextWindow: 64000, maxTokens: 4096 }],
  } } }));
  // The stub leaves a trace the moment its module loads, and registers a snippet-less tool.
  const marker = join(root, "owner-gate.marker");
  const stub = join(root, "owner-only-stub.js");
  writeFileSync(stub, `import { writeFileSync } from "node:fs";
export default (pi) => {
  writeFileSync(${JSON.stringify(marker)}, "loaded");
  pi.registerTool({
    name: "owner_only_tool", label: "Owner only", description: "offline owner-only tool",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() { return { output: "ok" }; },
  });
};
`);
  try {
    const base = { dataDir: root, model: { provider: "offline-test", id: "test-model" }, dream: { enabled: false, hour: 3 } };
    const record = started => ({ sessionId: randomUUID(), started, activity: 0, reflectedActivity: 0, pendingSince: Date.now(), lastDreamSuccess: 0 });
    const factory = await createSessionFactory({ ...base, extensions: [stub] });
    // Owner session: the module loads and the tool is active and described.
    const ownerSession = await factory(join(root, "owner-ws"), record(false), { owner: true });
    assert.ok(existsSync(marker), "the extension must load for the owner");
    assert.ok(ownerSession.introspect().activeTools.includes("owner_only_tool"), "owner sees the tool");
    for (const builtin of ["read", "bash", "edit", "write"]) {
      assert.ok(ownerSession.introspect().activeTools.includes(builtin), `builtin ${builtin} stays active`);
    }
    ownerSession.dispose();
    // Member session: the extension module never even loads — nothing registers, activates
    // or describes it. The marker doubles as the "not described" proof: with no loader built,
    // the addendum cannot exist.
    rmSync(marker, { force: true });
    const memberSession = await factory(join(root, "member-ws"), record(false), { owner: false });
    assert.ok(!existsSync(marker), "member sessions must not load the extension at all");
    assert.ok(!memberSession.introspect().activeTools.includes("owner_only_tool"), "member must not see the tool");
    memberSession.dispose();
    // Fail-closed pin: dropping the owner flag must lose the tools (mutation guard).
    rmSync(marker, { force: true });
    const omitted = await factory(join(root, "omitted-ws"), record(false));
    assert.ok(!existsSync(marker), "an omitted owner flag must behave like a member session");
    assert.ok(!omitted.introspect().activeTools.includes("owner_only_tool"));
    omitted.dispose();
    // Member resume: a pre-existing member session stays extension-free.
    const memberResumeId = randomUUID();
    const memberResumeCwd = join(root, "member-resume-ws");
    SessionManager.create(memberResumeCwd, undefined, { id: memberResumeId })
      .appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
    const memberResumed = await factory(memberResumeCwd, { ...record(true), sessionId: memberResumeId }, { owner: false });
    assert.ok(!memberResumed.introspect().activeTools.includes("owner_only_tool"), "resumed member session stays extension-free");
    assert.ok(!existsSync(marker), "member resume must not load the extension");
    memberResumed.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
