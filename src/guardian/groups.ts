import type { GuardianConfig, Group } from "./config.js";

// Category (fact, set by the collector) → intervention group (policy).

export type MinuteGroup = Group | "idle";

export function groupOf(cfg: GuardianConfig, category: string | null | undefined): Group {
  if (!category) return "unclassified";
  return cfg.groups.mapping[category] ?? "unclassified";
}

/** Exercise is a leisure-group activity that is left out of R3 and counts like productive for streak resets. */
export function isExercise(cfg: GuardianConfig, category: string | null | undefined): boolean {
  return !!category && cfg.groups.exerciseCategories.includes(category);
}

/** "Watching" means no input is expected, so it is not idle: sound is playing or the content is video. */
export function isWatching(cfg: GuardianConfig, subcategory: string | null | undefined, audible: boolean): boolean {
  return audible || (!!subcategory && cfg.groups.watchingSubcategories.includes(subcategory));
}

/**
 * Chromium-based browser behind a window's app name, as the extension names
 * itself (see browser-extension/background.js), or null for other apps.
 * Order matters: Edge, Whale, Brave and Opera also contain "chrome" in some names.
 */
export function browserOfApp(app: string | null | undefined): string | null {
  if (!app) return null;
  if (/edge/i.test(app)) return "edge";
  if (/whale/i.test(app)) return "whale";
  if (/brave/i.test(app)) return "brave";
  if (/opera/i.test(app)) return "opera";
  if (/vivaldi/i.test(app)) return "vivaldi";
  if (/chrome|chromium/i.test(app)) return "chrome";
  return null;
}

export function isLockApp(cfg: GuardianConfig, app: string | null | undefined): boolean {
  return !!app && cfg.idle.lockApps.some((name) => app.toLowerCase().includes(name.toLowerCase()));
}
