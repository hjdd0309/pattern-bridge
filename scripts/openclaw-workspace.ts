/**
 * Copies the agent instruction files kept in this repo (openclaw/workspace/)
 * into OpenClaw's workspace, where OpenClaw reads them at every session start.
 * The repo is the source of truth; OpenClaw's workspace also holds personal
 * data it writes itself (memory, dream diary), which stays out of the repo.
 *
 * An existing file that differs is kept as <name>.bak first. Restart the
 * Gateway afterwards (openclaw gateway restart) so new sessions pick it up.
 *
 * Usage: npm run openclaw:workspace [-- --dry-run]
 * Target: $OPENCLAW_WORKSPACE, else ~/.openclaw/workspace
 */
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const FILES = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"];

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, "../openclaw/workspace");
const target = process.env["OPENCLAW_WORKSPACE"] || path.join(os.homedir(), ".openclaw", "workspace");
const dryRun = process.argv.includes("--dry-run");

if (!fs.existsSync(target)) {
  console.error(`OpenClaw workspace not found: ${target} (set OPENCLAW_WORKSPACE or run OpenClaw onboarding first)`);
  process.exit(1);
}

for (const name of FILES) {
  const from = path.join(source, name);
  const to = path.join(target, name);
  const next = fs.readFileSync(from);
  const current = fs.existsSync(to) ? fs.readFileSync(to) : null;
  if (current && current.equals(next)) {
    console.log(`same     ${name}`);
    continue;
  }
  if (dryRun) {
    console.log(`would ${current ? "update" : "add   "} ${name}`);
    continue;
  }
  if (current) fs.writeFileSync(`${to}.bak`, current);
  fs.writeFileSync(to, next);
  console.log(`${current ? "updated" : "added  "} ${name}${current ? ` (previous kept as ${name}.bak)` : ""}`);
}
if (!dryRun) console.log("Restart the Gateway so new sessions use these files: openclaw gateway restart");
