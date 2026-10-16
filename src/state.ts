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
}
export interface State {
  version: 1;
  owner: string | null;
  claim: { hash: string; expires: number; attempts: number } | null;
  conversations: Record<string, Conversation>;
}
export const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const isTime = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

export function readState(dataDir: string): State {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = join(dataDir, "state.json");
  if (!existsSync(file)) return { version: 1, owner: null, claim: null, conversations: {} };
  const s = JSON.parse(readFileSync(file, "utf8")) as State;
  if (!s || s.version !== 1 || !(s.owner === null || (typeof s.owner === "string" && /^[a-f0-9]{64}$/.test(s.owner))) ||
      !(s.claim === null || (s.claim && /^[a-f0-9]{64}$/.test(s.claim.hash) && isTime(s.claim.expires) &&
        Number.isInteger(s.claim.attempts) && s.claim.attempts >= 0 && s.claim.attempts <= 5)) ||
      !s.conversations || typeof s.conversations !== "object" || Array.isArray(s.conversations) ||
      Object.entries(s.conversations).some(([key, c]) => !/^[a-f0-9]{64}$/.test(key) || key !== s.owner ||
        !c || typeof c.sessionId !== "string" || !/^[a-f0-9-]{36}$/.test(c.sessionId) || typeof c.started !== "boolean" ||
        ![c.activity, c.reflectedActivity, c.pendingSince, c.lastDreamSuccess].every(isTime) || c.reflectedActivity > c.activity) ||
      (s.owner !== null && s.claim !== null)) {
    throw new Error("Invalid state.json; refusing to reset authorization or sessions. Restore a backup.");
  }
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
