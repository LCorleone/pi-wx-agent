import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const entry = resolve("dist/main.js");
test("offline CLI help, claim, absolute data resolution, and clear model startup failure", t => {
  const root = mkdtempSync(join(tmpdir(), "pi-wx-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = join(root, "config.json");
  writeFileSync(config, JSON.stringify({ dataDir: "state", model: { provider: "missing-offline-provider", id: "none" }, dream: { enabled: false, hour: 3 } }));
  const env = { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: join(root, "pi"), OPENCLAW_STATE_DIR: join(root, "wrong") };
  const run = args => spawnSync(process.execPath, [entry, ...args], { cwd: root, env, encoding: "utf8", timeout: 15_000 });
  const help = run(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);
  const claim = run(["claim", "--config", config]);
  assert.equal(claim.status, 0, claim.stderr);
  const code = claim.stdout.match(/OWNER_CODE=([a-f0-9]{32})/)[1];
  const state = readFileSync(join(root, "state", "state.json"), "utf8");
  assert.ok(!state.includes(code), "raw claim secret is never stored");
  const startup = run(["start", "--config", config]);
  assert.equal(startup.status, 1);
  assert.match(startup.stderr, /No available configured Pi model/);
  assert.doesNotMatch(startup.stdout, /二维码|OWNER_CODE/);
});
