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

// ── Connection token (EXTENSION_TOKEN in .env) ──────────────────────────────
const tokenInput = document.getElementById('tokenInput');
const tokenState = document.getElementById('tokenState');

chrome.storage.local.get({ token: '' }, ({ token }) => renderTokenState(token));

document.getElementById('tokenSave').addEventListener('click', () => {
  const token = tokenInput.value.trim();
  chrome.storage.local.set({ token }, () => {
    tokenInput.value = '';
    renderTokenState(token);
    // Let the background reconnect with the new token.
    chrome.runtime.sendMessage({ type: 'token_changed' }).catch(() => {});
  });
});

function renderTokenState(token) {
  tokenState.textContent = token ? '토큰 저장됨' : '토큰 없음 — .env의 EXTENSION_TOKEN 값을 넣어 주세요';
  tokenState.style.color = token ? '#16a34a' : '#dc2626';
}

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
