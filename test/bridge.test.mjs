import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PiAgent, dreamDueAt, DREAM_PROMPT, MEMORY_INSTRUCTIONS } from "../dist/pi-agent.js";
import { hash } from "../dist/state.js";
import { loadConfig } from "../dist/config.js";
import { AssistantResponseError, MissingMappedSessionError } from "../dist/diagnostics.js";

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(t, hour = 3) {
  const dataDir = mkdtempSync(join(tmpdir(), "pi-wx-test-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const config = { dataDir, model: null, dream: { enabled: true, hour } };
  let now = new Date(2026, 9, 15, 23, 30).getTime();
  const sessions = [];
  const logs = [];
  const factory = async (cwd, record) => {
    const session = {
      cwd, id: record.sessionId, isIdle: true, calls: [], disposed: false,
      gate: undefined, started: deferred(), fail: false,
      async run(text) {
        assert.equal(this.isIdle, true, "no overlapping prompts");
        this.isIdle = false;
        this.calls.push(text);
        this.started.resolve();
        try {
          if (this.gate) await this.gate.promise;
          if (this.fail) throw new Error("fake failure");
          return `reply:${text}`;
        } finally { this.isIdle = true; }
      },
      async abort() { this.gate?.resolve(); },
      dispose() { this.disposed = true; },
    };
    sessions.push(session);
    return session;
  };
  const make = () => new PiAgent(config, factory, () => now, line => logs.push(line));
  const claim = async (agent, owner = "owner") => {
    const code = agent.issueClaim();
    assert.match((await agent.chat({ conversationId: owner, text: code })).text, /认领成功/);
  };
  const state = () => JSON.parse(readFileSync(join(dataDir, "state.json"), "utf8"));
  return { dataDir, config, make, sessions, claim, state, logs, setNow: value => { now = value; }, get now() { return now; } };
}
const message = (text, conversationId = "owner") => ({ conversationId, text });

test("claim is fail-closed, single-use, durable, and unauthorized clear never creates Pi", async t => {
  const f = fixture(t);
  let agent = f.make();
  assert.equal((await agent.chat(message("hello", "stranger"))).text, "未授权");
  assert.throws(() => agent.clearSession("stranger"), /未授权/);
  const code = agent.issueClaim();
  assert.equal((await agent.chat(message(code, ""))).text, "未授权");
  await agent.close();
  agent = f.make();
  assert.match((await agent.chat(message(code))).text, /认领成功/);
  assert.throws(() => agent.issueClaim(), /already claimed/);
  assert.equal((await agent.chat(message(code, "stranger"))).text, "未授权");
  assert.throws(() => agent.clearSession("stranger"), /未授权/);
  assert.equal(f.sessions.length, 0);
  await agent.close();
  agent = f.make();
  assert.equal((await agent.chat(message("hello", "stranger"))).text, "未授权");
  assert.equal((await agent.chat(message("hello"))).text, "reply:hello");
  assert.equal(f.sessions.length, 1);
  assert.ok(f.logs.includes("Denied unauthorized chat."));
  await agent.close();
});

test("claim expiry and global five-attempt budget survive restart; rotation is explicit", async t => {
  const f = fixture(t);
  let agent = f.make();
  let code = agent.issueClaim();
  for (let n = 0; n < 4; n++) assert.equal((await agent.chat(message("bad", `attacker-${n}`))).text, "未授权");
  await agent.close();
  agent = f.make();
  await agent.chat(message("bad", "other"));
  assert.equal((await agent.chat(message(code))).text, "未授权");
  assert.equal(f.state().claim.attempts, 5);
  code = agent.issueClaim();
  f.setNow(f.now + 600_000);
  assert.equal((await agent.chat(message(code))).text, "未授权");
  code = agent.issueClaim();
  assert.match((await agent.chat(message(code))).text, /认领成功/);
  assert.equal(f.sessions.length, 0);
  await agent.close();
});

test("corrupt authorization state is not silently replaced", t => {
  const f = fixture(t);
  writeFileSync(join(f.dataDir, "state.json"), '{"version":1,"owner":[]}');
  assert.throws(f.make, /Invalid state/);
  writeFileSync(join(f.dataDir, "state.json"), "broken JSON");
  assert.throws(f.make);
});

test("safe hashed paths, exact identity restore, durable clear and retained memory", async t => {
  const f = fixture(t);
  const owner = "../../outside/\\__proto__";
  let agent = f.make();
  await f.claim(agent, owner);
  await agent.chat(message("one", owner));
  const first = f.sessions[0];
  assert.equal(first.cwd, join(f.dataDir, "conversations", hash(owner)));
  assert.equal(readFileSync(join(first.cwd, "AGENTS.md"), "utf8"), MEMORY_INSTRUCTIONS);
  writeFileSync(join(first.cwd, "MEMORY.md"), "A remembered preference");
  await agent.close();
  agent = f.make();
  await agent.chat(message("two", owner));
  assert.equal(f.sessions[1].id, first.id);
  agent.clearSession(owner);
  await agent.drain();
  assert.equal(f.sessions[1].disposed, true);
  await agent.close();
  agent = f.make();
  await agent.chat(message("three", owner));
  assert.notEqual(f.sessions[2].id, first.id);
  assert.equal(readFileSync(join(first.cwd, "MEMORY.md"), "utf8"), "A remembered preference");
  await agent.close();
});

test("first session intent is durable even when its first prompt fails", async t => {
  const f = fixture(t);
  let agent = f.make();
  await f.claim(agent);
  // Install a fake that verifies the map exists before model execution.
  const originalFactory = agent.createSession;
  agent.createSession = async (cwd, record) => {
    assert.equal(f.state().conversations[hash("owner")].sessionId, record.sessionId);
    const session = await originalFactory(cwd, record);
    session.fail = true;
    return session;
  };
  assert.match((await agent.chat(message("first"))).text, /处理失败/);
  const id = f.sessions[0].id;
  await agent.close();
  agent = f.make();
  await agent.chat(message("retry"));
  assert.equal(f.sessions[1].id, id);
  await agent.close();
});

test("concurrent chat is FIFO with its own reply; clear suppresses stale queued/running replies", async t => {
  const f = fixture(t);
  const agent = f.make();
  await f.claim(agent);
  await agent.chat(message("warmup"));
  const session = f.sessions[0];
  session.gate = deferred();
  session.started = deferred();
  const first = agent.chat(message("first"));
  await session.started.promise;
  const second = agent.chat(message("second"));
  assert.deepEqual(session.calls, ["warmup", "first"]);
  session.gate.resolve();
  assert.equal((await first).text, "reply:first");
  assert.equal((await second).text, "reply:second");
  session.gate = deferred();
  session.started = deferred();
  const old = agent.chat(message("old"));
  await session.started.promise;
  const queued = agent.chat(message("queued-old"));
  agent.clearSession("owner");
  const fresh = agent.chat(message("new"));
  session.gate.resolve();
  assert.deepEqual(await old, {});
  assert.deepEqual(await queued, {});
  assert.equal((await fresh).text, "reply:new");
  assert.equal(session.disposed, true);
  assert.notEqual(f.sessions[1].id, session.id);
  await agent.close();
});

test("midnight dream uses awaited execution, discards reply and persists success across restart", async t => {
  const f = fixture(t);
  let agent = f.make();
  await f.claim(agent);
  await agent.chat(message("yesterday's facts"));
  f.setNow(new Date(2026, 9, 16, 3, 1).getTime());
  const session = f.sessions[0];
  session.gate = deferred();
  session.started = deferred();
  const dream = agent.dream();
  await session.started.promise;
  assert.equal(session.calls.at(-1), DREAM_PROMPT);
  assert.equal(f.state().conversations[hash("owner")].lastDreamSuccess, 0);
  const chat = agent.chat(message("morning"));
  assert.equal(session.calls.at(-1), DREAM_PROMPT);
  session.gate.resolve();
  assert.equal(await dream, undefined);
  assert.equal((await chat).text, "reply:morning");
  assert.equal(f.state().conversations[hash("owner")].lastDreamSuccess, f.now);
  await agent.close();
  agent = f.make();
  await agent.dream(); // Morning activity waits until next night, not every timer tick.
  assert.equal(f.sessions.length, 1);
  f.setNow(new Date(2026, 9, 17, 4).getTime());
  await agent.dream();
  assert.deepEqual(f.sessions[1].calls, [DREAM_PROMPT]);
  await agent.close();
  agent = f.make();
  await agent.dream();
  assert.equal(f.sessions.length, 2);
  await agent.close();
});

test("busy or failed dream remains due and retries, including after downtime", async t => {
  const f = fixture(t);
  let agent = f.make();
  await f.claim(agent);
  await agent.chat(message("facts"));
  f.setNow(new Date(2026, 9, 16, 4).getTime());
  const session = f.sessions[0];
  session.isIdle = false;
  await agent.dream();
  assert.equal(session.calls.length, 1);
  session.isIdle = true;
  session.fail = true;
  await agent.dream();
  assert.equal(f.state().conversations[hash("owner")].reflectedActivity, 0);
  await agent.close();
  f.setNow(new Date(2026, 9, 19, 12).getTime());
  agent = f.make();
  await agent.dream();
  assert.deepEqual(f.sessions[1].calls, [DREAM_PROMPT]);
  await agent.close();
});

test("scheduler skips busy chat without losing work, and clear serializes with a running dream", async t => {
  const f = fixture(t);
  const agent = f.make();
  await f.claim(agent);
  await agent.chat(message("facts"));
  const session = f.sessions[0];
  session.gate = deferred();
  session.started = deferred();
  const chat = agent.chat(message("busy"));
  await session.started.promise;
  f.setNow(new Date(2026, 9, 16, 4).getTime());
  await agent.dream();
  assert.equal(session.calls.length, 2);
  session.gate.resolve();
  await chat;
  session.gate = deferred();
  session.started = deferred();
  const dream = agent.dream();
  await session.started.promise;
  agent.clearSession("owner");
  const next = agent.chat(message("after clear"));
  session.gate.resolve();
  await dream;
  assert.equal((await next).text, "reply:after clear");
  assert.notEqual(f.sessions[1].id, session.id);
  assert.equal(session.disposed, true);
  await agent.close();
});

test("shutdown aborts work, suppresses replies and disposes sessions", async t => {
  const f = fixture(t);
  const agent = f.make();
  await f.claim(agent);
  await agent.chat(message("warmup"));
  const session = f.sessions[0];
  session.gate = deferred();
  session.started = deferred();
  const chat = agent.chat(message("active"));
  await session.started.promise;
  await agent.close();
  assert.deepEqual(await chat, {});
  assert.equal(session.disposed, true);
  assert.match((await agent.chat(message("later"))).text, /不可用/);
});

test("media passes only a placeholder; no file path is given to Pi", async t => {
  const f = fixture(t);
  const agent = f.make();
  await f.claim(agent);
  await agent.chat({ ...message("caption"), media: { type: "image", filePath: "/private/file", mimeType: "image/png" } });
  assert.match(f.sessions[0].calls[0], /未读取附件/);
  assert.doesNotMatch(f.sessions[0].calls[0], /private/);
  await agent.close();
});

test("state persistence failure disables authorization instead of allowing an in-memory owner", async t => {
  const f = fixture(t);
  const agent = f.make();
  const code = agent.issueClaim();
  rmSync(join(f.dataDir, "state.json"));
  // A directory cannot be replaced by the atomic state-file rename.
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(f.dataDir, "state.json"));
  assert.match((await agent.chat(message(code))).text, /认领失败/);
  assert.match((await agent.chat(message("hello"))).text, /不可用/);
  assert.throws(() => agent.clearSession("owner"), /未授权/);
  assert.equal(f.sessions.length, 0);
  await agent.close();
});

test("chat and dream diagnostics distinguish failures without exposing raw secrets", async t => {
  const f = fixture(t);
  const agent = f.make();
  await f.claim(agent);
  await agent.chat(message("warmup"));
  f.setNow(new Date(2026, 9, 16, 4).getTime());
  const secret = "sk-test-DO-NOT-LOG-Bearer-token";
  const cases = [
    [new MissingMappedSessionError(), "category=missing-mapped-session"],
    [Object.assign(new Error(secret), { code: "ENOSPC", path: `/private/${secret}` }), "category=filesystem errno=ENOSPC"],
    [Object.assign(new Error(secret), { status: 401, headers: { authorization: secret } }), "category=provider-auth status=401"],
    [new Error(`No API key: ${secret}`), "category=provider-auth"],
    [new AssistantResponseError("error"), "category=provider-auth stopReason=error"],
    [new AssistantResponseError("length"), "category=assistant-response stopReason=length"],
    [new AssistantResponseError("aborted"), "category=assistant-response stopReason=aborted"],
    [new AssistantResponseError(secret), "category=assistant-response stopReason=unknown"],
    [Object.assign(new Error(secret), { code: secret, status: secret }), "category=unknown"],
  ];
  for (const [error, diagnostic] of cases) {
    error.message += ` ${secret}`;
    f.sessions[0].run = async () => { throw error; };
    const response = await agent.chat(message(secret));
    assert.equal(response.text, "处理失败，请稍后重试或联系部署者检查日志与模型配置。");
    assert.equal(f.logs.at(-1), `Chat failed; ${diagnostic}`);
    await agent.dream();
    assert.equal(f.logs.at(-1), `Dream failed; ${diagnostic}; pending activity retained for a later retry.`);
  }
  assert.ok(!f.logs.join("\n").includes(secret));
  assert.ok(!f.logs.join("\n").includes("/private/"));
  await agent.close();
});

test("dream boundary and config validation", t => {
  const f = fixture(t);
  assert.equal(dreamDueAt(new Date(2026, 9, 15, 23).getTime(), 3), new Date(2026, 9, 16, 3).getTime());
  const file = join(f.dataDir, "config.json");
  writeFileSync(file, JSON.stringify({ ...f.config, dataDir: "relative" }));
  assert.equal(loadConfig(file).dataDir, join(f.dataDir, "relative"));
  for (const bad of [{ ...f.config, dream: { enabled: true, hour: 24 } }, { ...f.config, model: "bad" }, { ...f.config, typo: 1 }]) {
    writeFileSync(file, JSON.stringify(bad));
    assert.throws(() => loadConfig(file), /Invalid config/);
  }
});
