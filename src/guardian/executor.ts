import type { Intervention } from "./interventions.js";

// Performs an intervention's action (close entertainment tabs, open the
// productive workspace, show/hide the countdown banner).
//
// The real implementation (Chrome extension over WebSocket, PowerShell)
// arrives in step 4. Until then a logging executor stands in, so the rule
// flow can run end to end.

export type ExecutionResult = { ok: boolean; detail: Record<string, unknown> };

export interface Executor {
  /** Countdown banner on the trigger tabs. */
  showBanner(it: Intervention, secondsLeft: number): Promise<void>;
  hideBanner(it: Intervention): Promise<void>;
  /** The action itself (R1: close entertainment tabs, R2: focus mode). */
  execute(it: Intervention): Promise<ExecutionResult>;
}

export class LoggingExecutor implements Executor {
  async showBanner(it: Intervention, secondsLeft: number): Promise<void> {
    console.log(`[executor:log] banner on for #${it.id} ${it.rule} (${secondsLeft}s)`);
  }

  async hideBanner(it: Intervention): Promise<void> {
    console.log(`[executor:log] banner off for #${it.id} ${it.rule}`);
  }

  async execute(it: Intervention): Promise<ExecutionResult> {
    console.log(`[executor:log] would execute #${it.id} ${it.rule}`);
    return { ok: true, detail: { simulated: true } };
  }
}

let current: Executor = new LoggingExecutor();

export function getExecutor(): Executor {
  return current;
}

export function setExecutor(e: Executor): void {
  current = e;
}
