import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** MEMORY.md is the injected index; detail lives in memory/<topic>.md (read on demand). */
export const MEMORY_INDEX_FILE = "MEMORY.md";
export const MEMORY_DIR = "memory";
/** Soft cap for the index, mirroring Claude Code's "keep the index small" guidance. */
export const MEMORY_INDEX_MAX_LINES = 150;

export interface MemoryStore {
  /** MEMORY.md contents, or null when the file does not exist. */
  index: string | null;
  /** memory/<name>.md contents keyed by file name. */
  topics: Record<string, string>;
}

/** Read the two-tier memory store from a conversation workspace. Never throws. */
export function readMemoryStore(cwd: string): MemoryStore {
  let index: string | null = null;
  try { index = readFileSync(join(cwd, MEMORY_INDEX_FILE), "utf8"); } catch { index = null; }
  const topics: Record<string, string> = {};
  const dir = join(cwd, MEMORY_DIR);
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".md")) continue;
      try { topics[name] = readFileSync(join(dir, name), "utf8"); } catch { /* unreadable topic behaves as absent */ }
    }
  } catch { /* missing, not-a-directory, or unreadable memory/ behaves as no topics */ }
  return { index, topics };
}

const normalize = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();

/** True when the fact (whitespace/case-insensitive) appears in the index or a topic file. */
export function factInStore(store: MemoryStore, fact: string): boolean {
  const needle = normalize(fact);
  if (!needle) return false;
  const haystacks = [store.index ?? "", ...Object.values(store.topics)].map(normalize);
  return haystacks.some(text => text.includes(needle));
}

/** True when two stores have identical index text and identical topic files (content-wise). */
export function sameMemoryStore(a: MemoryStore, b: MemoryStore): boolean {
  if (a.index !== b.index) return false;
  const names = Object.keys(a.topics).sort();
  const other = Object.keys(b.topics).sort();
  if (names.length !== other.length) return false;
  return names.every((name, i) => name === other[i] && a.topics[name] === b.topics[name]);
}

/** Non-empty line count of the index; used to surface an over-cap index. */
export function indexLineCount(index: string | null): number {
  if (index === null) return 0;
  return index.split("\n").filter(line => line.trim().length > 0).length;
}
