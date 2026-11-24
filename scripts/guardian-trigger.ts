/**
 * Demo aid: asks the running guardian to evaluate a rule on its next minute
 * tick instead of waiting (R2 normally runs only on the hour).
 *
 *   npm run guardian:trigger -- R2           check R2 now (fires only if productive time is short)
 *   npm run guardian:trigger -- R2 --force   fire R2 now regardless of today's productive time
 *
 * Works only when demo mode is on (config/intervention.json → demo.enabled).
 */
import { loadConfig } from "../src/guardian/config.js";
import { setState } from "../src/guardian/state.js";

const rule = process.argv[2];
const force = process.argv.includes("--force");

if (!loadConfig().demo.enabled) {
  console.error("demo mode is off: set demo.enabled to true in config/intervention.json and restart the guardian");
  process.exit(1);
}
if (rule !== "R2") {
  console.error("usage: npm run guardian:trigger -- R2 [--force]");
  process.exit(1);
}
setState("triggerR2", { force });
console.log(`R2 will be evaluated on the guardian's next minute tick${force ? " (forced)" : ""}`);
