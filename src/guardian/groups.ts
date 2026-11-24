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

export function isChromeApp(app: string | null | undefined): boolean {
  return !!app && /chrome/i.test(app);
}

export function isLockApp(cfg: GuardianConfig, app: string | null | undefined): boolean {
  return !!app && cfg.idle.lockApps.some((name) => app.toLowerCase().includes(name.toLowerCase()));
}
