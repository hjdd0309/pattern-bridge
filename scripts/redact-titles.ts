/**
 * Applies today's title / local-file rules to events recorded before them.
 *
 *   - window_focus: titles outside browsers are removed, a browser showing a
 *     local document keeps only the extension (src/collector/title-privacy.ts)
 *   - browser_tab / browser_url / browser_visit with a file:// URL: the URL
 *     becomes file:///local.<ext> and the title is cleared (browser-monitor.ts)
 *
 * Running it again changes nothing. Afterwards the file is VACUUMed so the old
 * text does not linger in free pages; stop the collector and guardian first.
 *
 * Usage: npm run redact-titles [-- --dry-run]
 */
import { getDb } from "../src/db/schema.js";
import { localPlaceholder } from "../src/collector/browser-monitor.js";
import { storableTitle } from "../src/collector/title-privacy.js";

type Row = { id: number; action: string; metadata: string };

const dryRun = process.argv.includes("--dry-run");
const db = getDb();
const update = db.prepare("UPDATE user_events SET metadata = ? WHERE id = ?");
const counts = { windowTitles: 0, localFiles: 0 };

const rows = db.prepare(`
  SELECT id, action, metadata FROM user_events
  WHERE (action = 'window_focus' AND json_extract(metadata, '$.title') IS NOT NULL)
     OR (action IN ('browser_tab', 'browser_url', 'browser_visit') AND json_extract(metadata, '$.url') LIKE 'file:%')
`).all() as Row[];

db.transaction(() => {
  for (const row of rows) {
    const m = JSON.parse(row.metadata) as Record<string, unknown>;
    if (row.action === "window_focus") {
      const before = m["title"];
      const after = storableTitle(String(m["app"] ?? ""), String(before ?? ""));
      if (after === before) continue;
      if (after === undefined) delete m["title"];
      else m["title"] = after;
      counts.windowTitles++;
    } else {
      const url = String(m["url"]);
      const placeholder = localPlaceholder(url);
      if (url === placeholder && !m["title"]) continue;
      m["url"] = placeholder;
      m["title"] = "";
      counts.localFiles++;
    }
    if (!dryRun) update.run(JSON.stringify(m), row.id);
  }
})();

console.log(`${dryRun ? "[dry-run] would change" : "changed"}: window titles ${counts.windowTitles}, local file URLs ${counts.localFiles}`);

if (!dryRun && counts.windowTitles + counts.localFiles > 0) {
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.exec("VACUUM");
    console.log("vacuumed");
  } catch (err) {
    console.warn(`VACUUM skipped (${err instanceof Error ? err.message : String(err)}); stop the collector and guardian, then run again`);
  }
}
