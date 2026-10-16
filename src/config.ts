import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface Config {
  dataDir: string;
  model: { provider: string; id: string } | null;
  dream: { enabled: boolean; hour: number };
}

export function loadConfig(file: string): Config {
  const path = resolve(file);
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !["dataDir", "model", "dream"].includes(key)) ||
      typeof value.dataDir !== "string" || !value.dataDir.trim() ||
      !(value.model === null || (value.model && typeof value.model.provider === "string" &&
        value.model.provider.trim() && typeof value.model.id === "string" && value.model.id.trim() &&
        Object.keys(value.model).every(key => ["provider", "id"].includes(key)))) ||
      !value.dream || typeof value.dream.enabled !== "boolean" ||
      !Number.isInteger(value.dream.hour) || value.dream.hour < 0 || value.dream.hour > 23 ||
      Object.keys(value.dream).some(key => !["enabled", "hour"].includes(key))) {
    throw new Error("Invalid config: expected dataDir, model: null or {provider,id}, dream: {enabled,hour:0..23}");
  }
  return { ...value, dataDir: resolve(dirname(path), value.dataDir) };
}
