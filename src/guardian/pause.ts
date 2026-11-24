import { getState } from "./state.js";

// The user's "pause interventions" switch, stored in guardian_state so every
// entry point (extension popup, CLI, Discord) shares it. Commands that set it
// come in later steps; the rules only need to read it.

export type PauseState = {
  since: number;
  /** null = until the user resumes. */
  until: number | null;
  source: string;
};

export function getPause(): PauseState | null {
  return getState<PauseState>("pause");
}

export function isPaused(now: number): boolean {
  const p = getPause();
  if (!p) return false;
  return p.until === null || now < p.until;
}
