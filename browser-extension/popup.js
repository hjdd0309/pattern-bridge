const toggle       = document.getElementById('toggle');
const stateLabel   = document.getElementById('stateLabel');
const activityDiv  = document.getElementById('activityContent');

// ── Load current state ──────────────────────────────────────────────────────
chrome.storage.local.get(
  { enabled: true, lastUrl: null, lastTitle: null, lastSentAt: null },
  ({ enabled, lastUrl, lastTitle, lastSentAt }) => {
    setToggle(enabled);
    renderActivity(lastUrl, lastTitle, lastSentAt);
  }
);

// ── Toggle handler ──────────────────────────────────────────────────────────
toggle.addEventListener('change', () => {
  const enabled = toggle.checked;
  chrome.storage.local.set({ enabled });
  setToggle(enabled);
});

// ── Helpers ─────────────────────────────────────────────────────────────────
function setToggle(enabled) {
  toggle.checked   = enabled;
  stateLabel.textContent = enabled ? '수집 중' : '수집 중지';
  stateLabel.style.color = enabled ? '#222' : '#999';
}

function renderActivity(url, title, sentAt) {
  if (!url) {
    activityDiv.innerHTML = '<span class="no-activity">아직 전송 없음</span>';
    return;
  }

  const timeStr = sentAt ? relativeTime(sentAt) : '';

  activityDiv.innerHTML = `
    <div class="activity-title">${escHtml(title || '(제목 없음)')}</div>
    <div class="activity-url">${escHtml(url)}</div>
    <div class="activity-time">${escHtml(timeStr)}</div>
  `;
}

function relativeTime(ms) {
  const diff = Math.floor((Date.now() - ms) / 1000);
  if (diff < 5)   return '방금';
  if (diff < 60)  return `${diff}초 전`;
  if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
  return `${Math.floor(diff / 3600)}시간 전`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
