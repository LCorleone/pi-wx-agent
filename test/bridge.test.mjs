import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PiAgent, dreamDueAt, DREAM_PROMPT, MEMORY_INSTRUCTIONS, parseAttachLines, parseCommand, parseSavedClaims, REMEMBER_INTENT, REMEMBER_INTENT_EN, attachMediaType, sniffImageMime } from "../dist/pi-agent.js";
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
      cwd, id: record.sessionId, isIdle: true, calls: [], imageCalls: [], disposed: false,
      gate: undefined, started: deferred(), fail: false, compactCalls: 0, abortCalls: 0,
      async run(text, images) {
        assert.equal(this.isIdle, true, "no overlapping prompts");
        this.isIdle = false;
        this.calls.push(text);
        this.imageCalls.push(images ?? []);
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

test("B1 inbound image: copied to media/ with the sniffed extension; no image bytes enter the prompt", async t => {
  const f = fixture(t);
  const agent = f.make();
  await f.claim(agent);
  // Real magic headers; the SDK stores images as .bin temp files with mimeType "image/*".
  const magic = [
    ["png", ".png", Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("payload")])],
    ["jpeg", ".jpg", Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("payload")])],
    ["gif", ".gif", Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.from("payload")])],
    ["webp", ".webp", Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.alloc(4), Buffer.from("WEBP", "latin1"), Buffer.from("payload")])],
  ];
  for (const [kind, ext, bytes] of magic) {
    const filePath = join(f.dataDir, `1770000000-abcd${kind}.bin`);
    writeFileSync(filePath, bytes);
    const response = await agent.chat({ ...message(`看看这张${kind}`), media: { type: "image", filePath, mimeType: "image/*" } });
    assert.equal(response.text.startsWith("reply:"), true, `${kind} must not fail the chat`);
    const session = f.sessions[0];
    // The copy is byte-identical under media/ with the sniffed extension.
    const stored = join(session.cwd, "media", `1770000000-abcd${kind}${ext}`);
    assert.deepEqual(readFileSync(stored), bytes, `${kind} persisted under media/`);
    assert.match(session.calls.at(-1), new RegExp(`\\[图片: media/1770000000-abcd${kind}${ext.replace(".", "\\.")}（已保存在工作区，可用图片工具查看。）\\]`));
    // No image attachment and no base64 payload may reach the prompt.
    assert.equal(session.imageCalls.at(-1).length, 0, `${kind} must not be inlined`);
    assert.ok(!session.calls.at(-1).includes(bytes.toString("base64")), "no base64 in the prompt");
  }
  // A real extension on the name is kept; the annotation names the stored copy.
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from("x")]);
  writeFileSync(join(f.dataDir, "photo.jpg"), jpg);
  await agent.chat({ ...message("带名字的"), media: { type: "image", filePath: join(f.dataDir, "photo.jpg"), mimeType: "image/*", fileName: "photo.jpg" } });
  assert.deepEqual(readFileSync(join(f.sessions[0].cwd, "media", "photo.jpg")), jpg);
  assert.match(f.sessions[0].calls.at(-1), /\[图片: media\/photo\.jpg（已保存在工作区，可用图片工具查看。）\]/);
  assert.equal(f.sessions[0].imageCalls.at(-1).length, 0);
  await agent.close();
});

test("B1 unknown-magic image is copied as .bin and still referenced by path", async t => {
  const f = fixture(t);
  const agent = f.make();
  await f.claim(agent);
  const bytes = Buffer.from("not an image at all");
  const filePath = join(f.dataDir, "1770000000-xyz.bin");
  writeFileSync(filePath, bytes);
  const response = await agent.chat({ ...message("看看"), media: { type: "image", filePath, mimeType: "image/*" } });
  assert.equal(response.text.startsWith("reply:"), true);
  const session = f.sessions[0];
  assert.deepEqual(readFileSync(join(session.cwd, "media", "1770000000-xyz.bin")), bytes);
  assert.match(session.calls.at(-1), /\[图片: media\/1770000000-xyz\.bin（已保存在工作区，可用图片工具查看。）\]/);
  assert.equal(session.imageCalls.at(-1).length, 0);
  await agent.close();
});

test("B1 image copy failure degrades to an annotation and never throws", async t => {
  const f = fixture(t);
  const agent = f.make();
  await f.claim(agent);
  await agent.chat(message("warmup")); // Creates the workspace.
  const session = f.sessions[0];
  // A plain file named media/ blocks the media directory creation.
  writeFileSync(join(session.cwd, "media"), "not a directory");
  writeFileSync(join(f.dataDir, "blocked.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  let response = await agent.chat({ ...message("看图"), media: { type: "image", filePath: join(f.dataDir, "blocked.bin"), mimeType: "image/*" } });
  assert.match(response.text, /保存失败，未提供路径/);
  assert.match(response.text, /^reply:/, "chat must not fail");
  assert.equal(session.imageCalls.at(-1).length, 0);
  // A missing source file degrades the same way; no absolute path leaks into the prompt.
  response = await agent.chat({ ...message("丢失的图"), media: { type: "image", filePath: join(f.dataDir, "gone.bin"), mimeType: "image/*" } });
  assert.match(response.text, /保存失败，未提供路径/);
  assert.ok(!session.calls.some(call => call.includes(f.dataDir)), "no absolute source path leaks into the prompt");
  await agent.close();
});

test("B1 sniffImageMime unit: magic table and unknown/empty files", t => {
  const f = fixture(t);
  const put = (name, bytes) => { const p = join(f.dataDir, name); writeFileSync(p, bytes); return p; };
  assert.equal(sniffImageMime(put("a", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]))), "image/png");
  assert.equal(sniffImageMime(put("b", Buffer.from([0xff, 0xd8, 0xff, 0xdb]))), "image/jpeg");
  assert.equal(sniffImageMime(put("c", Buffer.from("GIF87a01", "latin1"))), "image/gif");
  assert.equal(sniffImageMime(put("d", Buffer.from("GIF89a01", "latin1"))), "image/gif");
  assert.equal(sniffImageMime(put("e", Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.alloc(4), Buffer.from("WEBPVP8 ", "latin1")]))), "image/webp");
  assert.equal(sniffImageMime(put("g", Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.alloc(4), Buffer.from("XXXX", "latin1")]))), null, "RIFF but not WEBP");
  assert.equal(sniffImageMime(put("h", Buffer.from("GIF99a", "latin1"))), null, "unknown GIF variant");
  assert.equal(sniffImageMime(put("i", Buffer.alloc(0))), null, "empty file");
  assert.equal(sniffImageMime(put("j", Buffer.from("BM\u0002", "latin1"))), null, "BMP is not supported");
});

test("B1 inbound file and video are copied into workspace media/ and annotated by relative path", async t => {
  const f = fixture(t);
  const agent = f.make();
  await f.claim(agent);
  const src = join(f.dataDir, "doc.pdf");
  writeFileSync(src, "PDFDATA");
  let response = await agent.chat({
    ...message("帮我总结"),
    media: { type: "file", filePath: src, mimeType: "application/pdf", fileName: "年报.pdf" },
  });
  const session = f.sessions[0];
  const stored = join(session.cwd, "media", "年报.pdf");
  assert.equal(readFileSync(stored, "utf8"), "PDFDATA");
  assert.match(session.calls[0], /帮我总结\n\[文件: media\/年报\.pdf/);
  assert.equal(session.imageCalls[0].length, 0);
  assert.ok(!session.calls[0].includes(f.dataDir), "prompt carries the workspace-relative path only");
  assert.equal(response.text.startsWith("reply:"), true);

  // Same filename again: a collision suffix keeps both files, prompt names the new one.
  writeFileSync(src, "PDFDATA2");
  await agent.chat({ ...message("再总结"), media: { type: "file", filePath: src, mimeType: "application/pdf", fileName: "年报.pdf" } });
  assert.match(session.calls[1], /\[文件: media\/年报-1\.pdf/);
  assert.equal(readFileSync(join(session.cwd, "media", "年报-1.pdf"), "utf8"), "PDFDATA2");
  assert.equal(readFileSync(stored, "utf8"), "PDFDATA", "first copy untouched");

  // Video is treated like a file (no video input for Pi).
  const vid = join(f.dataDir, "clip.mp4");
  writeFileSync(vid, "VID");
  await agent.chat({ ...message("看视频"), media: { type: "video", filePath: vid, mimeType: "video/mp4", fileName: "clip.mp4" } });
  assert.match(session.calls[2], /\[视频: media\/clip\.mp4/);
  assert.equal(readFileSync(join(session.cwd, "media", "clip.mp4"), "utf8"), "VID");

  // Hostile filenames cannot escape media/, and missing sources degrade instead of failing.
  writeFileSync(src, "SH");
  await agent.chat({ ...message("脚本"), media: { type: "file", filePath: src, mimeType: "text/x-sh", fileName: "../../evil.sh" } });
  assert.match(session.calls[3], /\[文件: media\/evil\.sh/);
  assert.equal(readFileSync(join(session.cwd, "media", "evil.sh"), "utf8"), "SH");
  const degraded = await agent.chat({
    ...message("丢失的文件"), media: { type: "file", filePath: join(f.dataDir, "nope.bin"), mimeType: "application/octet-stream", fileName: "nope.bin" },
  });
  assert.match(degraded.text, /保存失败/);
  assert.match(degraded.text, /reply:/);
  await agent.close();
});

test("B2 audio: transcription passes through with a note; empty transcription annotates only", async t => {
  const f = fixture(t);
  const agent = f.make();
  await f.claim(agent);
  const voice = { type: "audio", filePath: join(f.dataDir, "v.wav"), mimeType: "audio/wav" };
  await agent.chat({ ...message("明天提醒我开会"), media: voice });
  assert.equal(f.sessions[0].calls[0], "[语音] 明天提醒我开会");
  assert.equal(f.sessions[0].imageCalls[0].length, 0);
  await agent.chat({ conversationId: "owner", text: "", media: voice });
  assert.match(f.sessions[0].calls[1], /语音消息：转写不可用/);
  assert.equal(f.sessions[0].imageCalls[1].length, 0);
  await agent.close();
});

test("B4 ATTACH: valid image/video/file lines are stripped and delivered as the sole attachment", async t => {
  const f = fixture(t);
  const agent = f.make();
  await f.claim(agent);
  await agent.chat(message("warmup"));
  const session = f.sessions[0];
  mkdirSync(join(session.cwd, "media"), { recursive: true });
  writeFileSync(join(session.cwd, "media", "chart.png"), "PNG");
  writeFileSync(join(session.cwd, "media", "clip.mp4"), "MP4");
  writeFileSync(join(session.cwd, "media", "data.zip"), "ZIP");

  session.run = async () => "图已生成。\nATTACH: media/chart.png";
  let response = await agent.chat(message("画个图"));
  assert.equal(response.text, "图已生成。");
  assert.equal(response.media.type, "image");
  assert.equal(response.media.url, realpathSync(join(session.cwd, "media", "chart.png")));
  assert.equal(response.media.fileName, "chart.png");

  session.run = async () => "ATTACH: media/clip.mp4";
  response = await agent.chat(message("视频"));
  assert.equal(response.text, "（本轮无文字回复）");
  assert.equal(response.media.type, "video");

  session.run = async () => "打包好了。\nATTACH: media/data.zip";
  response = await agent.chat(message("打包"));
  assert.equal(response.media.type, "file");
  assert.equal(response.text, "打包好了。");

  // A reply without the marker never produces media.
  session.run = async () => "纯文字。";
  response = await agent.chat(message("纯文字"));
  assert.equal(response.media, undefined);
  assert.equal(response.text, "纯文字。");
  await agent.close();
});

test("B4 ATTACH rejects traversal, missing files and directories; extras beyond the first are dropped", async t => {
  const f = fixture(t);
  const agent = f.make();
  await f.claim(agent);
  await agent.chat(message("warmup"));
  const session = f.sessions[0];
  mkdirSync(join(session.cwd, "media", "subdir"), { recursive: true });
  const rejected = () => f.logs.filter(line => line.includes("category=attach-rejected")).length;
  const dropped = () => f.logs.filter(line => line.includes("category=attach-dropped")).length;

  // Absolute or ../ paths stay rejected even when they point at a real outside file.
  writeFileSync(join(f.dataDir, "secret.txt"), "S");
  for (const path of ["../../../etc/passwd", join(f.dataDir, "secret.txt"), "/etc/passwd", ".", "media/subdir"]) {
    session.run = async () => `结果。\nATTACH: ${path}`;
    const response = await agent.chat(message("拿文件"));
    assert.equal(response.media, undefined, `${path} must be rejected`);
    assert.equal(response.text, "结果。", "text stays minus the marker");
  }
  assert.equal(rejected(), 5);

  // A missing file inside the workspace is rejected too.
  session.run = async () => "结果。\nATTACH: media/missing.png";
  const response = await agent.chat(message("拿文件"));
  assert.equal(response.media, undefined);
  assert.equal(response.text, "结果。");
  assert.equal(rejected(), 6);

  // Multiple trailing ATTACH lines: only the first is honored, the rest dropped with a diagnostic.
  writeFileSync(join(session.cwd, "media", "a.png"), "A");
  writeFileSync(join(session.cwd, "media", "b.png"), "B");
  session.run = async () => "两个。\nATTACH: media/a.png\nATTACH: media/b.png";
  const multi = await agent.chat(message("拿两个"));
  assert.equal(multi.media.url, realpathSync(join(session.cwd, "media", "a.png")));
  assert.equal(multi.text, "两个。");
  assert.equal(dropped(), 1);
  await agent.close();
});

test("B4 ATTACH containment follows symlinks (realpath); broken links fall to unreadable", async t => {
  const f = fixture(t);
  const agent = f.make();
  await f.claim(agent);
  await agent.chat(message("warmup"));
  const session = f.sessions[0];
  mkdirSync(join(session.cwd, "media"), { recursive: true });
  const outside = join(f.dataDir, "outside-secret.txt");
  writeFileSync(outside, "S");
  const rejected = () => f.logs.filter(line => line.includes("category=attach-rejected")).length;

  // A symlink inside media/ pointing at a real file outside the workspace.
  symlinkSync(outside, join(session.cwd, "media", "escape.png"));
  session.run = async () => "拿。\nATTACH: media/escape.png";
  let response = await agent.chat(message("拿文件"));
  assert.equal(response.media, undefined, "symlink escaping the workspace must be rejected");
  assert.equal(response.text, "拿。");
  assert.equal(rejected(), 1);

  // An intermediate directory symlink: media/dir -> dataDir, file reached "through" it.
  symlinkSync(f.dataDir, join(session.cwd, "media", "dir"));
  session.run = async () => "拿。\nATTACH: media/dir/outside-secret.txt";
  response = await agent.chat(message("拿文件"));
  assert.equal(response.media, undefined, "indirect symlink escape must be rejected");
  assert.equal(rejected(), 2);

  // A regular file inside the workspace still attaches, with its realpath as the url.
  writeFileSync(join(session.cwd, "media", "real.png"), "P");
  session.run = async () => "拿。\nATTACH: media/real.png";
  response = await agent.chat(message("拿文件"));
  assert.equal(response.media.url, realpathSync(join(session.cwd, "media", "real.png")));
  assert.equal(response.media.type, "image");

  // A broken symlink resolves nowhere: the existing unreadable rejection applies.
  symlinkSync(join(f.dataDir, "gone.txt"), join(session.cwd, "media", "broken.png"));
  session.run = async () => "拿。\nATTACH: media/broken.png";
  response = await agent.chat(message("拿文件"));
  assert.equal(response.media, undefined);
  assert.ok(f.logs.some(line => line.includes("category=attach-rejected reason=unreadable")));
  assert.ok(!f.logs.join("\n").includes(outside), "no outside path leaks into logs");
  await agent.close();
});

test("B4 ATTACH composes with MEMORY_SAVED: both stripped, claim verified, file attached", async t => {
  const f = fixture(t);
  const agent = f.make();
  await f.claim(agent);
  await agent.chat(message("warmup"));
  const session = f.sessions[0];
  const workspace = session.cwd;
  mkdirSync(join(workspace, "media"), { recursive: true });
  writeFileSync(join(workspace, "media", "chart.png"), "PNG");
  session.run = async () => {
    writeFileSync(join(workspace, "MEMORY.md"), "- 用户喜欢图表\n");
    return "已记住并生成图表。\nMEMORY_SAVED: 用户喜欢图表\nATTACH: media/chart.png";
  };
  const response = await agent.chat(message("记住我喜欢图表并画一张"));
  assert.equal(response.text, "已记住并生成图表。");
  assert.ok(!response.text.includes("MEMORY_SAVED"));
  assert.ok(!response.text.includes("记忆保存未能确认"));
  assert.equal(response.media.url, realpathSync(join(workspace, "media", "chart.png")));
  // Wrong order (ATTACH before MEMORY_SAVED) keeps the claim handling intact; the
  // attach line is simply not trailing and is delivered as ordinary text.
  session.run = async () => {
    writeFileSync(join(workspace, "MEMORY.md"), "- 用户喜欢图表2\n");
    return "已更新。\nATTACH: media/chart.png\nMEMORY_SAVED: 用户喜欢图表2";
  };
  const swapped = await agent.chat(message("再记一次并附图"));
  assert.equal(swapped.text, "已更新。\nATTACH: media/chart.png");
  assert.equal(swapped.media, undefined);
  await agent.close();
});

test("B4 parseAttachLines and attachMediaType units", () => {
  assert.deepEqual(parseAttachLines("好的。\nATTACH: media/a.png"), { paths: ["media/a.png"], stripped: "好的。" });
  assert.deepEqual(parseAttachLines("好的。\n- ATTACH: media/a.png\n\n"), { paths: ["media/a.png"], stripped: "好的。" });
  assert.deepEqual(parseAttachLines("ATTACH: media/a.png\nATTACH: media/b.png"), { paths: ["media/a.png", "media/b.png"], stripped: "" });
  // Mentioning the marker in prose is not an attach; a bare marker with no path is not either.
  const prose = "用法：ATTACH: 路径 表示附件。";
  assert.deepEqual(parseAttachLines(prose), { paths: [], stripped: prose });
  assert.deepEqual(parseAttachLines("ATTACH:"), { paths: [], stripped: "ATTACH:" });
  assert.deepEqual(parseAttachLines("没有附件"), { paths: [], stripped: "没有附件" });
  assert.equal(attachMediaType("media/a.JPG"), "image");
  assert.equal(attachMediaType("media/a.webp"), "image");
  assert.equal(attachMediaType("media/a.mov"), "video");
  assert.equal(attachMediaType("media/a.MP4"), "video");
  assert.equal(attachMediaType("media/a.pdf"), "file");
  assert.equal(attachMediaType("media/noext"), "file");
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
  assert.ok(f.logs.some(line => line.includes("differs from the current template")));
  await agent.close();
});

test("A4 session commands require authorization and never reach Pi when unauthorized", async t => {
  const f = fixture(t);
  const agent = f.make();
  for (const command of ["/status", "/cost", "/context", "/compact", "/stop", "/invite", "/members", "/kick 1", "/help"]) {
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
  assert.deepEqual(parseCommand("  /Help  "), { command: "help", args: "" });
  assert.deepEqual(parseCommand("/compact  keep the decisions "), { command: "compact", args: "keep the decisions" });
  assert.equal(parseCommand("/echo hi"), null);
  assert.equal(parseCommand("/toggle-debug"), null);
  assert.equal(parseCommand("/clear"), null);
  assert.equal(parseCommand("/unknown"), null);
  assert.equal(parseCommand("/helper"), null);
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

// ---------------------------------------------------------------------------
// #003 多用户家庭版：成员邀请制（owner + invited members）
// ---------------------------------------------------------------------------

/** Claim the owner and return one active invite code issued via /invite. */
async function inviteCode(agent) {
  const response = await agent.chat(message("/invite"));
  assert.match(response.text, /24 小时内有效/);
  return response.text.match(/\b([a-f0-9]{32})\b/)[1];
}

test("invite: owner issues a 24h multi-use code; exact match joins with a welcome and no Pi call", async t => {
  const f = fixture(t);
  const agent = f.make();
  await f.claim(agent);
  // Without an invite even code-shaped text is rejected.
  assert.equal((await agent.chat(message("a".repeat(32), "sister"))).text, "未授权");
  const code = await inviteCode(agent);
  assert.equal(f.state().invite.hash, hash(code));
  assert.equal(f.state().invite.expiresAt, f.now + 24 * 3600_000);
  // Strangers and wrong codes stay rejected; the invite is not consumed.
  assert.equal((await agent.chat(message("hello", "sister"))).text, "未授权");
  const wrong = `${code.slice(0, 31)}${code[31] === "0" ? "1" : "0"}`;
  assert.equal((await agent.chat(message(wrong, "sister"))).text, "未授权");
  // Exact code joins: welcome text, durable roster, still no Pi session.
  const joined = await agent.chat(message(code, "sister"));
  assert.match(joined.text, /欢迎加入/);
  assert.match(joined.text, /部署者/);
  assert.match(joined.text, /用量由部署者承担/);
  assert.match(joined.text, /\/status \/cost \/context \/compact/);
  assert.equal(f.sessions.length, 0, "joining must not create a Pi session");
  assert.deepEqual(f.state().members, { [hash("sister")]: { joinedAt: f.now } });
  // The same code admits several members inside the window.
  f.setNow(f.now + 60_000);
  assert.match((await agent.chat(message(code, "brother"))).text, /欢迎加入/);
  assert.equal(Object.keys(f.state().members).length, 2);
  // A joined member chats normally in their own workspace.
  assert.equal((await agent.chat(message("hi", "sister"))).text, "reply:hi");
  assert.equal(f.sessions[0].cwd, join(f.dataDir, "conversations", hash("sister")));
  await agent.close();
});

test("invite expiry and rotation: expired or superseded codes never admit anyone", async t => {
  const f = fixture(t);
  const agent = f.make();
  await f.claim(agent);
  const first = await inviteCode(agent);
  f.setNow(f.now + 24 * 3600_000 + 1);
  assert.equal((await agent.chat(message(first, "late"))).text, "未授权", "expired code");
  const second = await inviteCode(agent);
  assert.notEqual(second, first);
  assert.equal((await agent.chat(message(first, "late"))).text, "未授权", "rotated old code");
  assert.match((await agent.chat(message(second, "late"))).text, /欢迎加入/);
  // The active invite survives a restart: hash and expiry are durable state.
  await agent.close();
  const reborn = f.make();
  assert.match((await reborn.chat(message(second, "grandma"))).text, /欢迎加入/, "same code still admits after restart");
  await reborn.close();
});

test("an unclaimed deployment admits nobody via invite codes", async t => {
  const f = fixture(t);
  // Hand-written state that no API path can produce: no owner yet, active invite.
  writeFileSync(join(f.dataDir, "state.json"), JSON.stringify({
    version: 1, owner: null, claim: null, members: {},
    invite: { hash: hash("deadbeef"), expiresAt: f.now + 3600_000 }, conversations: {},
  }));
  const agent = f.make();
  assert.equal((await agent.chat(message("deadbeef", "cousin"))).text, "未授权");
  assert.deepEqual(f.state().members, {});
  assert.equal(f.sessions.length, 0);
  await agent.close();
});

test("management commands are owner-only; members keep session commands on their own session", async t => {
  const f = fixture(t);
  const agent = f.make();
  await f.claim(agent);
  const code = await inviteCode(agent);
  assert.match((await agent.chat(message(code, "sister"))).text, /欢迎加入/);
  for (const command of ["/invite", "/members", "/kick 1"]) {
    assert.equal((await agent.chat(message(command, "sister"))).text, "该命令仅部署者可用。", `${command} is owner-only`);
  }
  assert.equal(f.sessions.length, 0, "refused management commands never create Pi sessions");
  // Session commands work for a member, scoped to their OWN session and workspace.
  await agent.chat(message("warmup", "sister"));
  const sister = f.sessions.at(-1);
  assert.match((await agent.chat(message("/status", "sister"))).text, /会话状态/);
  assert.match((await agent.chat(message("/cost", "sister"))).text, /合计: 15/);
  assert.match((await agent.chat(message("/context", "sister"))).text, /100 \/ 1,000 tokens/);
  assert.match((await agent.chat(message("/compact", "sister"))).text, /已压缩/);
  assert.equal(sister.compactCalls, 1);
  const status = (await agent.chat(message("/status", "sister"))).text;
  assert.ok(status.includes(hash("sister").slice(0, 8)), "member status names the member workspace");
  assert.ok(!status.includes(hash("owner").slice(0, 8)), "member status never leaks the owner workspace");
  // /clear by a member disposes only their own session; the owner's stays alive.
  await agent.chat(message("owner warmup"));
  const owner = f.sessions.at(-1);
  assert.notEqual(owner, sister);
  agent.clearSession("sister");
  await agent.drain();
  assert.equal(sister.disposed, true);
  assert.equal(owner.disposed, false);
  await agent.close();
});

test("/help is role-aware static text: owner sees management, members do not, no Pi call", async t => {
  const f = fixture(t);
  const agent = f.make();
  // Unauthorized senders get the plain refusal, same as every other command:
  // no capability leak, no session, zero Pi runs.
  assert.equal((await agent.chat(message("/help", "stranger"))).text, "未授权");
  assert.equal(f.sessions.length, 0, "unauthorized /help must not create a Pi session");
  // Owner: the common block plus the management block.
  await f.claim(agent);
  const ownerHelp = (await agent.chat(message("/help"))).text;
  assert.ok(ownerHelp.includes("/status"), "owner help lists session commands");
  assert.ok(ownerHelp.includes("/compact"), "owner help lists /compact");
  assert.ok(ownerHelp.includes("/invite"), "owner help lists management commands");
  assert.ok(ownerHelp.includes("/kick"), "owner help lists /kick");
  assert.match(ownerHelp, /普通聊天/);
  // Member: the management block is omitted entirely.
  const code = await inviteCode(agent);
  assert.match((await agent.chat(message(code, "sister"))).text, /欢迎加入/);
  const memberHelp = (await agent.chat(message("/help", "sister"))).text;
  assert.ok(memberHelp.includes("/status"), "member help lists session commands");
  assert.ok(!memberHelp.includes("/invite"), "member help must omit /invite");
  assert.ok(!memberHelp.includes("/members"), "member help must omit /members");
  assert.ok(!memberHelp.includes("/kick"), "member help must omit /kick");
  // Static text on no session for every role: nothing ever reached Pi.
  assert.equal(f.sessions.length, 0, "/help never creates a Pi session");
  await agent.close();
});

test("/members lists join dates without hashes; /kick removes by ordinal, renumbers and guards input", async t => {
  const f = fixture(t);
  const agent = f.make();
  await f.claim(agent);
  const code = await inviteCode(agent);
  assert.match((await agent.chat(message("/members"))).text, /还没有成员/, "empty roster is a non-error");
  assert.match((await agent.chat(message(code, "sister"))).text, /欢迎加入/);
  const sisterJoined = f.now;
  f.setNow(f.now + 60_000);
  assert.match((await agent.chat(message(code, "brother"))).text, /欢迎加入/);
  const brotherJoined = f.now;
  const list = (await agent.chat(message("/members"))).text;
  assert.match(list, /共 2 位/);
  assert.ok(list.includes(`1. ${new Date(sisterJoined).toISOString()} 加入`));
  assert.ok(list.includes(`2. ${new Date(brotherJoined).toISOString()} 加入`));
  assert.ok(!list.includes(hash("sister")), "member hashes are never displayed");
  // Kick the first member: she is unauthorized from her next message; brother remains.
  // The reply names the join date so an ordinal mismatch (someone joining between
  // /members and /kick) is visible to the owner.
  const kick = (await agent.chat(message("/kick 1"))).text;
  assert.match(kick, new RegExp(`已移除成员 1（${new Date(sisterJoined).toISOString()} 加入）`));
  assert.match(kick, /邀请码已同时作废/);
  assert.equal((await agent.chat(message("hello", "sister"))).text, "未授权");
  assert.match((await agent.chat(message("hello", "brother"))).text, /reply:hello/);
  const after = (await agent.chat(message("/members"))).text;
  assert.match(after, /共 1 位/);
  assert.ok(after.includes(`1. ${new Date(brotherJoined).toISOString()} 加入`), "roster renumbers after a kick");
  // Invalid ordinals and non-numbers change nothing.
  for (const bad of ["/kick 0", "/kick 2", "/kick -1", "/kick x", "/kick"]) {
    assert.match((await agent.chat(message(bad))).text, /无效的序号/, `${bad} is rejected`);
  }
  assert.deepEqual(Object.keys(f.state().members), [hash("brother")]);
  // Kicking also invalidated the invite: the code still sitting in the kicked member's
  // WeChat history must not silently re-admit her — nor anyone else.
  assert.equal((await agent.chat(message(code, "sister"))).text, "未授权", "kicked member cannot re-join with the old code");
  assert.equal((await agent.chat(message(code, "outsider"))).text, "未授权", "the invalidated code is dead for everyone");
  // A fresh code admits new members again.
  const fresh = await inviteCode(agent);
  assert.match((await agent.chat(message(fresh, "cousin"))).text, /欢迎加入/);
  await agent.close();
});

test("kick is not erasure: a re-invited member resumes their own workspace and session", async t => {
  const f = fixture(t);
  const agent = f.make();
  await f.claim(agent);
  const first = await inviteCode(agent);
  assert.match((await agent.chat(message(first, "sister"))).text, /欢迎加入/);
  await agent.chat(message("remember this", "sister"));
  const id = f.sessions[0].id;
  const workspace = f.sessions[0].cwd;
  writeFileSync(join(workspace, "MEMORY.md"), "- sister 的私事\n");
  await agent.chat(message("/kick 1"));
  assert.equal((await agent.chat(message("hello", "sister"))).text, "未授权");
  // Rejoin with a fresh code: the same conversation mapping and memory come back.
  const second = await inviteCode(agent);
  assert.match((await agent.chat(message(second, "sister"))).text, /欢迎加入/);
  assert.match((await agent.chat(message("back", "sister"))).text, /reply:back/);
  assert.equal(f.sessions.at(-1).id, id, "exact session identity is restored");
  assert.equal(readFileSync(join(workspace, "MEMORY.md"), "utf8"), "- sister 的私事\n");
  await agent.close();
});

test("a kicked member's queued chat never runs and their dream is not scheduled", async t => {
  const f = fixture(t);
  const agent = f.make();
  await f.claim(agent);
  const code = await inviteCode(agent);
  await agent.chat(message(code, "sister"));
  f.setNow(f.now + 60_000); // distinct join times keep /members ordinals deterministic
  await agent.chat(message(code, "brother"));
  await agent.chat(message("sister facts", "sister"));
  await agent.chat(message("brother facts", "brother"));
  const sister = f.sessions[0];
  const brother = f.sessions[1];
  // Hold the FIFO with the owner's gated chat; sister queues behind it, then is kicked.
  await agent.chat(message("owner warmup"));
  const owner = f.sessions.at(-1);
  owner.gate = deferred();
  owner.started = deferred();
  const ownerRun = agent.chat(message("slow"));
  await owner.started.promise;
  const queued = agent.chat(message("never mind", "sister"));
  await agent.chat(message("/kick 1")); // sister joined first
  owner.gate.resolve();
  await ownerRun;
  assert.deepEqual(await queued, {}, "queued chat of a kicked member must not run");
  assert.ok(!sister.calls.some(call => call.includes("never mind")), "no prompt ever reached Pi");
  // Dreams are owner/member-scoped: only brother's pending activity is reflected.
  f.setNow(new Date(2026, 9, 16, 4).getTime());
  await agent.dream();
  assert.ok(!sister.calls.some(call => call === DREAM_PROMPT), "kicked member gets no dream");
  assert.deepEqual(brother.calls.filter(call => call === DREAM_PROMPT), [DREAM_PROMPT]);
  await agent.close();
});

test("members get fully isolated workspaces, media and MEMORY", async t => {
  const f = fixture(t);
  const agent = f.make();
  await f.claim(agent);
  const code = await inviteCode(agent);
  await agent.chat(message(code, "sister"));
  await agent.chat(message(code, "brother"));
  await agent.chat(message("hi", "sister"));
  await agent.chat(message("hi", "brother"));
  const sister = f.sessions[0];
  const brother = f.sessions[1];
  assert.notEqual(sister.cwd, brother.cwd);
  assert.equal(sister.cwd, join(f.dataDir, "conversations", hash("sister")));
  assert.equal(brother.cwd, join(f.dataDir, "conversations", hash("brother")));
  // Inbound media lands only in the sender's own workspace.
  writeFileSync(join(f.dataDir, "shared.pdf"), "PDF");
  await agent.chat({
    conversationId: "sister", text: "看文件",
    media: { type: "file", filePath: join(f.dataDir, "shared.pdf"), mimeType: "application/pdf", fileName: "shared.pdf" },
  });
  assert.ok(existsSync(join(sister.cwd, "media", "shared.pdf")));
  assert.ok(!existsSync(join(brother.cwd, "media", "shared.pdf")));
  // Memory writes verify and persist per member; each store holds only its own facts.
  sister.run = async () => {
    writeFileSync(join(sister.cwd, "MEMORY.md"), "- sister 的私事\n");
    return "记好了。\nMEMORY_SAVED: sister 的私事";
  };
  brother.run = async () => {
    writeFileSync(join(brother.cwd, "MEMORY.md"), "- brother 的私事\n");
    return "记好了。\nMEMORY_SAVED: brother 的私事";
  };
  assert.match((await agent.chat(message("记住我的私事", "sister"))).text, /记好了。/);
  assert.match((await agent.chat(message("记住我的私事", "brother"))).text, /记好了。/);
  assert.equal(readMemoryStore(sister.cwd).index, "- sister 的私事\n");
  assert.equal(readMemoryStore(brother.cwd).index, "- brother 的私事\n");
  assert.ok(!readMemoryStore(brother.cwd).index.includes("sister"), "no cross-member memory reads");
  // The owner's workspace is a third, separate space.
  await agent.chat(message("owner hi"));
  const owner = f.sessions.at(-1);
  assert.ok(![sister.cwd, brother.cwd].includes(owner.cwd));
  await agent.close();
});

test("/stop only aborts the sender's own session: another member's running task is untouched", async t => {
  const f = fixture(t);
  const agent = f.make();
  await f.claim(agent);
  const code = await inviteCode(agent);
  await agent.chat(message(code, "sister"));
  await agent.chat(message("warmup", "sister"));
  const sister = f.sessions.at(-1);
  // Sister's long task is mid-run on the FIFO; the owner (no session of their own) /stops.
  sister.gate = deferred();
  sister.started = deferred();
  const running = agent.chat(message("long task", "sister"));
  await sister.started.promise;
  const ownerStop = await agent.chat(message("/stop"));
  assert.match(ownerStop.text, /没有正在运行的会话/);
  assert.equal(sister.abortCalls, 0, "owner /stop must not abort a member's session");
  sister.gate.resolve();
  assert.equal((await running).text, "reply:long task", "the member's task completed normally");
  // Reverse direction: a member /stops while the OWNER's task runs; only her own (idle) session is aborted.
  await agent.chat(message("owner warmup"));
  const owner = f.sessions.at(-1);
  owner.gate = deferred();
  owner.started = deferred();
  const ownerRun = agent.chat(message("owner long task"));
  await owner.started.promise;
  const memberStop = await agent.chat(message("/stop", "sister"));
  assert.match(memberStop.text, /已请求中止/);
  assert.equal(owner.abortCalls, 0, "member /stop must not abort the owner's session");
  assert.equal(sister.abortCalls, 1, "member /stop aborted only her own session");
  owner.gate.resolve();
  assert.equal((await ownerRun).text, "reply:owner long task");
  // Dream-abort semantics are preserved and equally self-scoped: her own dream, not others'.
  f.setNow(new Date(2026, 9, 16, 4).getTime());
  sister.gate = deferred();
  sister.started = deferred();
  const dream = agent.dream();
  await sister.started.promise;
  assert.equal(sister.calls.at(-1), DREAM_PROMPT);
  const stop = await agent.chat(message("/stop", "sister"));
  assert.match(stop.text, /已请求中止/);
  assert.equal(sister.abortCalls, 2, "own dream is still abortable");
  sister.gate.resolve();
  await dream;
  assert.equal(owner.abortCalls, 0);
  await agent.close();
});

test("live v2 deployment upgrades in place: pre-v3 state.json loads with an empty roster", async t => {
  const f = fixture(t);
  const ownerKey = hash("owner");
  const v2 = {
    version: 1, owner: ownerKey, claim: null,
    conversations: {
      [ownerKey]: {
        sessionId: "496130d1-bc15-4ef3-904f-337187e6ba1e", started: true, activity: 17,
        reflectedActivity: 0, pendingSince: 1792192136031, lastDreamSuccess: 0, lastDreamAttempt: 0,
      },
    },
  };
  writeFileSync(join(f.dataDir, "state.json"), `${JSON.stringify(v2, null, 2)}\n`);
  let state = readState(f.dataDir);
  assert.deepEqual(state.members, {});
  assert.equal(state.invite, null);
  assert.equal(state.owner, ownerKey);
  // Everything keeps working for the owner; the first save writes the additive fields.
  const agent = f.make();
  assert.equal((await agent.chat(message("hello"))).text, "reply:hello");
  state = f.state();
  assert.deepEqual(state.members, {});
  assert.equal(state.invite, null);
  assert.match((await agent.chat(message("/members"))).text, /还没有成员/);
  const code = await inviteCode(agent);
  assert.match((await agent.chat(message(code, "sister"))).text, /欢迎加入/);
  assert.deepEqual(f.state().members, { [hash("sister")]: { joinedAt: f.now } });
  await agent.close();
});

test("restart survives member and ex-member conversation records (multi-user state)", async t => {
  const f = fixture(t);
  let agent = f.make();
  await f.claim(agent);
  const code = await inviteCode(agent);
  await agent.chat(message(code, "sister"));
  f.setNow(f.now + 60_000);
  await agent.chat(message(code, "brother"));
  await agent.chat(message("sister facts", "sister"));
  const sisterId = f.sessions[0].id;
  await agent.chat(message("brother facts", "brother"));
  const brotherId = f.sessions[1].id;
  // Kick sister, close, restart: her lingering record must not brick readState.
  await agent.chat(message("/kick 1")); // sister joined first
  await agent.close();
  agent = f.make();
  // Kicking invalidated the invite before the restart; a restart must not resurrect it.
  assert.equal((await agent.chat(message(code, "cousin"))).text, "未授权");
  const fresh = await inviteCode(agent);
  assert.match((await agent.chat(message(fresh, "cousin"))).text, /欢迎加入/);
  assert.match((await agent.chat(message("hello", "brother"))).text, /reply:hello/);
  assert.equal(f.sessions.at(-1).id, brotherId, "member session identity restored across restart");
  assert.equal((await agent.chat(message("hello", "sister"))).text, "未授权");
  // Re-invite after restart: sister's exact session comes back from her kept record.
  const second = await inviteCode(agent);
  await agent.chat(message(second, "sister"));
  assert.match((await agent.chat(message("back", "sister"))).text, /reply:back/);
  assert.equal(f.sessions.at(-1).id, sisterId);
  await agent.close();
});

test("v3 state fields are strictly validated; corrupt rosters refuse to start", t => {
  const f = fixture(t);
  const ownerKey = hash("owner");
  const base = {
    version: 1, owner: ownerKey, claim: null, conversations: {},
    members: { [hash("sister")]: { joinedAt: 1 } },
    invite: null,
  };
  const bad = [
    { members: [] },
    { members: { zz: { joinedAt: 1 } } },
    { members: { [hash("sister")]: {} } },
    { members: { [hash("sister")]: { joinedAt: -1 } } },
    { members: { [hash("sister")]: { joinedAt: "yesterday" } } },
    { members: { [hash("sister")]: 5 } },
    { members: { [ownerKey]: { joinedAt: 1 } } },
    { invite: { hash: "nothex", expiresAt: 1 } },
    { invite: { hash: hash("x") } },
    { invite: { hash: hash("x"), expiresAt: -2 } },
    { invite: "open sesame" },
    // A roster without an owner is impossible through any API path (joins require a
    // claimed owner) and must refuse to load; an empty roster on an unclaimed
    // deployment is normal and stays valid.
    { owner: null, members: { [hash("sister")]: { joinedAt: 1 } } },
  ];
  for (const patch of bad) {
    writeFileSync(join(f.dataDir, "state.json"), JSON.stringify({ ...base, ...patch }));
    assert.throws(() => readState(f.dataDir), /Invalid state/, JSON.stringify(patch));
  }
  // Absent fields default (additive migration); null invite and empty roster are valid.
  writeFileSync(join(f.dataDir, "state.json"), JSON.stringify({ version: 1, owner: ownerKey, claim: null, conversations: {} }));
  const migrated = readState(f.dataDir);
  assert.deepEqual(migrated.members, {});
  assert.equal(migrated.invite, null);
});

test("management command parsing: /invite, /members, /kick", () => {
  assert.deepEqual(parseCommand("/invite"), { command: "invite", args: "" });
  assert.deepEqual(parseCommand("  /Members  "), { command: "members", args: "" });
  assert.deepEqual(parseCommand("/kick 2"), { command: "kick", args: "2" });
  assert.deepEqual(parseCommand("/KICK  3 "), { command: "kick", args: "3" });
  assert.equal(parseCommand("/invited"), null);
  assert.equal(parseCommand("/membership"), null);
  assert.equal(parseCommand("/kicked"), null);
});
