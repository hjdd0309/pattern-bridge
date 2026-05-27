'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain } = require('electron');
const path = require('path');
const { spawn, exec } = require('child_process');
const fs = require('fs');

const PROJECT_ROOT = path.resolve(__dirname, '../../');
const SETTINGS_PATH = path.join(PROJECT_ROOT, 'data', 'ui-settings.json');
const ECOSYSTEM_CFG = path.join(PROJECT_ROOT, 'ecosystem.config.cjs');

let mainWindow = null;
let tray = null;
let logTailProcess = null;
let statusPollTimer = null;
let lastKnownStatus = false;
app.isQuitting = false;

// ── Settings ───────────────────────────────────────────────────────────────

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); }
  catch { return { webhookUrl: '', analyzeInterval: 5, collectionEnabled: false }; }
}

function saveSettings(settings) {
  const dir = path.dirname(SETTINGS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8');
}

// ── Tray icon ─────────────────────────────────────────────────────────────

function makeTrayIcon() {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    buf[i * 4] = 0; buf[i * 4 + 1] = 120; buf[i * 4 + 2] = 212; buf[i * 4 + 3] = 255;
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

// ── PM2 helpers ───────────────────────────────────────────────────────────

function execPm2(args) {
  return new Promise((resolve, reject) => {
    exec(`pm2 ${args}`, { shell: true, cwd: PROJECT_ROOT }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout.trim());
    });
  });
}

// Returns 'online' | 'stopped' | 'not-found'.
// Uses "pm2 show <name>" which prints a plain text table — no JSON parsing needed.
// If the process is unknown to PM2, the command exits non-zero → catch returns 'not-found'.
async function getPm2ProcessStatus() {
  try {
    const raw = await execPm2('show pattern-bridge');
    for (const line of raw.split('\n')) {
      if (line.includes('status')) {
        if (line.includes('online'))  return 'online';
        if (line.includes('stopped')) return 'stopped';
        if (line.includes('errored')) return 'stopped';
      }
    }
    return 'stopped';
  } catch {
    return 'not-found';
  }
}

async function getPm2Active() {
  return (await getPm2ProcessStatus()) === 'online';
}

async function pm2Start() {
  const status = await getPm2ProcessStatus();
  if (status === 'not-found') {
    await execPm2(`start "${ECOSYSTEM_CFG}"`);
  } else {
    await execPm2('restart pattern-bridge');
  }
}

async function pm2Stop() {
  await execPm2('stop pattern-bridge');
}

// ── PM2 log tail ──────────────────────────────────────────────────────────

function stripAnsi(str) {
  return str.replace(/\x1B\[[0-9;]*[mGKHFJA-Za-z]/g, '');
}

function startLogTail() {
  if (logTailProcess) return;
  // --lines 40: show last 40 lines then stream new ones; --raw: no prefix/timestamp
  logTailProcess = spawn('pm2', ['logs', 'pattern-bridge', '--raw', '--lines', '40'], {
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const relay = data => {
    for (const line of stripAnsi(data.toString()).split('\n')) {
      if (line.trim()) mainWindow?.webContents.send('collector-log', line.trim());
    }
  };
  logTailProcess.stdout?.on('data', relay);
  logTailProcess.stderr?.on('data', relay);
  logTailProcess.on('exit', () => { logTailProcess = null; });
}

function stopLogTail() {
  if (!logTailProcess) return;
  logTailProcess.kill();
  logTailProcess = null;
}

// ── PM2 status polling ────────────────────────────────────────────────────
// Polls every 10 s so the toggle stays in sync even when PM2 state changes
// outside the UI (e.g. manual pm2 start/stop from terminal).

function startStatusPoll() {
  if (statusPollTimer) return;
  statusPollTimer = setInterval(async () => {
    const active = await getPm2Active();
    if (active !== lastKnownStatus) {
      lastKnownStatus = active;
      mainWindow?.webContents.send('collection-status', active);
    }
  }, 10_000);
}

function stopStatusPoll() {
  if (!statusPollTimer) return;
  clearInterval(statusPollTimer);
  statusPollTimer = null;
}

// ── DB query helper via tsx subprocess ────────────────────────────────────

function runQuery(queryName, ...args) {
  const helperPath = path.join(__dirname, 'query-helper.ts');
  return new Promise((resolve, reject) => {
    const proc = spawn('npx', ['tsx', helperPath, queryName, ...args.map(String)], {
      cwd: PROJECT_ROOT,
      shell: true,
    });
    let out = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', () => {});
    proc.on('exit', code => {
      if (code === 0) { try { resolve(JSON.parse(out.trim())); } catch { resolve([]); } }
      else reject(new Error(`query-helper exit ${code}`));
    });
  });
}

// ── IPC handlers ──────────────────────────────────────────────────────────

ipcMain.handle('get-app-stats',     () => runQuery('app-stats'));
ipcMain.handle('get-recent-events', () => runQuery('recent-events'));
ipcMain.handle('get-patterns',      () => runQuery('patterns'));

ipcMain.handle('run-analyze', () => new Promise(resolve => {
  const proc = spawn('npx', ['tsx', 'src/analyzer/check-patterns.ts'], {
    cwd: PROJECT_ROOT, shell: true,
  });
  let out = '';
  proc.stdout.on('data', d => { out += d.toString(); });
  proc.stderr.on('data', d => { out += d.toString(); });
  proc.on('exit', () => resolve(out));
}));

ipcMain.handle('get-collection-status', async () => {
  const active = await getPm2Active();
  lastKnownStatus = active;   // sync poll baseline so first tick doesn't re-send
  return active;
});

ipcMain.handle('toggle-collection', async (_, enable) => {
  try {
    if (enable) await pm2Start();
    else        await pm2Stop();
  } catch (err) {
    console.error('[pm2]', err.message);
  }
  const active = await getPm2Active();
  lastKnownStatus = active;
  return active;
});

ipcMain.handle('get-settings', () => loadSettings());

ipcMain.handle('save-settings', (_, settings) => {
  saveSettings(settings);
  return true;
});

// ── Window ────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 920, height: 700,
    minWidth: 720, minHeight: 520,
    title: 'Pattern Bridge',
    icon: makeTrayIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    backgroundColor: '#f3f3f3',
    show: false,
    autoHideMenuBar: true,
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    startLogTail();
    startStatusPoll();
  });

  mainWindow.on('hide', () => {
    stopLogTail();
  });

  mainWindow.on('show', () => {
    startLogTail();
  });

  mainWindow.on('close', event => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

// ── Tray ──────────────────────────────────────────────────────────────────

function createTray() {
  tray = new Tray(makeTrayIcon());
  tray.setToolTip('Pattern Bridge');

  const menu = Menu.buildFromTemplate([
    { label: 'Open Dashboard', click: () => { mainWindow.show(); mainWindow.focus(); } },
    { type: 'separator' },
    { label: 'Start Collector (PM2)',  click: () => pm2Start().catch(console.error) },
    { label: 'Stop Collector (PM2)',   click: () => pm2Stop().catch(console.error) },
    { type: 'separator' },
    { label: 'Quit UI',  click: () => { app.isQuitting = true; app.quit(); } },
  ]);

  tray.setContextMenu(menu);
  tray.on('double-click', () => { mainWindow.show(); mainWindow.focus(); });
}

// ── App lifecycle ─────────────────────────────────────────────────────────
// NOTE: The PM2 collector process is NOT stopped when the UI quits.
//       PM2 manages it independently. Use tray menu or terminal to stop it.

app.whenReady().then(() => {
  createWindow();
  createTray();
});

// Stay alive in system tray
app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  app.isQuitting = true;
  stopLogTail();
  stopStatusPoll();
});
