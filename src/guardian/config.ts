import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Loads config/intervention.json once per process. The guardian reads it at
// start-up, so edits take effect on restart. With demo.enabled, demo.overrides
// is deep-merged over the base values.

export type Group = "entertainment" | "productive" | "leisure" | "neutral" | "unclassified";

export type GuardianConfig = {
  groups: {
    mapping: Record<string, Group>;
    exerciseCategories: string[];
    watchingSubcategories: string[];
  };
  day: { startHour: number };
  idle: { noInputMinutes: number; heartbeatStaleSeconds: number; lockApps: string[] };
  streak: { resetProductiveMinutes: number; resetNonEntertainmentMinutes: number };
  rules: {
    R1: {
      dayMinutes: number; nightMinutes: number; nightStartHour: number; nightEndHour: number;
      graceSeconds: number; reopenWindowMinutes: number; reopenGraceSeconds: number;
    };
    R2: {
      deficitRatio: number; enoughRatio: number; graceSeconds: number; cooldownMinutes: number; rewarnGraceSeconds: number;
      baselineDays: number; minActiveMinutesPerDay: number;
    };
    R3: { thresholdMinutes: number; repeatMinutes: number };
  };
  workspace: {
    recentFileDays: number; maxFiles: number; maxDomains: number; hourWindow: number;
    docExtensions: string[]; defaults: string[];
  };
  privacy: { rawRetentionDays: number; minuteRetentionDays: number; sensitiveDomains: string[] };
  pause: { presets: string[]; maxMinutes: number };
  webhook: { maxPerMinute: number; maxPerDay: number };
  demo: { enabled: boolean; overrides: Record<string, unknown> };
};

const GROUPS: readonly Group[] = ["entertainment", "productive", "leisure", "neutral", "unclassified"];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.resolve(__dirname, "../../config/intervention.json");

let cached: GuardianConfig | null = null;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Recursively merges `over` into `base` (objects merge, everything else replaces). */
function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] = isObject(b) && isObject(v) ? deepMerge(b, v) : v;
  }
  return out;
}

/** Drops "_comment" keys at any depth. */
function stripComments(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripComments);
  if (!isObject(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) if (k !== "_comment") out[k] = stripComments(val);
  return out;
}

function validate(cfg: GuardianConfig): void {
  for (const [category, group] of Object.entries(cfg.groups.mapping)) {
    if (!GROUPS.includes(group)) throw new Error(`intervention.json: unknown group "${group}" for "${category}"`);
  }
  if (cfg.day.startHour < 0 || cfg.day.startHour > 23) throw new Error("intervention.json: day.startHour must be 0-23");
}

export function loadConfig(file = CONFIG_PATH): GuardianConfig {
  const raw = stripComments(JSON.parse(fs.readFileSync(file, "utf8"))) as Record<string, unknown>;
  const demo = isObject(raw["demo"]) ? raw["demo"] : {};
  // GUARDIAN_DEMO=1 turns demo mode on without editing the tracked config file.
  const demoOn = demo["enabled"] === true || process.env["GUARDIAN_DEMO"] === "1";
  const merged = demoOn && isObject(demo["overrides"])
    ? deepMerge({ ...raw, demo: { ...demo, enabled: true } }, demo["overrides"])
    : raw;
  const cfg = merged as unknown as GuardianConfig;
  validate(cfg);
  return cfg;
}

export function getConfig(): GuardianConfig {
  if (!cached) cached = loadConfig();
  return cached;
}

/** Test hook: use an explicit config instead of the file. */
export function setConfig(cfg: GuardianConfig): void {
  cached = cfg;
}
