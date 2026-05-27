'use strict';

// ── State ──────────────────────────────────────────────────────────────────

let logLines = [];
const MAX_LOG = 300;

// Guard: true while init() is running.
// Prevents the toggle's change handler from calling PM2 commands
// when updateCollectionUI() sets .checked programmatically.
// (Setting .checked via JS normally does NOT fire 'change', but this is
// an explicit safety net per requirement: toggle must never auto-stop PM2.)
let initializing = true;

// ── Tab switching ──────────────────────────────────────────────────────────

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(target).classList.add('active');
    if (target === 'dashboard') refreshDashboard();
    if (target === 'analysis')  refreshPatterns();
    if (target === 'settings')  loadSettings();
  });
});

// ── Collection toggle ──────────────────────────────────────────────────────

const collectionToggle = document.getElementById('collectionToggle');

collectionToggle.addEventListener('change', async () => {
  if (initializing) return;   // never touch PM2 during startup
  collectionToggle.disabled = true;
  try {
    const active = await window.api.toggleCollection(collectionToggle.checked);
    updateCollectionUI(active);
  } finally {
    collectionToggle.disabled = false;
  }
});

function updateCollectionUI(active) {
  const label = document.getElementById('collectionLabel');
  const dot   = document.getElementById('statusDot');
  const text  = document.getElementById('statusText');

  collectionToggle.checked = active;
  label.textContent  = active ? '수집 중' : '중지됨';
  label.style.color  = active ? '#107c10' : '#605e5c';
  dot.className      = 'status-dot' + (active ? ' active' : '');
  text.textContent   = active ? '수집 중' : '대기 중';
  text.style.color   = active ? '#107c10' : '#888';
}

// Push events from the collector process into the log
window.api.onCollectionStatus(updateCollectionUI);
window.api.onCollectorLog(line => addLog(line));

// ── Log helpers ────────────────────────────────────────────────────────────

function addLog(text) {
  if (!text || !text.trim()) return;
  const time = new Date().toLocaleTimeString('ko-KR');
  logLines.push({ time, text: text.trim() });
  if (logLines.length > MAX_LOG) logLines.shift();
  renderLog();
}

function renderLog() {
  const container = document.getElementById('logContainer');
  // Show newest at top
  container.innerHTML = [...logLines].reverse().slice(0, 80).map(({ time, text }) =>
    `<div class="log-line"><span class="log-time">${esc(time)}</span>${esc(text)}</div>`
  ).join('');
}

document.getElementById('clearLog').addEventListener('click', () => {
  logLines = [];
  renderLog();
});

// ── Dashboard ──────────────────────────────────────────────────────────────

async function refreshDashboard() {
  try {
    const [stats, events] = await Promise.all([
      window.api.getAppStats(),
      window.api.getRecentEvents(),
    ]);
    renderAppChart(stats);
    seedLogFromEvents(events);
  } catch (e) {
    console.error('refreshDashboard:', e);
  }
}

function renderAppChart(stats) {
  const chart = document.getElementById('appChart');
  if (!stats || !stats.length) {
    chart.innerHTML = '<span class="hint">데이터가 없습니다. (window_focus 이벤트가 쌓이면 표시됩니다)</span>';
    return;
  }
  const maxMs = stats[0].durationMs || 1;
  chart.innerHTML = stats.map(s => {
    const pct = Math.max(2, Math.round(s.durationMs / maxMs * 100));
    return `
      <div class="chart-row">
        <span class="chart-label" title="${esc(s.app)}">${esc(s.app)}</span>
        <div class="chart-bar-wrap">
          <div class="chart-bar" style="width:${pct}%"></div>
        </div>
        <span class="chart-value">${esc(fmtDuration(s.durationMs))}</span>
      </div>`;
  }).join('');
}

function seedLogFromEvents(events) {
  if (!events || !events.length) return;
  for (const ev of events.slice(0, 30)) {
    const time = new Date(ev.occurred_at).toLocaleTimeString('ko-KR');
    let meta = '';
    try {
      const m = JSON.parse(ev.metadata);
      meta = m.app || m.url || m.path || m.title || '';
    } catch {}
    const text = `[${ev.action}]${meta ? ' ' + meta : ''}`;
    // Only add if not a duplicate of an existing entry
    if (!logLines.some(l => l.text === text && l.time === time)) {
      logLines.push({ time, text });
    }
  }
  if (logLines.length > MAX_LOG) logLines = logLines.slice(-MAX_LOG);
  renderLog();
}

// ── Pattern Analysis ───────────────────────────────────────────────────────

document.getElementById('runAnalyze').addEventListener('click', async () => {
  const btn = document.getElementById('runAnalyze');
  const out = document.getElementById('analyzeOutput');
  btn.disabled = true;
  btn.textContent = '분석 중...';
  out.innerHTML = '<span class="hint">앙상블 분석 실행 중... (잠시 기다려 주세요)</span>';

  try {
    const result = await window.api.runAnalyze();
    out.innerHTML = `<pre class="analysis-pre">${esc(result)}</pre>`;
    await refreshPatterns();
  } catch (e) {
    out.innerHTML = `<span class="error-text">${esc(String(e))}</span>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '▶ 분석 실행';
  }
});

async function refreshPatterns() {
  try {
    const patterns = await window.api.getPatterns();
    renderPatternList(patterns);
  } catch (e) {
    console.error('refreshPatterns:', e);
  }
}

function renderPatternList(patterns) {
  const list = document.getElementById('patternList');
  if (!patterns || !patterns.length) {
    list.innerHTML = '<span class="hint">감지된 패턴이 없습니다. 분석을 실행해 보세요.</span>';
    return;
  }

  const LABELS = {
    time_of_day:         '시간대 패턴',
    app_sequence:        '시퀀스 패턴',
    periodic:            '주기 패턴',
    repetitive_sequence: '반복 전환',
    repetitive_action:   '반복 행동',
    high_frequency:      '고빈도 패턴',
    inactivity_burst:    '비활성 폭발',
  };

  list.innerHTML = patterns.map(p => {
    const label = LABELS[p.pattern_type] || p.pattern_type;
    const score = Math.round(p.score * 100);
    const filled = Math.round(score / 10);
    const scoreBar = '█'.repeat(filled) + '░'.repeat(10 - filled);
    const time = new Date(p.detected_at).toLocaleString('ko-KR', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    const notified = p.notified
      ? '<span class="notified-mark">✓</span>' : '';
    const detail = extractDetail(p);

    return `
      <div class="pattern-item">
        <div class="pattern-header">
          <span class="pattern-type-badge">${esc(label)}</span>
          <span class="pattern-score">${esc(scoreBar)} ${score}%</span>
          ${notified}
        </div>
        ${detail ? `<div class="pattern-detail">${esc(detail)}</div>` : ''}
        <div class="pattern-time">감지: ${esc(time)}</div>
      </div>`;
  }).join('');
}

function extractDetail(p) {
  try {
    const ev = JSON.parse(p.payload);
    switch (p.pattern_type) {
      case 'time_of_day':
        return `매일 ${String(ev.hour ?? 0).padStart(2,'0')}:00  ${ev.app ?? ''}`;
      case 'app_sequence':
        if (Array.isArray(ev.sequence)) return ev.sequence.join(' → ');
        return `${ev.from ?? '?'} → ${ev.to ?? '?'}`;
      case 'periodic':
        if (ev.periodHours !== undefined)
          return `${ev.app ?? ''}  ${ev.periodHours === 168 ? '주간(168h)' : '일간(24h)'} 주기`;
        return ev.app ?? '';
      case 'high_frequency':
        return `분당 ${Number(ev.ratePerMinute ?? 0).toFixed(1)}회`;
      default:
        return '';
    }
  } catch {
    return '';
  }
}

// ── Settings ───────────────────────────────────────────────────────────────

async function loadSettings() {
  try {
    const s = await window.api.getSettings();
    document.getElementById('webhookUrl').value       = s.webhookUrl || '';
    document.getElementById('analyzeInterval').value  = String(s.analyzeInterval || 5);
    document.getElementById('autoStart').checked      = !!s.collectionEnabled;
  } catch (e) {
    console.error('loadSettings:', e);
  }
}

document.getElementById('saveSettings').addEventListener('click', async () => {
  const s = {
    webhookUrl:        document.getElementById('webhookUrl').value.trim(),
    analyzeInterval:   parseInt(document.getElementById('analyzeInterval').value, 10),
    collectionEnabled: document.getElementById('autoStart').checked,
  };
  await window.api.saveSettings(s);
  const status = document.getElementById('saveStatus');
  status.textContent   = '저장됨 ✓';
  status.style.color   = '#4caf50';
  setTimeout(() => { status.textContent = ''; }, 2500);
});

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtDuration(ms) {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h > 0) return `${h}시간 ${m}분`;
  if (m > 0) return `${m}분`;
  return '< 1분';
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Init ───────────────────────────────────────────────────────────────────

async function init() {
  initializing = true;
  try {
    const [active] = await Promise.all([
      window.api.getCollectionStatus(),   // pm2 jlist → true/false, never touches PM2
      refreshDashboard(),
      loadSettings(),
    ]);
    updateCollectionUI(active);           // display only, no PM2 side-effect
  } finally {
    initializing = false;                 // unlock toggle for user interaction
  }
}

init().catch(console.error);

// Auto-refresh app chart every 15 s while on dashboard tab
setInterval(async () => {
  if (document.getElementById('dashboard').classList.contains('active')) {
    const stats = await window.api.getAppStats().catch(() => null);
    if (stats) renderAppChart(stats);
  }
}, 15_000);
