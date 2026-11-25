/**
 * Demo aid for R2 on the guardian's next minute tick.
 *
 *   npm run guardian:trigger -- R2           check R2 as usual, and log why it did or did not fire
 *   npm run guardian:trigger -- R2 --force   fire R2 regardless of productive time, cooldown and
 *                                            what the user is doing (except exercising)
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
