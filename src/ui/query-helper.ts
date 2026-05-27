import { getDb } from "../db/schema.js";
import { calcAppTime } from "../collector/app-time.js";

const queryType = process.argv[2];

const db = getDb();

function appStats() {
  const stats = calcAppTime();
  return stats.slice(0, 5).map(s => ({
    app: s.app,
    durationMs: s.durationMs,
    sessions: s.sessions,
  }));
}

function recentEvents() {
  return db.prepare(`
    SELECT action, metadata, occurred_at
    FROM   user_events
    ORDER  BY occurred_at DESC
    LIMIT  50
  `).all() as { action: string; metadata: string; occurred_at: number }[];
}

function patterns() {
  const since = Date.now() - 7 * 86_400_000;
  return db.prepare(`
    SELECT pattern_type, score, payload, detected_at, notified
    FROM   detected_patterns
    WHERE  detected_at >= ?
    ORDER  BY detected_at DESC
  `).all(since) as {
    pattern_type: string; score: number; payload: string;
    detected_at: number; notified: number;
  }[];
}

switch (queryType) {
  case 'app-stats':      console.log(JSON.stringify(appStats()));      break;
  case 'recent-events':  console.log(JSON.stringify(recentEvents()));  break;
  case 'patterns':       console.log(JSON.stringify(patterns()));      break;
  default:               console.log('[]');
}
