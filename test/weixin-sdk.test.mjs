import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

/**
 * Source-shape drift canary for the pinned transport SDK. These properties are load
 * bearing for the bridge's documented behavior:
 *  (a) the monitor persists the get_updates cursor BEFORE dispatching messages
 *      (at-most-once: a crash loses messages but never replays them), and
 *  (b) context tokens are stored per SENDER while Bot.sendMessage reads the account
 *      holder's key (only the deployer's own inbound warms the push channel).
 * Cheap string probes against the installed dist, skipped loudly when the version
 * moves so a human re-verifies ordering/keying instead of chasing reshuffled code.
 */
const PINNED = "0.5.0";
const root = resolve("node_modules", "weixin-agent-sdk");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const dist = readFileSync(join(root, "dist", "index.mjs"), "utf8");

test(`weixin-agent-sdk@${version}: cursor persisted before dispatch; context tokens keyed per sender`, {
  skip: version !== PINNED && `source probe written for ${PINNED}; re-verify cursor-before-dispatch and per-sender token keying after the upgrade`,
}, () => {
  const saved = dist.indexOf("saveGetUpdatesBuf(syncFilePath");
  const dispatched = dist.indexOf("await processOneMessage(full");
  assert.ok(saved !== -1, "saveGetUpdatesBuf(syncFilePath...) must still exist in the dist");
  assert.ok(dispatched !== -1, "the processOneMessage dispatch loop must still exist in the dist");
  assert.ok(saved < dispatched, "the sync cursor must be persisted before the dispatch loop starts");
  assert.ok(dist.includes("setContextToken(deps.accountId, full.from_user_id"), "inbound context tokens must be stored per sender");
  assert.ok(dist.includes("getContextToken(this._accountId, this._userId)"), "Bot.sendMessage must read the account holder's token key");
});
