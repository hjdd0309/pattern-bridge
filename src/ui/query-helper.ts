import { getDb } from "../db/schema.js";
import { calcAppTime } from "../collector/app-time.js";
import { getRecentNotifications, setNotificationFeedback } from "../analyzer/notification-log.js";

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

function recentNotifications() {
  return getRecentNotifications(30);
}

function setFeedback() {
  const id = Number(process.argv[3]);
  const feedback = process.argv[4];
  if (feedback !== 'correct' && feedback !== 'incorrect') {
    throw new Error(`invalid feedback value: ${feedback}`);
  }
  setNotificationFeedback(id, feedback);
  return { ok: true };
}

switch (queryType) {
  case 'app-stats':             console.log(JSON.stringify(appStats()));             break;
  case 'recent-events':         console.log(JSON.stringify(recentEvents()));         break;
  case 'patterns':               console.log(JSON.stringify(patterns()));             break;
  case 'recent-notifications':  console.log(JSON.stringify(recentNotifications()));  break;
  case 'set-feedback':          console.log(JSON.stringify(setFeedback()));          break;
  default:                      console.log('[]');
}
