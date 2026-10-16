import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PiAgent, dreamDueAt, DREAM_PROMPT, MEMORY_INSTRUCTIONS, parseCommand, parseSavedClaims, REMEMBER_INTENT, REMEMBER_INTENT_EN } from "../dist/pi-agent.js";
import { indexLineCount, readMemoryStore, sameMemoryStore, MEMORY_INDEX_MAX_LINES } from "../dist/memory.js";
import { hash, readState } from "../dist/state.js";
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
      gate: undefined, started: deferred(), fail: false, compactCalls: 0, abortCalls: 0,
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
      async abort() { this.abortCalls++; this.gate?.resolve(); },
      introspect() {
        return {
          model: { provider: "test", id: "model", contextWindow: 1000 },
          thinkingLevel: "medium",
          isIdle: this.isIdle,
          stats: {
            sessionFile: undefined, sessionId: this.id, userMessages: 1, assistantMessages: 1,
            toolCalls: 0, toolResults: 0, totalMessages: 2,
            tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 }, cost: 0.00125,
          },
          contextUsage: { tokens: 100, contextWindow: 1000, percent: 10 },
        };
      },
      async compact() { this.compactCalls++; return { summary: "s", firstKeptEntryId: "x", tokensBefore: 500, estimatedTokensAfter: 120 }; },
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

test("A2 memory write verification: chat verifies MEMORY_SAVED markers and strips them", async t => {
  const f = fixture(t);
  const agent = f.make();
  await f.claim(agent);
  await agent.chat(message("warmup"));
  const session = f.sessions[0];
  const workspace = session.cwd;
  const flagged = () => f.logs.filter(line => line.includes("memory-write-unverified")).length;

  // Success: the model writes the fact DURING the run and claims it.
  session.run = async () => {
    writeFileSync(join(workspace, "MEMORY.md"), "# index\n- 用户喜欢黑咖啡\n");
    return "好的，已记下。\nMEMORY_SAVED: 用户喜欢黑咖啡";
  };
  let response = await agent.chat(message("记住我喜欢黑咖啡"));
  assert.equal(response.text, "好的，已记下。");
  assert.ok(!response.text.includes("MEMORY_SAVED"));
  assert.equal(flagged(), 0);

  // Rewrite of an EXISTING fact: the claimed line text existed before, but the model
  // edited the store during the run, so the claim verifies.
  session.run = async () => {
    writeFileSync(join(workspace, "MEMORY.md"), "# index\n- 用户喜欢黑咖啡（加燕麦奶）\n");
    return "好的，已更正。\nMEMORY_SAVED: 用户喜欢黑咖啡";
  };
  response = await agent.chat(message("其实我喜欢黑咖啡加燕麦奶"));
  assert.equal(response.text, "好的，已更正。");
  assert.equal(flagged(), 0);

  // Failure: the claim is absent from index and topic files (store unchanged).
  session.run = async () => "已保存。\nMEMORY_SAVED: 用户的生日是 1 月 1 日";
  response = await agent.chat(message("记住我的生日"));
  assert.match(response.text, /记忆保存未能确认/);
  assert.ok(!response.text.includes("MEMORY_SAVED"));
  assert.equal(flagged(), 1);

  // Re-asking to remember an EXISTING fact while the model writes NOTHING (store
  // unchanged) does not count as a write.
  session.run = async () => "好的，已记下。\nMEMORY_SAVED: 用户喜欢黑咖啡";
  response = await agent.chat(message("记住我喜欢黑咖啡"));
  assert.match(response.text, /记忆保存未能确认/);
  assert.equal(flagged(), 2);

  // Fabricated claim with an unchanged store is unverified.
  session.run = async () => "好的。\nMEMORY_SAVED: 用户明天要去上海";
  response = await agent.chat(message("随便聊聊"));
  assert.match(response.text, /记忆保存未能确认/);
  assert.equal(flagged(), 3);

  // The detail may live in a topic file written during the run.
  session.run = async () => {
    mkdirSync(join(workspace, "memory"), { recursive: true });
    writeFileSync(join(workspace, "memory", "birthday.md"), "生日：1 月 1 日");
    return "已保存。\nMEMORY_SAVED: 生日：1 月 1 日";
  };
  response = await agent.chat(message("再记一次生日"));
  assert.equal(response.text, "已保存。");
  assert.ok(!response.text.includes("记忆保存未能确认"));
  assert.equal(flagged(), 3);

  // Explicit "remember this" with no marker at all is treated as unconfirmed.
  session.run = async () => "好的。";
  const beforeNoMarker = flagged();
  response = await agent.chat(message("请记住这件事"));
  assert.match(response.text, /记忆保存未能确认/);
  assert.equal(flagged(), beforeNoMarker + 1);
  assert.ok(f.logs.some(line => line.includes("reason=no-marker")));

  // An ordinary turn without markers is not flagged, and neither is a reply that only
  // mentions the marker in prose.
  const before = flagged();
  session.run = async () => "今天天气不错。";
  response = await agent.chat(message("今天天气怎么样"));
  assert.equal(response.text, "今天天气不错。");
  assert.equal(flagged(), before);
  const prose = "说明如下：\nMEMORY_SAVED: 是桥接用来核对记忆写入的标记\n以上就是它的含义。";
  session.run = async () => prose;
  response = await agent.chat(message("这个标记是什么意思？"));
  assert.equal(response.text, prose);
  assert.equal(flagged(), before);
  await agent.close();
});

test("A2/A3 dream verification: unverified writes keep activity due; verified writes are idempotent", async t => {
  const f = fixture(t);
  let agent = f.make();
  await f.claim(agent);
  await agent.chat(message("facts"));
  f.setNow(new Date(2026, 9, 16, 4).getTime());
  const session = f.sessions[0];
  const key = hash("owner");

  // Dream claims a fact but does not write it: attempt is recorded, success is NOT.
  session.run = async () => "已整理。\nMEMORY_SAVED: 用户偏好简洁回复";
  await agent.dream();
  let record = f.state().conversations[key];
  assert.equal(record.reflectedActivity, 0);
  assert.equal(record.lastDreamSuccess, 0);
  assert.equal(record.lastDreamAttempt, f.now);
  assert.ok(f.logs.some(line => line.includes("Dream memory write unverified")));
  // Missed dream is detectable: an attempt newer than the last success.
  assert.ok(record.lastDreamAttempt > record.lastDreamSuccess);

  // Retry with a real write DURING the run. An unverified attempt gates the next run to
  // the next daily boundary after that attempt, so advance the clock past 9/17 03:00.
  f.setNow(new Date(2026, 9, 17, 3, 1).getTime());
  session.run = async () => {
    writeFileSync(join(session.cwd, "MEMORY.md"), "- 用户偏好简洁回复\n");
    return "已整理。\nMEMORY_SAVED: 用户偏好简洁回复";
  };
  await agent.dream();
  record = f.state().conversations[key];
  assert.equal(record.reflectedActivity, record.activity);
  assert.equal(record.lastDreamSuccess, f.now);
  assert.equal(record.lastDreamAttempt, f.now);
  assert.equal(record.pendingSince, 0);

  // Idempotent: no new activity means no second run.
  const calls = session.calls.length;
  await agent.dream();
  assert.equal(session.calls.length, calls);

  // A caught (transient) error keeps the per-minute retry: the unresolved-attempt
  // marker is cleared so the very next tick runs again instead of waiting a day.
  agent.clearSession("owner");
  await agent.drain();
  f.setNow(new Date(2026, 9, 17, 2).getTime());
  await agent.chat(message("more facts"));
  f.setNow(new Date(2026, 9, 17, 4, 1).getTime());
  const second = f.sessions[1];
  second.run = async () => { throw new Error("boom"); };
  await agent.dream();
  record = f.state().conversations[key];
  assert.equal(record.lastDreamAttempt, record.lastDreamSuccess, "transient error clears the gate");
  second.run = async () => "no changes";
  await agent.dream(); // Same tick retries immediately (per-minute semantics preserved).
  record = f.state().conversations[key];
  assert.equal(record.reflectedActivity, record.activity);
  assert.equal(record.lastDreamSuccess, f.now);
  await agent.close();

  // Pre-v2 state.json without the additive marker still loads (defaults to 0).
  const raw = JSON.parse(readFileSync(join(f.dataDir, "state.json"), "utf8"));
  delete raw.conversations[key].lastDreamAttempt;
  writeFileSync(join(f.dataDir, "state.json"), `${JSON.stringify(raw, null, 2)}\n`);
  assert.equal(readState(f.dataDir).conversations[key].lastDreamAttempt, 0);
});

test("P1 dream-style rewrite verifies when the store changed even though the claim text pre-existed", async t => {
  const f = fixture(t);
  const agent = f.make();
  await f.claim(agent);
  await agent.chat(message("facts"));
  const session = f.sessions[0];
  const key = hash("owner");
  // Seed an existing index line whose text is what the dream will claim.
  writeFileSync(join(session.cwd, "MEMORY.md"), "- 用户喜欢拿铁\n");
  f.setNow(new Date(2026, 9, 16, 4).getTime());
  // Dream migrates the detail into a topic file; the index line text is unchanged.
  session.run = async () => {
    mkdirSync(join(session.cwd, "memory"), { recursive: true });
    writeFileSync(join(session.cwd, "memory", "coffee.md"), "用户喜欢拿铁（不加糖）\n");
    return "已整理。\nMEMORY_SAVED: 用户喜欢拿铁";
  };
  await agent.dream();
  const record = f.state().conversations[key];
  assert.equal(record.reflectedActivity, record.activity, "store changed -> verified -> activity covered");
  assert.equal(record.lastDreamSuccess, f.now);
  assert.ok(!f.logs.some(line => line.includes("Dream memory write unverified")));
  await agent.close();
});

test("P3a over-cap index is reported on a tidy-only dream (no claims, no store change)", async t => {
  const f = fixture(t);
  const agent = f.make();
  await f.claim(agent);
  await agent.chat(message("facts"));
  const session = f.sessions[0];
  const lines = Array.from({ length: MEMORY_INDEX_MAX_LINES + 1 }, (_, n) => `- fact ${n}`);
  writeFileSync(join(session.cwd, "MEMORY.md"), `${lines.join("\n")}\n`);
  f.setNow(new Date(2026, 9, 16, 4).getTime());
  session.run = async () => "已检查，无需改动。"; // No claims, no write.
  await agent.dream();
  assert.ok(f.logs.some(line => line.includes("category=memory-index-over-cap")), "cap must surface even without writes");
  await agent.close();
});

test("item4 unverified dream gates the next run to the next daily boundary", async t => {
  const f = fixture(t);
  const agent = f.make();
  await f.claim(agent);
  await agent.chat(message("facts"));
  const session = f.sessions[0];
  const key = hash("owner");
  let dreamRuns = 0;
  // First dream at 04:00 fails verification (claims a fact it never wrote).
  f.setNow(new Date(2026, 9, 16, 4).getTime());
  session.run = async text => {
    if (text === DREAM_PROMPT) { dreamRuns++; return "已整理。\nMEMORY_SAVED: 从未写入的事实"; }
    return `reply:${text}`;
  };
  await agent.dream();
  assert.equal(dreamRuns, 1);
  const record = f.state().conversations[key];
  assert.ok(record.lastDreamAttempt > record.lastDreamSuccess);
  // New same-day chat activity must NOT bypass the backoff gate (guards against a revert
  // to pendingSince-only due derivation, which would re-run here).
  f.setNow(new Date(2026, 9, 16, 4, 1).getTime());
  await agent.chat(message("more same-day facts"));
  assert.equal(dreamRuns, 1, "chat activity does not bypass the backoff gate");
  // Subsequent ticks the same day must NOT re-run the model.
  await agent.dream();
  f.setNow(new Date(2026, 9, 16, 12).getTime());
  await agent.dream();
  assert.equal(dreamRuns, 1, "no re-run before the next daily boundary");
  // Past the next daily boundary (9/17 03:00), it runs again.
  f.setNow(new Date(2026, 9, 17, 3, 1).getTime());
  await agent.dream();
  assert.equal(dreamRuns, 2, "re-runs after the next daily boundary");
  await agent.close();
});

test("item6 over-cap is logged on the unverified-continue path too", async t => {
  const f = fixture(t);
  const agent = f.make();
  await f.claim(agent);
  await agent.chat(message("facts"));
  const session = f.sessions[0];
  const lines = Array.from({ length: MEMORY_INDEX_MAX_LINES + 1 }, (_, n) => `- fact ${n}`);
  writeFileSync(join(session.cwd, "MEMORY.md"), `${lines.join("\n")}\n`);
  f.setNow(new Date(2026, 9, 16, 4).getTime());
  // Unverifiable claim (no store change) so the dream hits the unverified `continue`.
  session.run = async () => "已整理。\nMEMORY_SAVED: 从未写入的事实";
  await agent.dream();
  assert.ok(f.logs.some(line => line.includes("Dream memory write unverified")), "unverified path taken");
  assert.ok(f.logs.some(line => line.includes("category=memory-index-over-cap")), "cap logged before the continue");
  await agent.close();
});

test("item6 sameMemoryStore: changed on add/delete/rename/whitespace; stable and order-insensitive", t => {
  const base = { index: "- a\n- b\n", topics: { "a.md": "A", "b.md": "B" } };
  const clone = { index: "- a\n- b\n", topics: { "b.md": "B", "a.md": "A" } };
  assert.equal(sameMemoryStore(base, clone), true, "identical store, order-insensitive topic names");
  assert.equal(sameMemoryStore(base, { index: "- a\n- b\n- c\n", topics: base.topics }), false, "index add");
  assert.equal(sameMemoryStore(base, { index: "- a\n", topics: base.topics }), false, "index delete");
  assert.equal(sameMemoryStore(base, { index: "- a\n- b \n", topics: base.topics }), false, "index whitespace");
  assert.equal(sameMemoryStore(base, { index: base.index, topics: { "a.md": "A", "b.md": "B", "c.md": "C" } }), false, "topic add");
  assert.equal(sameMemoryStore(base, { index: base.index, topics: { "a.md": "A" } }), false, "topic delete");
  assert.equal(sameMemoryStore(base, { index: base.index, topics: { "renamed.md": "A", "b.md": "B" } }), false, "topic rename");
  assert.equal(sameMemoryStore(base, { index: base.index, topics: { "a.md": "A ", "b.md": "B" } }), false, "topic whitespace");
  assert.equal(sameMemoryStore({ index: null, topics: {} }, { index: null, topics: {} }), true, "both empty");
});

test("A1 existing AGENTS.md is never overwritten and logs a migration note", async t => {
  const f = fixture(t);
  const agent = f.make();
  await f.claim(agent);
  // Pre-seed a v1 workspace with a custom AGENTS.md before the session is created.
  const cwd = join(f.dataDir, "conversations", hash("owner"));
  mkdirSync(cwd, { recursive: true });
  const custom = "# custom v1 instructions\nRead MEMORY.md before answering.\n";
  writeFileSync(join(cwd, "AGENTS.md"), custom);
  await agent.chat(message("hello"));
  assert.equal(readFileSync(join(cwd, "AGENTS.md"), "utf8"), custom, "existing instructions must not be rewritten");
  assert.ok(f.logs.some(line => line.includes("predates the memory-index template")));
  await agent.close();
});

test("A4 session commands require authorization and never reach Pi when unauthorized", async t => {
  const f = fixture(t);
  const agent = f.make();
  for (const command of ["/status", "/cost", "/context", "/compact", "/stop"]) {
    const response = await agent.chat(message(command, "stranger"));
    assert.equal(response.text, "未授权", `${command} must be rejected`);
  }
  assert.equal(f.sessions.length, 0, "no Pi session may be created for unauthorized commands");
  await agent.close();
});

test("A4 authorized commands: status/cost/context/compact/stop", async t => {
  const f = fixture(t);
  const agent = f.make();
  await f.claim(agent);
  await agent.chat(message("warmup"));
  const session = f.sessions[0];

  let response = await agent.chat(message("/status"));
  assert.match(response.text, /会话状态/);
  assert.match(response.text, /test\/model/);
  assert.match(response.text, /上下文: 100 \/ 1,000 tokens/);
  assert.match(response.text, /dream: 已覆盖 0\/1（有待处理活动）/);

  response = await agent.chat(message("/cost"));
  assert.match(response.text, /合计: 15/);
  assert.match(response.text, /费用: 0\.001[23]/);

  response = await agent.chat(message("/context"));
  assert.match(response.text, /100 \/ 1,000 tokens（10.0%）/);

  response = await agent.chat(message("/compact keep the decisions"));
  assert.match(response.text, /已压缩/);
  assert.equal(session.compactCalls, 1);

  const abortBefore = session.abortCalls;
  response = await agent.chat(message("/stop"));
  assert.match(response.text, /已请求中止/);
  assert.equal(session.abortCalls, abortBefore + 1, "/stop must call session.abort()");

  // Commands are never forwarded to the model as prompts.
  assert.ok(!session.calls.some(call => call.startsWith("/")));
  await agent.close();
});

test("A4 command parsing is bridge-owned and ignores SDK-handled commands", t => {
  assert.deepEqual(parseCommand("/status"), { command: "status", args: "" });
  assert.deepEqual(parseCommand("  /Cost  "), { command: "cost", args: "" });
  assert.deepEqual(parseCommand("/compact  keep the decisions "), { command: "compact", args: "keep the decisions" });
  assert.equal(parseCommand("/echo hi"), null);
  assert.equal(parseCommand("/toggle-debug"), null);
  assert.equal(parseCommand("/clear"), null);
  assert.equal(parseCommand("/unknown"), null);
  assert.equal(parseCommand("hello"), null);
  assert.equal(parseCommand("/statuses"), null);
});

test("A2 marker parsing strips only a trailing anchored marker block", t => {
  // A real save: prose, then the anchored marker block at the END (per the prompt contract).
  assert.deepEqual(parseSavedClaims("已记下。\nMEMORY_SAVED: 用户喜欢黑咖啡\nMEMORY_SAVED: 用户住在杭州"), {
    claims: ["用户喜欢黑咖啡", "用户住在杭州"], stripped: "已记下。",
  });
  // Real save with trailing prose ON the marker line: the whole remainder is the claim.
  assert.deepEqual(parseSavedClaims("好的。\nMEMORY_SAVED: 用户喜欢黑咖啡（已写入）"), {
    claims: ["用户喜欢黑咖啡（已写入）"], stripped: "好的。",
  });
  // Real save with a leading list bullet; trailing blank lines are ignored.
  assert.deepEqual(parseSavedClaims("好的。\n- MEMORY_SAVED: 用户喜欢黑咖啡\n\n"), {
    claims: ["用户喜欢黑咖啡"], stripped: "好的。",
  });
  // A reply that merely MENTIONS the marker mid-paragraph must be left byte-identical.
  const mentions = "说明如下：\nMEMORY_SAVED: 是桥接用来核对记忆写入的标记\n以上就是它的含义。";
  assert.deepEqual(parseSavedClaims(mentions), { claims: [], stripped: mentions });
  // A marker that is not anchored at line start is not a claim.
  assert.deepEqual(parseSavedClaims("前缀 MEMORY_SAVED: fact"), { claims: [], stripped: "前缀 MEMORY_SAVED: fact" });
  // Normal reply with no marker is unchanged; a bare marker with no text is not a claim.
  assert.deepEqual(parseSavedClaims("no markers here"), { claims: [], stripped: "no markers here" });
  assert.deepEqual(parseSavedClaims("MEMORY_SAVED:"), { claims: [], stripped: "MEMORY_SAVED:" });
});

test("P2-1 REMEMBER_INTENT matches line-anchored imperative phrasings", t => {
  const hit = text => REMEMBER_INTENT.test(text) || REMEMBER_INTENT_EN.test(text);
  for (const text of ["记住我喜欢黑咖啡", "帮我记住明天开会", "请记住这件事", "记住：会议改到3点", "记一下这", "记下：我住在杭州"]) {
    assert.equal(hit(text), true, `CN should match: ${text}`);
  }
  for (const text of ["你能记住多少条记忆？", "好的，我记住了", "我记下了你的建议", "你记住了吗", "今天天气不错"]) {
    assert.equal(hit(text), false, `CN should not match: ${text}`);
  }
  // Shipped English pattern is anchored: imperative matches, descriptive does not.
  for (const text of ["remember this", "Please remember my address", "Remember that I like tea"]) {
    assert.equal(REMEMBER_INTENT_EN.test(text), true, `EN should match: ${text}`);
  }
  for (const text of ["I remember this song", "I do remember that day", "do you remember this?"]) {
    assert.equal(REMEMBER_INTENT_EN.test(text), false, `EN should not match: ${text}`);
  }
});

test("P2-3 readMemoryStore treats a non-directory memory path as no topics", async t => {
  const f = fixture(t);
  const agent = f.make();
  await f.claim(agent);
  await agent.chat(message("warmup"));
  const session = f.sessions[0];
  // A plain file named "memory" (not a directory) must not make reads throw.
  writeFileSync(join(session.cwd, "memory"), "this is a file, not a directory\n");
  writeFileSync(join(session.cwd, "MEMORY.md"), "- 一个事实\n");
  const store = readMemoryStore(session.cwd);
  assert.equal(store.index, "- 一个事实\n");
  assert.deepEqual(store.topics, {});
  // /status and chat must keep working instead of degrading to a command/chat failure.
  const status = await agent.chat(message("/status"));
  assert.match(status.text, /会话状态/);
  session.run = async () => "ok";
  const reply = await agent.chat(message("hello"));
  assert.equal(reply.text, "ok");
  await agent.close();
});

test("A1 memory index cap surfaces over-cap state via /status", async t => {
  const f = fixture(t);
  const agent = f.make();
  await f.claim(agent);
  await agent.chat(message("warmup"));
  const session = f.sessions[0];
  const lines = Array.from({ length: MEMORY_INDEX_MAX_LINES + 1 }, (_, n) => `- fact ${n}`);
  writeFileSync(join(session.cwd, "MEMORY.md"), `${lines.join("\n")}\n`);
  const store = readMemoryStore(session.cwd);
  assert.equal(indexLineCount(store.index), MEMORY_INDEX_MAX_LINES + 1);
  const response = await agent.chat(message("/status"));
  assert.match(response.text, /已超限/);
  await agent.close();
});
