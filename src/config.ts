import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export interface Config {
  dataDir: string;
  model: { provider: string; id: string } | null;
  dream: { enabled: boolean; hour: number };
  /** Optional Pi extension files loaded into bridge sessions (absolute, existing paths). */
  extensions?: string[];
  /** Optional flag values the loaded extensions can read via pi.getFlag (requires extensions). */
  extensionFlags?: Record<string, boolean | string>;
}

export function loadConfig(file: string): Config {
  const path = resolve(file);
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !["dataDir", "model", "dream", "extensions", "extensionFlags"].includes(key)) ||
      typeof value.dataDir !== "string" || !value.dataDir.trim() ||
      !(value.model === null || (value.model && typeof value.model.provider === "string" &&
        value.model.provider.trim() && typeof value.model.id === "string" && value.model.id.trim() &&
        Object.keys(value.model).every(key => ["provider", "id"].includes(key)))) ||
      !value.dream || typeof value.dream.enabled !== "boolean" ||
      !Number.isInteger(value.dream.hour) || value.dream.hour < 0 || value.dream.hour > 23 ||
      Object.keys(value.dream).some(key => !["enabled", "hour"].includes(key)) ||
      !(value.extensions === undefined || (Array.isArray(value.extensions) &&
        value.extensions.every((extension: unknown) => typeof extension === "string" && extension.trim() && isAbsolute(extension)))) ||
      !(value.extensionFlags === undefined || (typeof value.extensionFlags === "object" && !Array.isArray(value.extensionFlags) &&
        Object.entries(value.extensionFlags).every(([name, flag]: [string, unknown]) => name.trim() !== "" &&
          (typeof flag === "boolean" || typeof flag === "string"))))) {
    throw new Error("Invalid config: expected dataDir, model: null or {provider,id}, dream: {enabled,hour:0..23}, extensions?: string[] of absolute paths, extensionFlags?: { [name]: boolean | string }");
  }
  // Flags are only read by loaded extensions; without any they can never take effect.
  if (value.extensionFlags !== undefined && !(Array.isArray(value.extensions) && value.extensions.length > 0)) {
    throw new Error("Invalid config: extensionFlags requires a non-empty extensions list");
  }
  // Fail loud at startup: a listed extension that is missing means a silent capability gap otherwise.
  for (const extension of value.extensions ?? []) {
    if (!existsSync(extension)) throw new Error(`Invalid config: extensions path does not exist: ${extension}`);
  }
  return { ...value, dataDir: resolve(dirname(path), value.dataDir) };
}
