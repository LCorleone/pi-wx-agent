import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Conversation {
  sessionId: string;
  started: boolean;
  activity: number;
  reflectedActivity: number;
  pendingSince: number;
  lastDreamSuccess: number;
  /** When the last dream ATTEMPT started (success or failure); 0 before the first attempt. */
  lastDreamAttempt: number;
}
/** An invited family member keyed by hash(conversationId); additive v3 field. */
export interface Member {
  /** When the member joined via an invite code, in epoch ms. */
  joinedAt: number;
}
export interface State {
  version: 1;
  owner: string | null;
  claim: { hash: string; expires: number; attempts: number } | null;
  /** Additive v3 field; pre-v3 files default to an empty roster. */
  members: Record<string, Member>;
  /** Active invite; additive v3 field, null (or absent in old files) when none. */
  invite: { hash: string; expiresAt: number } | null;
  conversations: Record<string, Conversation>;
}
export const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const isTime = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isHashKey = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);

export function readState(dataDir: string): State {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = join(dataDir, "state.json");
  if (!existsSync(file)) return { version: 1, owner: null, claim: null, members: {}, invite: null, conversations: {} };
  const s = JSON.parse(readFileSync(file, "utf8")) as State;
  if (!s || s.version !== 1 || !(s.owner === null || (typeof s.owner === "string" && /^[a-f0-9]{64}$/.test(s.owner))) ||
      !(s.claim === null || (s.claim && /^[a-f0-9]{64}$/.test(s.claim.hash) && isTime(s.claim.expires) &&
        Number.isInteger(s.claim.attempts) && s.claim.attempts >= 0 && s.claim.attempts <= 5)) ||
      !(s.members === undefined || (s.members && typeof s.members === "object" && !Array.isArray(s.members) &&
        Object.entries(s.members).every(([key, m]) => isHashKey(key) && key !== s.owner &&
          m !== null && typeof m === "object" && isTime(m.joinedAt)))) ||
      !(s.invite === undefined || s.invite === null || (s.invite && /^[a-f0-9]{64}$/.test(s.invite.hash) &&
        isTime(s.invite.expiresAt))) ||
      // Members can only ever join after an owner claimed; a roster without an owner is
      // hand-edited or corrupt, and an empty roster on an unclaimed deployment is normal.
      (s.owner === null && s.members !== undefined && Object.keys(s.members).length > 0) ||
      !s.conversations || typeof s.conversations !== "object" || Array.isArray(s.conversations) ||
      // v3: keys are validated as hashes only. Membership is dynamic (members can be
      // kicked while their conversation record remains for a later re-invite), so
      // ownership of a stored conversation is enforced at ACCESS time (authorized()/
      // keyAuthorized()), not at load time.
      Object.entries(s.conversations).some(([key, c]) => !isHashKey(key) ||
        !c || typeof c.sessionId !== "string" || !/^[a-f0-9-]{36}$/.test(c.sessionId) || typeof c.started !== "boolean" ||
        ![c.activity, c.reflectedActivity, c.pendingSince, c.lastDreamSuccess].every(isTime) ||
        !(c.lastDreamAttempt === undefined || isTime(c.lastDreamAttempt)) || c.reflectedActivity > c.activity) ||
      (s.owner !== null && s.claim !== null)) {
    throw new Error("Invalid state.json; refusing to reset authorization or sessions. Restore a backup.");
  }
  // Additive v2 field: accept pre-v2 state.json files and default the missing marker to 0.
  for (const c of Object.values(s.conversations)) if (c.lastDreamAttempt === undefined) c.lastDreamAttempt = 0;
  // Additive v3 fields: pre-v3 files have no member roster and no active invite.
  if (s.members === undefined) s.members = {};
  if (s.invite === undefined) s.invite = null;
  return s;
}

/** Atomic rename on the same filesystem; fsync the file and directory on supported Node/Linux. */
export function writeState(dataDir: string, state: State): void {
  const file = join(dataDir, "state.json");
  const temp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(temp, file);
  const dir = openSync(dirname(file), "r");
  try { fsyncSync(dir); } finally { closeSync(dir); }
}
