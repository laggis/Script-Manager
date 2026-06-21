const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, Notification } = require('electron');
const path  = require('path');
const fs    = require('fs');
const { spawn, execSync } = require('child_process');

// ── Windows PATH fix ──────────────────────────────────────────────────────────
// Electron on Windows can launch with a stripped PATH missing node, python, git.
// We read the real PATH from a CMD shell so child processes see the same
// environment as if the user opened a normal terminal.
if (process.platform === 'win32') {
  try {
    const realPath = execSync('cmd /c "echo %PATH%"', { encoding: 'utf8' }).trim();
    if (realPath && !realPath.includes('%PATH%')) {
      const merged = [...new Set([
        ...realPath.split(path.delimiter),
        ...(process.env.PATH || '').split(path.delimiter),
      ])].filter(Boolean).join(path.delimiter);
      process.env.PATH = merged;
    }
  } catch (_) { /* non-fatal */ }
}

let mainWindow;
let tray;
let processes  = {};   // scriptId -> { process, startedAt }
let scripts    = [];
let cronJobs   = {};   // scriptId -> cron task
let statsTimer = null;
let healthCheckTimers = {};  // scriptId -> interval timer
let groups     = [];   // Array of group objects { id, name, color }
let templates  = [];   // Script templates
let webServer  = null; // Optional web UI server
let profiles   = {};   // scriptId -> { profileName -> config }
let collections = [];  // Script collections
let statsHistory = {}; // scriptId -> [{timestamp, cpu, mem}]
let statsCache   = {}; // scriptId -> latest {cpu, mem, uptime} snapshot
let fileWatchers = {}; // scriptId -> FSWatcher
let portMonitors = {}; // scriptId -> interval

// ── Data file location ───────────────────────────────────────────────────────
// In production (.exe) → same folder as the exe so it's easy to find & back up.
// In dev (npm start)   → project root, so it doesn't pollute AppData.
const DATA_DIR  = app.isPackaged
  ? path.dirname(app.getPath('exe'))
  : path.join(__dirname, '..');
const DATA_FILE   = path.join(DATA_DIR, 'scripts.json');
const GROUPS_FILE = path.join(DATA_DIR, 'groups.json');
const TEMPLATES_FILE = path.join(DATA_DIR, 'templates.json');
const PROFILES_FILE = path.join(DATA_DIR, 'profiles.json');
const COLLECTIONS_FILE = path.join(DATA_DIR, 'collections.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const STATS_HISTORY_FILE = path.join(DATA_DIR, 'stats-history.json');
const BACKUP_DIR  = path.join(DATA_DIR, 'scripts-backups');
const LOGS_DIR    = path.join(DATA_DIR, 'logs');
const ICON_PATH   = path.join(__dirname, '../assets/icon.ico');
const ICON_PNG    = path.join(__dirname, '../assets/icon.png');
const TRAY_16     = path.join(__dirname, '../assets/tray-16.png');
const TRAY_32     = path.join(__dirname, '../assets/tray-32.png');

const APP_VERSION = (() => {
  try { return require('../package.json').version || app.getVersion(); }
  catch (_) { return app.getVersion(); }
})();

function defaultSettings() {
  return {
    smtp: { enabled: false },
    webUI: {
      enabled: false,
      host: '127.0.0.1',
      port: 3333,
      token: '',
    },
    updateCheck: {
      enabled: false,
      url: '',
    },
  };
}

function mergeSettings(base, extra) {
  const out = { ...base, ...(extra || {}) };
  out.smtp = { ...(base.smtp || {}), ...((extra || {}).smtp || {}) };
  out.webUI = { ...(base.webUI || {}), ...((extra || {}).webUI || {}) };
  out.updateCheck = { ...(base.updateCheck || {}), ...((extra || {}).updateCheck || {}) };
  return out;
}

function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>'"]/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[c]));
}

function compareVersions(a, b) {
  const clean = v => String(v || '0').replace(/^v/i, '').split(/[.-]/).map(x => parseInt(x, 10) || 0);
  const aa = clean(a), bb = clean(b);
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const x = aa[i] || 0, y = bb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

// ── Persistence ───────────────────────────────────────────────────────────────
function loadScripts() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      scripts = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch { scripts = []; }
}

function loadGroups() {
  try {
    if (fs.existsSync(GROUPS_FILE)) {
      groups = JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8'));
    } else {
      // Create default "Uncategorized" group
      groups = [{ id: 'default', name: 'Uncategorized', color: '#5a6480' }];
      saveGroups();
    }
  } catch { 
    groups = [{ id: 'default', name: 'Uncategorized', color: '#5a6480' }];
  }
}

function loadTemplates() {
  try {
    if (fs.existsSync(TEMPLATES_FILE)) {
      templates = JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf8'));
    } else {
      // Create default templates
      templates = [
        {
          id: 'discord-py',
          name: 'Discord Bot (Python)',
          type: 'discord-python',
          runtime: 'python',
          notes: 'Discord bot using discord.py',
          env: [{ k: 'DISCORD_TOKEN', v: 'your-token-here' }]
        },
        {
          id: 'discord-js',
          name: 'Discord Bot (Node.js)',
          type: 'discord-node',
          runtime: 'node',
          notes: 'Discord bot using discord.js',
          env: [{ k: 'DISCORD_TOKEN', v: 'your-token-here' }]
        },
        {
          id: 'express-api',
          name: 'Express.js API',
          type: 'node-npm-start',
          notes: 'Express.js REST API server',
          healthCheckEnabled: true,
          healthCheckType: 'http',
          healthCheckUrl: 'http://localhost:3000/health',
          env: [{ k: 'PORT', v: '3000' }]
        },
        {
          id: 'flask-api',
          name: 'Flask API',
          type: 'python',
          runtime: 'python',
          notes: 'Flask REST API server',
          healthCheckEnabled: true,
          healthCheckType: 'http',
          healthCheckUrl: 'http://localhost:5000/health',
          env: [{ k: 'FLASK_APP', v: 'app.py' }, { k: 'FLASK_ENV', v: 'development' }]
        }
      ];
      saveTemplates();
    }
  } catch { 
    templates = [];
  }
}

function loadProfiles() {
  try {
    if (fs.existsSync(PROFILES_FILE)) {
      profiles = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8'));
    }
  } catch { profiles = {}; }
}

function loadCollections() {
  try {
    if (fs.existsSync(COLLECTIONS_FILE)) {
      collections = JSON.parse(fs.readFileSync(COLLECTIONS_FILE, 'utf8'));
    }
  } catch { collections = []; }
}

function loadSettings() {
  const defaults = defaultSettings();
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return mergeSettings(defaults, JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')));
    }
  } catch { }
  return defaults;
}

function loadStatsHistory() {
  try {
    if (fs.existsSync(STATS_HISTORY_FILE)) {
      statsHistory = JSON.parse(fs.readFileSync(STATS_HISTORY_FILE, 'utf8'));
    }
  } catch { statsHistory = {}; }
}

function saveScripts() {
  const json = JSON.stringify(scripts, null, 2);
  fs.writeFileSync(DATA_FILE, json);
  autoBackup(json);
}

function saveGroups() {
  fs.writeFileSync(GROUPS_FILE, JSON.stringify(groups, null, 2));
}

function saveTemplates() {
  fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(templates, null, 2));
}

function saveProfiles() {
  fs.writeFileSync(PROFILES_FILE, JSON.stringify(profiles, null, 2));
}

function saveCollections() {
  fs.writeFileSync(COLLECTIONS_FILE, JSON.stringify(collections, null, 2));
}

function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

function saveStatsHistory() {
  fs.writeFileSync(STATS_HISTORY_FILE, JSON.stringify(statsHistory, null, 2));
}

// Keep up to 10 rolling backups named scripts-2024-01-15T10-30-00.json
let lastBackupMin = -1;
function autoBackup(json) {
  try {
    const now = new Date();
    const mins = now.getHours() * 60 + now.getMinutes();
    // Only backup once per minute max to avoid flooding on rapid saves
    if (mins === lastBackupMin) return;
    lastBackupMin = mins;

    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

    const stamp = now.toISOString().slice(0,19).replace(/:/g,'-');
    fs.writeFileSync(path.join(BACKUP_DIR, `scripts-${stamp}.json`), json);

    // Prune: keep only the 10 most recent backups
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('scripts-') && f.endsWith('.json'))
      .sort();
    while (files.length > 10) {
      fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
    }
  } catch { /* backup failure is non-fatal */ }
}

// ── Window ────────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1340, height: 820, minWidth: 960, minHeight: 620,
    frame: false,
    backgroundColor: '#0b0d11',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      enableRemoteModule: false,
      devTools: !app.isPackaged,
    },
    icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
  });
  
  // Clear any residual session cache on startup
  mainWindow.webContents.session.clearCache();
  
  mainWindow.loadFile(path.join(__dirname, 'renderer/index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Hide to tray instead of closing
  mainWindow.on('close', async (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      const running = Object.keys(processes).length;
      if (running > 0) {
        // Ask user what to do with running scripts
        const { response } = await dialog.showMessageBox(mainWindow, {
          type: 'question',
          title: 'ScriptManager',
          message: `${running} script${running > 1 ? 's are' : ' is'} still running.`,
          detail: 'What would you like to do?',
          buttons: ['Keep running in tray', 'Stop all & quit', 'Cancel'],
          defaultId: 0,
          cancelId: 2,
        });
        if (response === 0) {
          // Hide to tray — scripts keep running
          mainWindow.hide();
          if (Notification.isSupported()) {
            new Notification({ title: 'ScriptManager', body: `${running} script${running>1?'s':''} still running in background.` }).show();
          }
        } else if (response === 1) {
          // Stop all and quit
          app.isQuitting = true;
          app.quit();
        }
        // response === 2 → Cancel, do nothing
      } else {
        // No scripts running — just hide to tray silently
        mainWindow.hide();
      }
    }
  });
}

// ── Tray ──────────────────────────────────────────────────────────────────────
function createTray() {
  // Use dedicated 16px tray icon for crispness; fall back to resized 256px
  let img;
  if (fs.existsSync(TRAY_16)) {
    img = nativeImage.createFromPath(TRAY_16);
    // On high-DPI (Retina/200% scaling) also provide the 32px version
    if (fs.existsSync(TRAY_32)) {
      const img32 = nativeImage.createFromPath(TRAY_32);
      img.addRepresentation({ scaleFactor: 2.0, ...img32.getBitmap && {} });
    }
  } else if (fs.existsSync(ICON_PNG)) {
    img = nativeImage.createFromPath(ICON_PNG).resize({ width: 16, height: 16 });
  } else {
    img = nativeImage.createEmpty();
  }

  tray = new Tray(img);
  tray.setToolTip('ScriptManager');
  updateTrayMenu();

  tray.on('double-click', () => {
    mainWindow.show();
    mainWindow.focus();
  });
}

function updateTrayMenu() {
  if (!tray) return;
  const running = scripts.filter(s => s.status === 'running');
  const scriptItems = scripts.slice(0, 8).map(s => ({
    label: `${s.status === 'running' ? '▶' : '■'} ${s.name}`,
    click: () => { s.status === 'running' ? stopScript(s.id) : startScript(s.id); }
  }));

  const menu = Menu.buildFromTemplate([
    { label: `ScriptManager  (${running.length} running)`, enabled: false },
    { type: 'separator' },
    ...scriptItems,
    ...(scripts.length > 8 ? [{ label: `+ ${scripts.length - 8} more…`, enabled: false }] : []),
    { type: 'separator' },
    { label: 'Start All',  click: () => scripts.forEach(s => s.status !== 'running' && startScript(s.id)) },
    { label: 'Stop All',   click: () => scripts.forEach(s => s.status === 'running' && stopScript(s.id)) },
    { type: 'separator' },
    { label: 'Open ScriptManager', click: () => { mainWindow.show(); mainWindow.focus(); } },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

// ── Disable Chromium disk/GPU cache (prevents cache_util / gpu_disk_cache errors) ──
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-http-cache');
app.commandLine.appendSwitch('disk-cache-size', '0');
app.commandLine.appendSwitch('media-cache-size', '0');

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  loadScripts();
  loadGroups();
  loadTemplates();
  loadProfiles();
  loadCollections();
  loadStatsHistory();
  // Reset statuses (were running before app closed)
  scripts.forEach(s => { s.status = 'stopped'; s.pid = null; });
  createWindow();
  createTray();
  // Auto-start scripts (respecting dependencies)
  startScriptsWithDependencies();
  // Re-schedule cron
  scripts.forEach(s => { if (s.cronEnabled && s.cronSchedule) scheduleCron(s); });
  // CPU/RAM polling every 3s
  statsTimer = setInterval(() => {
    pollStats();
    recordStatsHistory();
  }, 3000);
  // Start health checks for scripts that have them enabled
  scripts.forEach(s => { if (s.healthCheckEnabled) startHealthCheck(s.id); });
  // Start log rotation check (daily)
  setInterval(rotateLogs, 24 * 60 * 60 * 1000);
  // Start web UI if enabled
  startWebUI();
  // Check for updates on startup if enabled
  try {
    const upd = loadSettings().updateCheck || {};
    if (upd.enabled && upd.url) {
      setTimeout(async () => {
        const r = await checkForUpdates();
        if (r.ok && r.updateAvailable) {
          notify('⬆️ ScriptManager update available', `Version ${r.latest} is available. Current version: ${r.current}.`);
        }
      }, 5000);
    }
  } catch (_) {}
  // Start triggers for configured scripts
  scripts.forEach(s => { 
    if (s.fileWatchEnabled) startFileWatcher(s.id);
    if (s.portMonitorEnabled) startPortMonitor(s.id);
  });
  // Start webhook server if any scripts have it enabled
  restartWebhookServer();
  // Save stats history every 5 minutes
  setInterval(saveStatsHistory, 5 * 60 * 1000);
});

app.on('before-quit', () => {
  app.isQuitting = true;
  if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
  // Clear all health check timers
  Object.values(healthCheckTimers).forEach(timer => clearInterval(timer));
  healthCheckTimers = {};
  // Kill every running child process so nothing is left orphaned
  Object.entries(processes).forEach(([scriptId, entry]) => {
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /pid ${entry.process.pid} /T /F`, { stdio: 'ignore' });
      } else {
        process.kill(-entry.process.pid, 'SIGKILL');
      }
    } catch (_) {
      try { entry.process.kill(); } catch (_2) {}
    }
  });
  // Reset all statuses so they don't show as running on next launch
  scripts.forEach(s => { s.status = 'stopped'; s.pid = null; });
  saveScripts();
});
app.on('window-all-closed', () => { /* keep running in tray until Quit is clicked */ });

// ── Helpers ───────────────────────────────────────────────────────────────────
const getScript = id => scripts.find(s => s.id === id);

function send(ch, data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, data);
}
function appendLog(scriptId, text) {
  send('log', { scriptId, text, ts: Date.now() });
}
function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body }).show();
}

// ── CPU / RAM polling ─────────────────────────────────────────────────────────
async function pollStats() {
  let pidusage;
  try { pidusage = require('pidusage'); } catch { return; }

  const entries = Object.entries(processes);
  for (const [scriptId, entry] of entries) {
    try {
      const stat = await pidusage(entry.process.pid);
      const script = getScript(scriptId);
      
      const statPayload = {
        scriptId,
        cpu: stat.cpu.toFixed(1),
        mem: Math.round(stat.memory / 1024 / 1024),  // MB
        uptime: Date.now() - entry.startedAt,
      };
      send('stats-update', statPayload);

      // Cache latest snapshot so recordStatsHistory() can persist it
      statsCache[scriptId] = statPayload;

      // Check resource limits
      if (script && script.resourceLimitsEnabled) {
        let violated = false;
        let reason = '';

        if (script.cpuLimit && stat.cpu > script.cpuLimit) {
          violated = true;
          reason = `CPU ${stat.cpu.toFixed(1)}% > ${script.cpuLimit}%`;
        }
        if (script.memLimit && (stat.memory / 1024 / 1024) > script.memLimit) {
          violated = true;
          reason = `RAM ${Math.round(stat.memory / 1024 / 1024)}MB > ${script.memLimit}MB`;
        }

        if (violated) {
          appendLog(scriptId, `[RESOURCE LIMIT] ${reason}\n`);
          notify(`⚠️ ${script.name}`, `Resource limit exceeded: ${reason}`);
          
          if (script.resourceAction === 'restart') {
            appendLog(scriptId, `[AUTO-ACTION] Restarting due to resource limit violation\n`);
            restartScript(scriptId);
          } else if (script.resourceAction === 'stop') {
            appendLog(scriptId, `[AUTO-ACTION] Stopping due to resource limit violation\n`);
            stopScript(scriptId);
          }
          // alert-only does nothing except log and notify
        }
      }
    } catch { /* process may have just died */ }
  }
}

// ── Process management ────────────────────────────────────────────────────────
function startScript(scriptId) {
  const script = getScript(scriptId);
  if (!script) return { ok: false, error: 'Script not found' };
  if (processes[scriptId]) return { ok: false, error: 'Already running' };

  // Build env vars from script config
  const extraEnv = {};
  (script.env || []).forEach(({ k, v }) => { if (k) extraEnv[k] = v; });

  // Determine the working directory.
  // For npm types: cwd is REQUIRED (it's where package.json lives).
  //   Priority: explicit cwd field > dirname of path field > fail with helpful message.
  // For file-based types: cwd defaults to the script file's own folder.
  const isNpmType = ['node-npm-start', 'node-npm-dev'].includes(script.type);
  let cwd;
  if (script.cwd && script.cwd.trim()) {
    cwd = script.cwd.trim();
  } else if (script.path && script.path.trim()) {
    // For npm types the "path" field is treated as the project folder if no cwd set
    const p = script.path.trim();
    cwd = isNpmType ? p : path.dirname(p);
  } else {
    appendLog(scriptId, '[ERROR] No path or working directory set. Please edit the script and set at least a Working Directory.\n');
    return { ok: false, error: 'No path or working directory' };
  }

  // Build a full Windows-friendly environment that mirrors what CMD sees.
  // Electron on Windows can have a stripped PATH, so we pass process.env through
  // fully and also set NODE_PATH so require() finds local node_modules.
  const childEnv = {
    ...process.env,
    ...extraEnv,
    NODE_PATH: [
      path.join(cwd, 'node_modules'),
      path.join(cwd, '..', 'node_modules'),
      process.env.NODE_PATH || '',
    ].filter(Boolean).join(path.delimiter),
  };

  // Build command + args
  let cmd, args;
  if (script.type === 'node-npm-start') {
    cmd = 'npm'; args = ['start'];
  } else if (script.type === 'node-npm-dev') {
    cmd = 'npm'; args = ['run', 'dev'];
  } else {
    if (script.type === 'exe') {
      // Run the .exe directly — no interpreter wrapper needed
      cmd = script.path;
      args = script.args ? script.args.trim().split(/\s+/) : [];
    } else {
      cmd = script.runtime || (
        ['python','discord-python'].includes(script.type) ? 'python' :
        script.type === 'batch'      ? 'cmd' :
        script.type === 'powershell' ? 'powershell' :
        script.type === 'bun'        ? 'bun' :
        script.type === 'deno'       ? 'deno' : 'node'
      );
      const extraArgs = script.args ? script.args.trim().split(/\s+/) : [];
      args = script.path ? [script.path, ...extraArgs] : extraArgs;
    }
  }

  // Git pull before start if gitOnStart is enabled
  if (script.gitEnabled && script.gitOnStart && typeof gitPull === 'function') {
    try {
      const r = gitPull(scriptId);
      if (!r.ok) appendLog(scriptId, `[WARN] Git pull failed (${r.error||'unknown'}) — starting anyway\n`);
    } catch (e) {
      appendLog(scriptId, `[WARN] Git pull threw: ${e.message} — starting anyway\n`);
    }
  }

  appendLog(scriptId, `⛙ cwd: ${cwd}
`);
  appendLog(scriptId, `⛙ cmd: ${cmd} ${args.join(' ')}
`);

  let proc;
  try {
    // On Windows with shell:true, passing an array of args can cause them to be
    // silently dropped by CMD. Build a single quoted command string instead.
    if (process.platform === 'win32') {
      const quotedArgs = args.map(a => a.includes(' ') ? `"${a}"` : a);
      const fullCmd = [cmd, ...quotedArgs].join(' ');
      proc = spawn(fullCmd, [], {
        cwd, shell: true, env: childEnv, windowsHide: true,
      });
    } else {
      proc = spawn(cmd, args, { cwd, shell: true, env: childEnv });
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const startedAt = Date.now();
  processes[scriptId] = { process: proc, startedAt, intentionallyStopped: false };
  script.status    = 'running';
  script.pid       = proc.pid;
  script.startedAt = startedAt;
  if (!script.crashCount) script.crashCount = 0;
  saveScripts();

  send('status-update', { scriptId, status: 'running', pid: proc.pid, startedAt });
  appendLog(scriptId, `▶ Started PID ${proc.pid} — ${new Date().toLocaleString()}\n`);
  logToFile(scriptId, `Started PID ${proc.pid}`, 'INFO');
  updateTrayMenu();

  // Start health check if enabled
  if (script.healthCheckEnabled) {
    script.healthStatus = 'healthy';
    startHealthCheck(scriptId);
  }

  proc.stdout.on('data', d => {
    const text = d.toString();
    appendLog(scriptId, text);
    logToFile(scriptId, text.trim(), 'STDOUT');
    parseOutput(scriptId, text);
  });
  
  proc.stderr.on('data', d => {
    const text = d.toString();
    appendLog(scriptId, `[ERR] ${text}`);
    logToFile(scriptId, text.trim(), 'STDERR');
    parseOutput(scriptId, text);
  });

  proc.on('close', code => {
    const wasIntentional = processes[scriptId]?.intentionallyStopped || app.isQuitting;
    delete processes[scriptId];
    delete statsCache[scriptId]; // remove stale snapshot
    const crashed = !wasIntentional && code !== 0 && code !== null;
    script.status = 'stopped';
    script.pid    = null;
    if (crashed) {
      script.crashCount = (script.crashCount || 0) + 1;
      script.lastCrash  = Date.now();
    }
    script.lastStopped = Date.now();
    saveScripts();
    appendLog(scriptId, `■ Exited — code ${code}  (${crashed ? '💥 crash' : '✓ clean'})\n`);
    send('status-update', { scriptId, status: 'stopped', exitCode: code, crashCount: script.crashCount });
    updateTrayMenu();

    if (crashed) notify(`💥 ${script.name} crashed`, `Exit code ${code}. ${script.autoRestart !== 'never' ? 'Restarting…' : ''}`);

    const ar = script.autoRestart;
    if (!app.isQuitting && (ar === 'always' || (ar === 'on-failure' && crashed))) {
      appendLog(scriptId, `↻ Auto-restarting in 3 s (mode: ${ar})\n`);
      setTimeout(() => { if (!app.isQuitting) startScript(scriptId); }, 3000);
    }
  });

  proc.on('error', err => appendLog(scriptId, `[ERROR] ${err.message}\n`));
  return { ok: true };
}

function stopScript(scriptId) {
  const entry = processes[scriptId];
  if (!entry) return { ok: false, error: 'Not running' };

  // Stop health check
  stopHealthCheck(scriptId);
  
  // Stop triggers
  stopFileWatcher(scriptId);
  stopPortMonitor(scriptId);

  // Mark as intentional so the close handler doesn't count it as a crash
  entry.intentionallyStopped = true;

  const proc = entry.process;

  if (process.platform === 'win32') {
    // Windows does not support SIGTERM/SIGKILL — use taskkill to kill the
    // entire process tree (important for npm which spawns child processes)
    try {
      execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' });
    } catch (_) {
      // taskkill may fail if the process already exited — that's fine
      try { proc.kill(); } catch (_2) {}
    }
  } else {
    // Unix — kill the whole process group so child processes die too
    try {
      process.kill(-proc.pid, 'SIGTERM');
      setTimeout(() => {
        try { process.kill(-proc.pid, 'SIGKILL'); } catch (_) {}
      }, 3000);
    } catch (_) {
      try { proc.kill('SIGTERM'); } catch (_2) {}
    }
  }

  return { ok: true };
}

function restartScript(scriptId) {
  const wasRunning = !!processes[scriptId];
  stopScript(scriptId);
  // Wait long enough for taskkill/SIGTERM to fully terminate the process tree
  // before we try to start again (especially important for npm which has children)
  setTimeout(() => startScript(scriptId), wasRunning ? 2500 : 500);
  return { ok: true };
}

// ── Stdin (interactive console) ───────────────────────────────────────────────
function sendStdin(scriptId, text) {
  const entry = processes[scriptId];
  if (!entry) return { ok: false, error: 'Not running' };
  const stdin = entry.process.stdin;
  if (!stdin || stdin.destroyed || !stdin.writable) {
    return { ok: false, error: 'stdin not available — the process may not accept input (common with shell:true). Try adding stdio:pipe to the script.' };
  }
  try {
    stdin.write(text + '\n');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Git pull ──────────────────────────────────────────────────────────────────
function gitPull(scriptId) {
  const script = getScript(scriptId);
  if (!script) return { ok: false, error: 'Script not found' };

  // Use gitDir if set, otherwise fall back to cwd, then script folder
  const repoDir = (script.gitDir && script.gitDir.trim())
    ? script.gitDir.trim()
    : (script.cwd && script.cwd.trim())
      ? script.cwd.trim()
      : path.dirname(script.path);

  // Use branch-specific pull if gitBranch is set
  const pullCmd = (script.gitBranch && script.gitBranch.trim())
    ? `git pull origin ${script.gitBranch.trim()}`
    : 'git pull';

  try {
    appendLog(scriptId, `🔄 ${pullCmd} in ${repoDir}…\n`);
    const out = execSync(pullCmd, { cwd: repoDir, encoding: 'utf8', timeout: 30000 });
    appendLog(scriptId, out + '\n');
    notify(`✅ ${script.name}`, 'Git pull successful');
    return { ok: true, output: out };
  } catch (e) {
    const msg = (e.stdout || e.stderr || e.message || '').toString();
    appendLog(scriptId, `[ERR] git pull failed: ${msg}\n`);
    notify(`❌ ${script.name}`, 'Git pull failed — check logs');
    return { ok: false, error: msg };
  }
}

// ── Script Dependencies & Auto-start ──────────────────────────────────────────
function startScriptsWithDependencies() {
  const toStart = scripts.filter(s => s.autoStart);
  const started = new Set();
  
  function canStart(script) {
    if (!script.dependencies || script.dependencies.length === 0) return true;
    return script.dependencies.every(depId => started.has(depId));
  }
  
  function startNext() {
    const ready = toStart.filter(s => !started.has(s.id) && canStart(s));
    if (ready.length === 0) return;
    
    ready.forEach(s => {
      startScript(s.id);
      started.add(s.id);
    });
    
    // Check again in case more scripts are now ready
    setTimeout(startNext, 2000);
  }
  
  startNext();
}

// ── Enhanced Logging ──────────────────────────────────────────────────────────
let scriptLogFiles = {};  // scriptId -> write stream

function getLogStream(scriptId) {
  if (scriptLogFiles[scriptId]) return scriptLogFiles[scriptId];
  
  const script = getScript(scriptId);
  if (!script) return null;
  
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
  
  const safeName = script.name.replace(/[^a-zA-Z0-9_-]/g, '_');
  const logPath = path.join(LOGS_DIR, `${safeName}-${scriptId}.log`);
  
  const stream = fs.createWriteStream(logPath, { flags: 'a' });
  scriptLogFiles[scriptId] = stream;
  return stream;
}

function logToFile(scriptId, text, level = 'INFO') {
  const stream = getLogStream(scriptId);
  if (!stream) return;
  
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] [${level}] ${text}`;
  stream.write(logLine + '\n');
}

function rotateLogs() {
  // Close all streams
  Object.values(scriptLogFiles).forEach(stream => stream.end());
  scriptLogFiles = {};
  
  // Archive old logs
  if (!fs.existsSync(LOGS_DIR)) return;
  
  const files = fs.readdirSync(LOGS_DIR);
  const date = new Date().toISOString().slice(0, 10);
  
  files.forEach(file => {
    if (!file.endsWith('.log')) return;
    
    const filePath = path.join(LOGS_DIR, file);
    const stats = fs.statSync(filePath);
    const sizeMB = stats.size / 1024 / 1024;
    
    // Rotate logs > 10MB or older than 7 days
    const age = Date.now() - stats.mtime.getTime();
    const days = age / (1000 * 60 * 60 * 24);
    
    if (sizeMB > 10 || days > 7) {
      const archiveName = file.replace('.log', `-${date}.log`);
      const archivePath = path.join(LOGS_DIR, 'archive');
      
      if (!fs.existsSync(archivePath)) {
        fs.mkdirSync(archivePath, { recursive: true });
      }
      
      fs.renameSync(filePath, path.join(archivePath, archiveName));
    }
  });
}

// ── Output Parsing ────────────────────────────────────────────────────────────
function parseOutput(scriptId, text) {
  const script = getScript(scriptId);
  if (!script || !script.outputPatterns || script.outputPatterns.length === 0) return;
  
  script.outputPatterns.forEach(pattern => {
    try {
      const regex = new RegExp(pattern.regex, pattern.flags || 'i');
      const match = text.match(regex);
      
      if (match) {
        appendLog(scriptId, `[PATTERN MATCH] "${pattern.name}": ${match[0]}\n`);
        
        if (pattern.action === 'restart') {
          appendLog(scriptId, `[AUTO-ACTION] Restarting due to output pattern match\n`);
          restartScript(scriptId);
        } else if (pattern.action === 'stop') {
          appendLog(scriptId, `[AUTO-ACTION] Stopping due to output pattern match\n`);
          stopScript(scriptId);
        } else if (pattern.action === 'notify') {
          notify(`🔍 ${script.name}`, `Pattern matched: ${pattern.name}`);
        }
        
        // Extract and store stats if pattern has capture groups
        if (match.length > 1 && pattern.extractStats) {
          script.extractedStats = script.extractedStats || {};
          script.extractedStats[pattern.name] = match.slice(1);
          send('extracted-stats', { scriptId, pattern: pattern.name, values: match.slice(1) });
        }
      }
    } catch (e) {
      // Invalid regex, ignore
    }
  });
}

// ── Profiles / Environments ───────────────────────────────────────────────────
function applyProfile(scriptId, profileName) {
  const script = getScript(scriptId);
  if (!script || !profiles[scriptId] || !profiles[scriptId][profileName]) {
    return { ok: false, error: 'Profile not found' };
  }
  
  const profile = profiles[scriptId][profileName];
  
  // Apply profile settings to script
  Object.keys(profile).forEach(key => {
    script[key] = profile[key];
  });
  
  script.activeProfile = profileName;
  saveScripts();
  
  appendLog(scriptId, `[PROFILE] Switched to profile: ${profileName}\n`);
  return { ok: true };
}

function saveProfile(scriptId, profileName, config) {
  if (!profiles[scriptId]) profiles[scriptId] = {};
  profiles[scriptId][profileName] = config;
  saveProfiles();
  return { ok: true };
}

function deleteProfile(scriptId, profileName) {
  if (profiles[scriptId] && profiles[scriptId][profileName]) {
    delete profiles[scriptId][profileName];
    saveProfiles();
    return { ok: true };
  }
  return { ok: false, error: 'Profile not found' };
}

// ── Cron ──────────────────────────────────────────────────────────────────────
function scheduleCron(script) {
  try {
    const cron = require('node-cron');
    if (cronJobs[script.id]) cronJobs[script.id].stop();
    if (!cron.validate(script.cronSchedule)) return;
    cronJobs[script.id] = cron.schedule(script.cronSchedule, () => {
      if (app.isQuitting) return;
      appendLog(script.id, `⏰ Cron triggered\n`);
      startScript(script.id);
    });
  } catch { /* node-cron not yet installed */ }
}

// ── Health Checks ─────────────────────────────────────────────────────────────
function startHealthCheck(scriptId) {
  const script = getScript(scriptId);
  if (!script || !script.healthCheckEnabled) return;
  
  // Clear existing timer if any
  if (healthCheckTimers[scriptId]) {
    clearInterval(healthCheckTimers[scriptId]);
  }

  const interval = (script.healthCheckInterval || 60) * 1000; // seconds to ms
  
  healthCheckTimers[scriptId] = setInterval(async () => {
    if (app.isQuitting || !processes[scriptId]) {
      // Script not running, clear the timer
      clearInterval(healthCheckTimers[scriptId]);
      delete healthCheckTimers[scriptId];
      return;
    }

    try {
      let healthy = false;
      
      if (script.healthCheckType === 'http') {
        // HTTP health check
        const url = script.healthCheckUrl || 'http://localhost:3000/health';
        try {
          const https = require('https');
          const http = require('http');
          const client = url.startsWith('https') ? https : http;
          
          await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Timeout')), 10000);
            client.get(url, (res) => {
              clearTimeout(timeout);
              healthy = res.statusCode >= 200 && res.statusCode < 300;
              resolve();
            }).on('error', reject);
          });
        } catch (e) {
          appendLog(scriptId, `[HEALTH CHECK] HTTP check failed: ${e.message}\n`);
          logToFile(scriptId, `Health check failed: ${e.message}`, 'WARN');
        }
      } else if (script.healthCheckType === 'process') {
        // Simple process check - is it still running?
        healthy = !!processes[scriptId];
      }

      if (!healthy) {
        script.healthStatus = 'unhealthy';
        script.lastHealthCheckFail = Date.now();
        saveScripts();
        
        appendLog(scriptId, `[HEALTH CHECK] Failed — script marked unhealthy\n`);
        logToFile(scriptId, 'Health check failed', 'WARN');
        notify(`💊 ${script.name}`, 'Health check failed');
        send('health-update', { scriptId, healthy: false });

        // Take action based on healthCheckAction
        if (script.healthCheckAction === 'restart') {
          appendLog(scriptId, `[AUTO-ACTION] Restarting due to failed health check\n`);
          restartScript(scriptId);
        } else if (script.healthCheckAction === 'stop') {
          appendLog(scriptId, `[AUTO-ACTION] Stopping due to failed health check\n`);
          stopScript(scriptId);
        }
      } else {
        if (script.healthStatus === 'unhealthy') {
          appendLog(scriptId, `[HEALTH CHECK] Recovered — script is healthy again\n`);
          logToFile(scriptId, 'Health check recovered', 'INFO');
        }
        script.healthStatus = 'healthy';
        saveScripts();
        send('health-update', { scriptId, healthy: true });
      }
    } catch (e) {
      appendLog(scriptId, `[HEALTH CHECK ERROR] ${e.message}\n`);
      logToFile(scriptId, `Health check error: ${e.message}`, 'ERROR');
    }
  }, interval);
}

function stopHealthCheck(scriptId) {
  if (healthCheckTimers[scriptId]) {
    clearInterval(healthCheckTimers[scriptId]);
    delete healthCheckTimers[scriptId];
  }
}

// ── Stats History & Analytics ─────────────────────────────────────────────────
function recordStatsHistory() {
  const now = Date.now();
  
  Object.entries(statsCache).forEach(([scriptId, stats]) => {
    if (!statsHistory[scriptId]) statsHistory[scriptId] = [];
    
    statsHistory[scriptId].push({
      timestamp: now,
      cpu: parseFloat(stats.cpu),
      mem: parseInt(stats.mem),
      uptime: stats.uptime
    });
    
    // Keep only last 7 days of data
    const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);
    statsHistory[scriptId] = statsHistory[scriptId].filter(s => s.timestamp > sevenDaysAgo);
  });
}

// ── Email Notifications ───────────────────────────────────────────────────────
async function sendEmail(subject, body) {
  const settings = loadSettings();
  
  if (!settings.smtp || !settings.smtp.enabled) return { ok: false, error: 'SMTP not enabled' };
  
  try {
    const nodemailer = require('nodemailer');
    
    const transporter = nodemailer.createTransport({
      host: settings.smtp.host,
      port: settings.smtp.port,
      secure: settings.smtp.secure || false,
      auth: {
        user: settings.smtp.user,
        pass: settings.smtp.pass
      }
    });
    
    await transporter.sendMail({
      from: settings.smtp.user,
      to: settings.smtp.alertEmail || settings.smtp.user,
      subject: `[ScriptManager] ${subject}`,
      text: body,
      html: `<div style="font-family:monospace;"><pre>${body}</pre></div>`
    });
    
    return { ok: true };
  } catch (e) {
    console.error('Email send failed:', e.message);
    return { ok: false, error: e.message };
  }
}

// ── Discord Webhook ───────────────────────────────────────────────────────────
async function sendDiscord(title, body, script = null) {
  const settings = loadSettings();
  if (!settings.discord || !settings.discord.enabled || !settings.discord.webhookUrl) return { ok: false, error: 'Discord not enabled' };
  try {
    const https = require('https');
    const scriptInfo = script ? `\n> **Script:** ${script.name}\n> **Path:** \`${script.path}\`` : '';
    const payload = JSON.stringify({
      username: 'ScriptManager',
      embeds: [{
        title: title,
        description: body + scriptInfo,
        color: title.toLowerCase().includes('crash') || title.toLowerCase().includes('error') ? 0xff4444 : 0x4af0a0,
        timestamp: new Date().toISOString(),
        footer: { text: 'ScriptManager' }
      }]
    });
    return await new Promise((resolve) => {
      const url = new URL(settings.discord.webhookUrl);
      const req = https.request({ hostname: url.hostname, path: url.pathname + url.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, res => {
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300 });
      });
      req.on('error', e => resolve({ ok: false, error: e.message }));
      req.write(payload);
      req.end();
    });
  } catch (e) {
    console.error('Discord webhook failed:', e.message);
    return { ok: false, error: e.message };
  }
}

// ── Slack Webhook ─────────────────────────────────────────────────────────────
async function sendSlack(title, body, script = null) {
  const settings = loadSettings();
  if (!settings.slack || !settings.slack.enabled || !settings.slack.webhookUrl) return { ok: false, error: 'Slack not enabled' };
  try {
    const https = require('https');
    const scriptInfo = script ? `\n*Script:* ${script.name}  |  *Path:* \`${script.path}\`` : '';
    const isError = title.toLowerCase().includes('crash') || title.toLowerCase().includes('error');
    const payload = JSON.stringify({
      attachments: [{
        color: isError ? '#ff4444' : '#4af0a0',
        title: `ScriptManager: ${title}`,
        text: body + scriptInfo,
        footer: 'ScriptManager',
        ts: Math.floor(Date.now() / 1000)
      }]
    });
    return await new Promise((resolve) => {
      const url = new URL(settings.slack.webhookUrl);
      const req = https.request({ hostname: url.hostname, path: url.pathname + url.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, res => {
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300 });
      });
      req.on('error', e => resolve({ ok: false, error: e.message }));
      req.write(payload);
      req.end();
    });
  } catch (e) {
    console.error('Slack webhook failed:', e.message);
    return { ok: false, error: e.message };
  }
}

// ── Custom Webhook ────────────────────────────────────────────────────────────
async function sendCustomWebhook(title, body, script = null) {
  const settings = loadSettings();
  if (!settings.customWebhook || !settings.customWebhook.enabled || !settings.customWebhook.url) return { ok: false, error: 'Custom webhook not enabled' };
  try {
    const https = require('https');
    const http = require('http');
    const payload = JSON.stringify({
      title,
      body,
      scriptName: script ? script.name : null,
      scriptPath: script ? script.path : null,
      timestamp: new Date().toISOString(),
      source: 'ScriptManager'
    });
    return await new Promise((resolve) => {
      const url = new URL(settings.customWebhook.url);
      const isHttps = url.protocol === 'https:';
      const lib = isHttps ? https : http;
      const customHeaders = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
      if (settings.customWebhook.secret) customHeaders['X-ScriptManager-Secret'] = settings.customWebhook.secret;
      const req = lib.request({ hostname: url.hostname, port: url.port || (isHttps ? 443 : 80), path: url.pathname + url.search, method: settings.customWebhook.method || 'POST', headers: customHeaders }, res => {
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300 });
      });
      req.on('error', e => resolve({ ok: false, error: e.message }));
      req.write(payload);
      req.end();
    });
  } catch (e) {
    console.error('Custom webhook failed:', e.message);
    return { ok: false, error: e.message };
  }
}

// Enhanced notify function with all notification channels
const originalNotify = notify;
function notifyWithEmail(title, body, scriptId = null) {
  // Windows notification
  originalNotify(title, body);
  
  const settings = loadSettings();
  const script = scriptId ? getScript(scriptId) : null;

  // Email if enabled
  if (settings.smtp && settings.smtp.enabled) {
    const emailBody = `${title}\n\n${body}\n\n${script ? `Script: ${script.name}\nPath: ${script.path}` : ''}`;
    sendEmail(title, emailBody);
  }

  // Discord if enabled
  if (settings.discord && settings.discord.enabled) {
    sendDiscord(title, body, script);
  }

  // Slack if enabled
  if (settings.slack && settings.slack.enabled) {
    sendSlack(title, body, script);
  }

  // Custom webhook if enabled
  if (settings.customWebhook && settings.customWebhook.enabled) {
    sendCustomWebhook(title, body, script);
  }
}
// Replace original notify
notify = notifyWithEmail;

// ── Script Triggers ───────────────────────────────────────────────────────────
function startFileWatcher(scriptId) {
  const script = getScript(scriptId);
  if (!script || !script.fileWatchEnabled || !script.fileWatchPath) return;
  
  try {
    if (fileWatchers[scriptId]) {
      fileWatchers[scriptId].close();
    }
    
    const watcher = fs.watch(script.fileWatchPath, { persistent: false }, (eventType, filename) => {
      if (app.isQuitting) return;
      
      appendLog(scriptId, `[FILE WATCH] ${eventType}: ${filename}\n`);
      logToFile(scriptId, `File watch triggered: ${eventType} ${filename}`, 'INFO');
      
      // Debounce: wait 1 second before acting
      if (fileWatchers[scriptId]._debounceTimer) {
        clearTimeout(fileWatchers[scriptId]._debounceTimer);
      }
      
      fileWatchers[scriptId]._debounceTimer = setTimeout(() => {
        if (script.fileWatchAction === 'restart') {
          appendLog(scriptId, `[AUTO-ACTION] Restarting due to file change\n`);
          restartScript(scriptId);
        } else if (script.fileWatchAction === 'start' && script.status !== 'running') {
          appendLog(scriptId, `[AUTO-ACTION] Starting due to file change\n`);
          startScript(scriptId);
        }
      }, 1000);
    });
    
    fileWatchers[scriptId] = watcher;
    appendLog(scriptId, `[FILE WATCH] Watching: ${script.fileWatchPath}\n`);
  } catch (e) {
    appendLog(scriptId, `[FILE WATCH ERROR] ${e.message}\n`);
  }
}

function stopFileWatcher(scriptId) {
  if (fileWatchers[scriptId]) {
    try {
      fileWatchers[scriptId].close();
    } catch (_) {}
    delete fileWatchers[scriptId];
  }
}

function startPortMonitor(scriptId) {
  const script = getScript(scriptId);
  if (!script || !script.portMonitorEnabled || !script.portMonitorPort) return;
  
  const checkPort = () => {
    if (app.isQuitting || !processes[scriptId]) {
      stopPortMonitor(scriptId);
      return;
    }
    
    const net = require('net');
    const tester = net.createConnection({ port: script.portMonitorPort, host: '127.0.0.1' });
    
    tester.on('connect', () => {
      tester.end();
      // Port is up, all good
    });
    
    tester.on('error', () => {
      // Port is down
      appendLog(scriptId, `[PORT MONITOR] Port ${script.portMonitorPort} is not responding\n`);
      logToFile(scriptId, `Port ${script.portMonitorPort} check failed`, 'WARN');
      
      if (script.portMonitorAction === 'restart') {
        appendLog(scriptId, `[AUTO-ACTION] Restarting due to port failure\n`);
        restartScript(scriptId);
      }
    });
  };
  
  // Check every 30 seconds
  portMonitors[scriptId] = setInterval(checkPort, 30000);
  appendLog(scriptId, `[PORT MONITOR] Monitoring port ${script.portMonitorPort}\n`);
}

function stopPortMonitor(scriptId) {
  if (portMonitors[scriptId]) {
    clearInterval(portMonitors[scriptId]);
    delete portMonitors[scriptId];
  }
}

// ── Webhook Server ────────────────────────────────────────────────────────────
let webhookServer = null;
const WEBHOOK_PORT = 19847; // fixed internal port

function startWebhookServer() {
  if (webhookServer) return; // already running
  const http = require('http');
  webhookServer = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405); res.end(JSON.stringify({ error: 'POST only' })); return;
    }
    // URL: /webhook/<token>
    const token = req.url.replace(/^\/webhook\//, '').split('?')[0];
    const script = scripts.find(s => s.webhookEnabled && s.webhookToken === token);
    if (!script) {
      res.writeHead(404); res.end(JSON.stringify({ error: 'Unknown token' })); return;
    }
    let body = '';
    req.on('data', d => { body += d; if (body.length > 8192) req.destroy(); });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(body); } catch (_) {}
      const action = payload.action || script.webhookAction || 'start';
      appendLog(script.id, `[WEBHOOK] Received POST → action: ${action}\n`);
      logToFile(script.id, `Webhook triggered: action=${action}`, 'INFO');
      if (action === 'start')   startScript(script.id);
      else if (action === 'stop')    stopScript(script.id);
      else if (action === 'restart') restartScript(script.id);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, script: script.name, action }));
    });
  });
  webhookServer.on('error', e => {
    console.error('[WEBHOOK SERVER]', e.message);
  });
  webhookServer.listen(WEBHOOK_PORT, '127.0.0.1', () => {
    console.log(`[WEBHOOK SERVER] Listening on port ${WEBHOOK_PORT}`);
  });
}

function stopWebhookServer() {
  if (webhookServer) { webhookServer.close(); webhookServer = null; }
}

function restartWebhookServer() {
  const anyWebhook = scripts.some(s => s.webhookEnabled && s.webhookToken);
  if (anyWebhook) startWebhookServer();
  else stopWebhookServer();
}

function generateWebhookToken() {
  return require('crypto').randomBytes(16).toString('hex');
}



// ── Script Collections ────────────────────────────────────────────────────────
async function startCollection(collectionId) {
  const collection = collections.find(c => c.id === collectionId);
  if (!collection) return { ok: false, error: 'Collection not found' };
  
  if (collection.startOrder === 'sequential') {
    // Start scripts one by one
    for (const scriptId of collection.scripts) {
      const result = startScript(scriptId);
      if (!result.ok) continue;
      // Wait 2 seconds between starts
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  } else {
    // Start all at once
    collection.scripts.forEach(scriptId => startScript(scriptId));
  }
  
  return { ok: true };
}

function stopCollection(collectionId) {
  const collection = collections.find(c => c.id === collectionId);
  if (!collection) return { ok: false, error: 'Collection not found' };
  
  collection.scripts.forEach(scriptId => stopScript(scriptId));
  return { ok: true };
}

// ── Script Sharing / Import ───────────────────────────────────────────────────
async function importScriptFromUrl(url) {
  try {
    const https = url.startsWith('https') ? require('https') : require('http');
    
    return new Promise((resolve, reject) => {
      https.get(url, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const imported = JSON.parse(data);
            if (!imported.script || !imported.script.name) {
              reject(new Error('Invalid script format'));
              return;
            }
            
            const script = {
              ...imported.script,
              id: Date.now().toString(),
              status: 'stopped',
              pid: null,
              crashCount: 0
            };
            
            scripts.push(script);
            saveScripts();
            resolve({ ok: true, script });
          } catch (e) {
            reject(e);
          }
        });
      }).on('error', reject);
    });
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function exportScriptAsJson(scriptId) {
  const script = getScript(scriptId);
  if (!script) return { ok: false, error: 'Script not found' };
  
  const exported = {
    name: script.name,
    author: 'ScriptManager User',
    version: '1.0.0',
    exported: new Date().toISOString(),
    script: {
      name: script.name,
      type: script.type,
      runtime: script.runtime,
      notes: script.notes,
      env: script.env,
      autoRestart: script.autoRestart,
      cronEnabled: script.cronEnabled,
      cronSchedule: script.cronSchedule,
      healthCheckEnabled: script.healthCheckEnabled,
      healthCheckType: script.healthCheckType,
      healthCheckUrl: script.healthCheckUrl,
      healthCheckInterval: script.healthCheckInterval
    }
  };
  
  return { ok: true, json: JSON.stringify(exported, null, 2) };
}

// ── Backup & Restore ──────────────────────────────────────────────────────────
function safeCopyFile(src, dest) {
  try {
    if (!src || !fs.existsSync(src) || fs.statSync(src).isDirectory()) return false;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    return true;
  } catch (_) { return false; }
}

function safeCopyDir(src, dest) {
  try {
    if (!src || !fs.existsSync(src)) return false;
    const stat = fs.statSync(src);
    if (!stat.isDirectory()) return safeCopyFile(src, dest);
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      const from = path.join(src, name);
      const to = path.join(dest, name);
      const st = fs.statSync(from);
      if (st.isDirectory()) safeCopyDir(from, to);
      else safeCopyFile(from, to);
    }
    return true;
  } catch (_) { return false; }
}

function recursiveSize(dir) {
  try {
    if (!fs.existsSync(dir)) return 0;
    const st = fs.statSync(dir);
    if (!st.isDirectory()) return st.size;
    return fs.readdirSync(dir).reduce((sum, name) => sum + recursiveSize(path.join(dir, name)), 0);
  } catch (_) { return 0; }
}

function fullBackupFiles() {
  return [
    { key: 'scripts', file: DATA_FILE, name: 'scripts.json' },
    { key: 'groups', file: GROUPS_FILE, name: 'groups.json' },
    { key: 'templates', file: TEMPLATES_FILE, name: 'templates.json' },
    { key: 'profiles', file: PROFILES_FILE, name: 'profiles.json' },
    { key: 'collections', file: COLLECTIONS_FILE, name: 'collections.json' },
    { key: 'settings', file: SETTINGS_FILE, name: 'settings.json' },
    { key: 'statsHistory', file: STATS_HISTORY_FILE, name: 'stats-history.json' },
  ];
}

function backupScriptFiles(options = {}) {
  const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const backupPath = path.join(BACKUP_DIR, `full-backup-${timestamp}`);
  fs.mkdirSync(backupPath, { recursive: true });
  fs.mkdirSync(path.join(backupPath, 'config'), { recursive: true });
  fs.mkdirSync(path.join(backupPath, 'script-files'), { recursive: true });

  const manifest = {
    app: 'ScriptManager',
    version: APP_VERSION,
    timestamp,
    createdAt: new Date().toISOString(),
    dataDir: DATA_DIR,
    configFiles: [],
    scripts: [],
    logsIncluded: !!options.includeLogs,
  };

  for (const item of fullBackupFiles()) {
    if (fs.existsSync(item.file)) {
      const dest = path.join(backupPath, 'config', item.name);
      if (safeCopyFile(item.file, dest)) manifest.configFiles.push({ key: item.key, name: item.name });
    }
  }

  scripts.forEach(script => {
    try {
      if (!script.path || !fs.existsSync(script.path)) return;
      const stat = fs.statSync(script.path);
      if (stat.isDirectory()) return; // Project folders are usually huge; config is backed up instead.
      const fileName = path.basename(script.path);
      const backupFile = path.join('script-files', `${script.id}-${fileName}`);
      const destPath = path.join(backupPath, backupFile);
      if (safeCopyFile(script.path, destPath)) {
        manifest.scripts.push({
          id: script.id,
          name: script.name,
          originalPath: script.path,
          backupFile,
        });
      }
    } catch (e) {
      console.error(`Failed to backup script ${script.id}:`, e.message);
    }
  });

  if (options.includeLogs !== false && fs.existsSync(LOGS_DIR)) {
    safeCopyDir(LOGS_DIR, path.join(backupPath, 'logs'));
    manifest.logsIncluded = true;
  }

  fs.writeFileSync(path.join(backupPath, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { ok: true, path: backupPath, manifest, size: recursiveSize(backupPath) };
}

function restoreScriptFiles(backupPath) {
  try {
    const manifestPath = path.join(backupPath, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return { ok: false, error: 'Invalid backup: manifest.json not found' };
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const restored = [];

    const configDir = path.join(backupPath, 'config');
    const configTargets = {
      'scripts.json': DATA_FILE,
      'groups.json': GROUPS_FILE,
      'templates.json': TEMPLATES_FILE,
      'profiles.json': PROFILES_FILE,
      'collections.json': COLLECTIONS_FILE,
      'settings.json': SETTINGS_FILE,
      'stats-history.json': STATS_HISTORY_FILE,
    };
    Object.entries(configTargets).forEach(([name, target]) => {
      const src = path.join(configDir, name);
      if (fs.existsSync(src) && safeCopyFile(src, target)) restored.push(name);
    });

    (manifest.scripts || []).forEach(entry => {
      const backupFile = path.join(backupPath, entry.backupFile);
      if (fs.existsSync(backupFile) && fs.existsSync(path.dirname(entry.originalPath))) {
        fs.copyFileSync(backupFile, entry.originalPath);
        restored.push(entry.name || path.basename(entry.originalPath));
      }
    });

    const logsSrc = path.join(backupPath, 'logs');
    if (fs.existsSync(logsSrc)) {
      safeCopyDir(logsSrc, LOGS_DIR);
      restored.push('logs');
    }

    loadScripts(); loadGroups(); loadTemplates(); loadProfiles(); loadCollections(); loadStatsHistory();
    scripts.forEach(s => { s.status = 'stopped'; s.pid = null; s.startedAt = null; });
    saveScripts();
    updateTrayMenu();
    return { ok: true, restored, count: restored.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Dependency Installer ─────────────────────────────────────────────────────
function resolveWorkingDir(script) {
  if (!script) return DATA_DIR;
  if (script.cwd && script.cwd.trim()) return script.cwd.trim();
  if (script.path && script.path.trim()) {
    const pth = script.path.trim();
    try { return fs.statSync(pth).isDirectory() ? pth : path.dirname(pth); }
    catch (_) { return path.dirname(pth); }
  }
  return DATA_DIR;
}

function detectDependencyPlan(script) {
  if (!script) return { ok: false, error: 'Script not found' };
  const cwd = resolveWorkingDir(script);
  const packageJson = path.join(cwd, 'package.json');
  const packageLock = path.join(cwd, 'package-lock.json');
  const requirements = path.join(cwd, 'requirements.txt');
  const pyproject = path.join(cwd, 'pyproject.toml');

  if (fs.existsSync(packageJson) || ['node', 'discord-node', 'node-npm-start', 'node-npm-dev', 'bun', 'deno'].includes(script.type)) {
    const command = fs.existsSync(packageLock) ? 'npm ci' : 'npm install';
    return { ok: true, type: 'node', cwd, command, reason: fs.existsSync(packageLock) ? 'package-lock.json found' : 'package.json / Node project detected' };
  }

  if (fs.existsSync(requirements) || fs.existsSync(pyproject) || ['python', 'discord-python'].includes(script.type)) {
    const runtime = (script.runtime && script.runtime.trim()) || 'python';
    const command = fs.existsSync(requirements)
      ? `${runtime} -m pip install -r requirements.txt`
      : `${runtime} -m pip install -e .`;
    return { ok: true, type: 'python', cwd, command, reason: fs.existsSync(requirements) ? 'requirements.txt found' : 'Python project detected' };
  }

  return { ok: false, error: 'No supported dependency file found. Expected package.json, requirements.txt, or pyproject.toml.' };
}

function installDependencies(scriptId) {
  const script = getScript(scriptId);
  const plan = detectDependencyPlan(script);
  if (!plan.ok) return plan;

  appendLog(scriptId, `📦 Installing dependencies: ${plan.command}\n`);
  appendLog(scriptId, `📁 Dependency cwd: ${plan.cwd}\n`);
  notify(`📦 ${script.name}`, 'Dependency install started');

  const proc = spawn(plan.command, [], { cwd: plan.cwd, shell: true, env: process.env, windowsHide: true });
  proc.stdout.on('data', d => appendLog(scriptId, d.toString()));
  proc.stderr.on('data', d => appendLog(scriptId, `[ERR] ${d.toString()}`));
  proc.on('close', code => {
    appendLog(scriptId, `📦 Dependency install finished with code ${code}\n`);
    notify(code === 0 ? `✅ ${script.name}` : `❌ ${script.name}`, code === 0 ? 'Dependencies installed' : 'Dependency install failed — check logs');
  });
  proc.on('error', e => appendLog(scriptId, `[ERROR] Dependency install failed: ${e.message}\n`));
  return { ok: true, ...plan };
}

function checkDependencyTools(scriptId) {
  const script = getScript(scriptId);
  if (!script) return { ok: false, error: 'Script not found' };
  const plan = detectDependencyPlan(script);
  const tools = [];
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const names = plan.type === 'python' ? ['python', 'pip'] : ['node', 'npm'];
  for (const name of names) {
    try {
      const found = execSync(`${cmd} ${name}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().split(/\r?\n/)[0];
      tools.push({ name, ok: true, path: found });
    } catch (_) {
      tools.push({ name, ok: false, path: '' });
    }
  }
  return { ok: true, plan, tools };
}

// ── Setup Wizard Detection ───────────────────────────────────────────────────
function inspectProjectFolder(projectDir) {
  try {
    if (!projectDir || !fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
      return { ok: false, error: 'Select a valid project folder.' };
    }
    const files = new Set(fs.readdirSync(projectDir));
    const result = { ok: true, cwd: projectDir, files: Array.from(files), suggestions: [] };

    if (files.has('package.json')) {
      let pkg = {};
      try { pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8')); } catch (_) {}
      const scriptsObj = pkg.scripts || {};
      const hasDev = !!scriptsObj.dev;
      result.suggestions.push({
        name: pkg.name || path.basename(projectDir),
        type: hasDev ? 'node-npm-dev' : 'node-npm-start',
        runtime: '',
        path: projectDir,
        cwd: projectDir,
        args: '',
        notes: `Detected Node.js project. ${Object.keys(scriptsObj).length ? `npm scripts: ${Object.keys(scriptsObj).join(', ')}` : 'No npm scripts found.'}`,
        installCommand: files.has('package-lock.json') ? 'npm ci' : 'npm install',
      });
    }

    const pyCandidates = ['main.py', 'app.py', 'bot.py', 'server.py', 'index.py'];
    const pyFile = pyCandidates.find(f => files.has(f)) || Array.from(files).find(f => f.endsWith('.py'));
    if (pyFile || files.has('requirements.txt') || files.has('pyproject.toml')) {
      result.suggestions.push({
        name: path.basename(projectDir),
        type: 'python',
        runtime: 'python',
        path: pyFile ? path.join(projectDir, pyFile) : '',
        cwd: projectDir,
        args: '',
        notes: `Detected Python project${pyFile ? ` using ${pyFile}` : ''}.`,
        installCommand: files.has('requirements.txt') ? 'python -m pip install -r requirements.txt' : 'python -m pip install -e .',
      });
    }

    const ps1 = Array.from(files).find(f => f.endsWith('.ps1'));
    if (ps1) {
      result.suggestions.push({ name: path.basename(projectDir), type: 'powershell', runtime: 'powershell', path: path.join(projectDir, ps1), cwd: projectDir, args: '', notes: `Detected PowerShell script ${ps1}.` });
    }
    const bat = Array.from(files).find(f => f.endsWith('.bat') || f.endsWith('.cmd'));
    if (bat) {
      result.suggestions.push({ name: path.basename(projectDir), type: 'batch', runtime: 'cmd', path: path.join(projectDir, bat), cwd: projectDir, args: '', notes: `Detected batch script ${bat}.` });
    }

    if (!result.suggestions.length) result.warning = 'No common Node/Python/PowerShell/Batch entry file was detected.';
    return result;
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Auto Update Check ────────────────────────────────────────────────────────
function fetchText(url) {
  return new Promise((resolve, reject) => {
    try {
      const parsed = new URL(url);
      const lib = parsed.protocol === 'https:' ? require('https') : require('http');
      const req = lib.get({
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        headers: { 'User-Agent': `ScriptManager/${APP_VERSION}`, 'Accept': 'application/json, text/plain;q=0.9, */*;q=0.8' },
      }, res => {
        let data = '';
        res.on('data', d => { data += d; if (data.length > 1024 * 1024) req.destroy(new Error('Response too large')); });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) reject(new Error(`HTTP ${res.statusCode}`));
          else resolve(data);
        });
      });
      req.setTimeout(15000, () => req.destroy(new Error('Request timed out')));
      req.on('error', reject);
    } catch (e) { reject(e); }
  });
}

async function checkForUpdates(customUrl = '') {
  const settings = loadSettings();
  const url = (customUrl || settings.updateCheck?.url || '').trim();
  if (!url) return { ok: false, error: 'No update URL configured. Add a GitHub latest-release API URL or a JSON file with a version field.' };
  try {
    const text = await fetchText(url);
    let latest = '', releaseUrl = '', notes = '';
    try {
      const json = JSON.parse(text);
      latest = json.tag_name || json.version || json.latest || json.name || '';
      releaseUrl = json.html_url || json.url || json.download_url || '';
      notes = json.body || json.notes || '';
    } catch (_) {
      latest = text.trim().split(/\s+/)[0];
    }
    latest = String(latest || '').replace(/^v/i, '');
    if (!latest) return { ok: false, error: 'Could not find a version in the update response.' };
    const cmp = compareVersions(latest, APP_VERSION);
    return { ok: true, current: APP_VERSION, latest, updateAvailable: cmp > 0, releaseUrl, notes: notes.slice(0, 1200) };
  } catch (e) {
    return { ok: false, error: e.message, current: APP_VERSION };
  }
}

// ── Web UI Server ─────────────────────────────────────────────────────────────
function getWebUIRuntimeStatus() {
  const settings = loadSettings().webUI || {};
  return {
    configured: !!settings.enabled,
    running: !!webServer,
    host: settings.host || '127.0.0.1',
    port: Number(settings.port) || 3333,
    token: settings.token || '',
    url: `http://${settings.host || '127.0.0.1'}:${Number(settings.port) || 3333}`,
  };
}

function stopWebUI() {
  if (webServer) {
    try { webServer.close(); } catch (_) {}
    webServer = null;
  }
}

function webPage(settings) {
  const token = escapeHtml(settings.token || '');
  return `<!doctype html><html><head><meta charset="utf-8"><title>ScriptManager Web</title><style>
  body{font-family:Segoe UI,Arial,sans-serif;background:#0b0d11;color:#c8d0e0;margin:0;padding:22px} h1{color:#4af0a0} .bar{display:flex;gap:8px;align-items:center;margin-bottom:16px}.card{background:#191c25;border:1px solid #2e3545;border-radius:10px;margin:10px 0;padding:14px}.muted{color:#68738d}.status{font-weight:700}.running{color:#4af0a0}.stopped{color:#ffaa33}.crashed{color:#ff4466}button,input{border-radius:6px;border:1px solid #2e3545;background:#13161d;color:#c8d0e0;padding:8px 10px}button{cursor:pointer}button:hover{border-color:#4af0a0}</style></head><body>
  <h1>ScriptManager Web Panel</h1><div class="bar"><input id="token" value="${token}" placeholder="Access token" style="width:320px"><button id="refresh" type="button">Refresh</button><span id="msg" class="muted"></span></div><div id="scripts"><div class="card muted">Loading scripts...</div></div>
  <script>
  const tokenInput=document.getElementById('token');
  const message=document.getElementById('msg');
  const scriptsBox=document.getElementById('scripts');
  const api=async(path,opts={})=>{
    const separator=path.includes('?')?'&':'?';
    const response=await fetch(path+separator+'token='+encodeURIComponent(tokenInput.value),opts);
    const data=await response.json();
    if(!response.ok&&!data.error)data.error='Request failed ('+response.status+')';
    return data;
  };
  async function action(id,name){
    message.textContent='Working...';
    try{
      const result=await api('/api/scripts/'+encodeURIComponent(id)+'/'+name,{method:'POST'});
      message.textContent=result.ok?'OK':(result.error||'Failed');
      await loadScripts();
    }catch(error){
      message.textContent=error.message||'Request failed';
    }
  }
  async function loadScripts(){
    scriptsBox.innerHTML='<div class="card muted">Loading scripts...</div>';
    try{
      const data=await api('/api/scripts');
      if(data.error){
        scriptsBox.innerHTML='<div class="card">'+esc(data.error)+'</div>';
        return;
      }
      scriptsBox.innerHTML=(data.scripts||[]).map(script=>{
        const status=String(script.status||'stopped');
        const id=esc(script.id);
        return '<div class="card"><div><b>'+esc(script.name)+'</b> <span class="status '+esc(status)+'">'+esc(status)+'</span></div><div class="muted">'+esc(script.path||script.cwd||'')+'</div><p><button type="button" data-id="'+id+'" data-action="start">Start</button> <button type="button" data-id="'+id+'" data-action="stop">Stop</button> <button type="button" data-id="'+id+'" data-action="restart">Restart</button></p></div>';
      }).join('')||'<div class="card">No scripts registered.</div>';
    }catch(error){
      scriptsBox.innerHTML='<div class="card">Could not load scripts: '+esc(error.message||error)+'</div>';
    }
  }
  function esc(x){return String(x||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
  document.getElementById('refresh').addEventListener('click',loadScripts);
  scriptsBox.addEventListener('click',event=>{
    const button=event.target.closest('button[data-action]');
    if(button)action(button.dataset.id,button.dataset.action);
  });
  tokenInput.addEventListener('keydown',event=>{if(event.key==='Enter')loadScripts()});
  loadScripts();
  </script></body></html>`;
}

function startWebUI() {
  stopWebUI();
  const settingsAll = loadSettings();
  const settings = settingsAll.webUI || {};
  if (!settings.enabled) return { ok: true, enabled: false };
  if (!settings.token) {
    settings.token = require('crypto').randomBytes(18).toString('hex');
    settingsAll.webUI = settings;
    saveSettings(settingsAll);
  }
  const host = settings.host || '127.0.0.1';
  const port = Number(settings.port) || 3333;

  try {
    const http = require('http');
    webServer = http.createServer((req, res) => {
      const parsed = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
      const token = parsed.searchParams.get('token') || req.headers['x-scriptmanager-token'];
      const sendJson = (code, payload) => {
        res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-ScriptManager-Token' });
        res.end(JSON.stringify(payload));
      };
      if (req.method === 'OPTIONS') return sendJson(204, {});
      if (parsed.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(webPage(settings));
        return;
      }
      if (token !== settings.token) return sendJson(401, { ok: false, error: 'Unauthorized' });

      if (parsed.pathname === '/api/scripts' && req.method === 'GET') {
        return sendJson(200, { ok: true, scripts, groups, stats: statsCache });
      }
      const match = parsed.pathname.match(/^\/api\/scripts\/([^/]+)\/(start|stop|restart|deps)$/);
      if (match && req.method === 'POST') {
        const [, scriptId, action] = match;
        const result = action === 'start' ? startScript(scriptId)
          : action === 'stop' ? stopScript(scriptId)
          : action === 'restart' ? restartScript(scriptId)
          : installDependencies(scriptId);
        return sendJson(result.ok ? 200 : 400, result);
      }
      if (parsed.pathname === '/api/stats' && req.method === 'GET') return sendJson(200, { ok: true, stats: statsCache });
      sendJson(404, { ok: false, error: 'Not found' });
    });
    webServer.on('error', e => console.error('Failed to start web UI:', e.message));
    webServer.listen(port, host, () => console.log(`Web UI running on http://${host}:${port}`));
    return { ok: true, enabled: true, host, port, token: settings.token };
  } catch (e) {
    webServer = null;
    return { ok: false, error: e.message };
  }
}

// ── Health Checks (old location marker - already moved above) ─────────────────

// ── IPC ───────────────────────────────────────────────────────────────────────
ipcMain.handle('get-scripts', () => scripts);
ipcMain.handle('get-groups', () => groups);

ipcMain.handle('get-app-version', () => ({ version: APP_VERSION }));
ipcMain.handle('install-dependencies', (_, scriptId) => installDependencies(scriptId));
ipcMain.handle('check-dependency-tools', (_, scriptId) => checkDependencyTools(scriptId));
ipcMain.handle('inspect-project-folder', (_, folder) => inspectProjectFolder(folder));
ipcMain.handle('check-for-updates', async (_, url) => await checkForUpdates(url));
ipcMain.handle('get-webui-settings', () => getWebUIRuntimeStatus());
ipcMain.handle('save-webui-settings', (_, cfg) => {
  const settings = loadSettings();
  const oldToken = settings.webUI?.token || '';
  settings.webUI = {
    enabled: !!cfg.enabled,
    host: (cfg.host || '127.0.0.1').trim(),
    port: Math.max(1, Math.min(65535, parseInt(cfg.port, 10) || 3333)),
    token: (cfg.token || oldToken || require('crypto').randomBytes(18).toString('hex')).trim(),
  };
  saveSettings(settings);
  const r = startWebUI();
  return { ok: r.ok !== false, ...getWebUIRuntimeStatus(), error: r.error };
});
ipcMain.handle('generate-webui-token', () => ({ token: require('crypto').randomBytes(18).toString('hex') }));
ipcMain.handle('get-update-settings', () => loadSettings().updateCheck || {});
ipcMain.handle('save-update-settings', (_, cfg) => {
  const settings = loadSettings();
  settings.updateCheck = { enabled: !!cfg.enabled, url: (cfg.url || '').trim() };
  saveSettings(settings);
  return { ok: true, updateCheck: settings.updateCheck };
});

ipcMain.handle('add-group', (_, data) => {
  const group = {
    id: Date.now().toString(),
    name: data.name,
    color: data.color || '#5a6480',
  };
  groups.push(group);
  saveGroups();
  return group;
});

ipcMain.handle('update-group', (_, data) => {
  const idx = groups.findIndex(g => g.id === data.id);
  if (idx === -1) return { ok: false };
  groups[idx] = { ...groups[idx], ...data };
  saveGroups();
  return { ok: true, group: groups[idx] };
});

ipcMain.handle('remove-group', (_, id) => {
  // Move all scripts in this group to default
  scripts.forEach(s => {
    if (s.groupId === id) s.groupId = 'default';
  });
  groups = groups.filter(g => g.id !== id);
  saveGroups();
  saveScripts();
  return { ok: true };
});

ipcMain.handle('add-script', (_, data) => {
  const script = {
    id: Date.now().toString(),
    name: data.name, type: data.type, path: data.path,
    notes: data.notes || '',
    cwd: data.cwd || '', runtime: data.runtime || '', args: data.args || '',
    autoStart: data.autoStart || false,
    autoRestart: data.autoRestart || 'never',
    cronEnabled: data.cronEnabled || false, cronSchedule: data.cronSchedule || '',
    env: data.env || [],
    gitEnabled: data.gitEnabled || false,
    gitDir: data.gitDir || '',
    gitBranch: data.gitBranch || '',
    gitOnStart: data.gitOnStart || false,
    groupId: data.groupId || 'default',
    
    // Dependencies
    dependencies: data.dependencies || [],
    
    // Resource limits
    resourceLimitsEnabled: data.resourceLimitsEnabled || false,
    cpuLimit: data.cpuLimit || 90,
    memLimit: data.memLimit || 1024,
    resourceAction: data.resourceAction || 'alert',
    
    // Health checks
    healthCheckEnabled: data.healthCheckEnabled || false,
    healthCheckType: data.healthCheckType || 'process',
    healthCheckUrl: data.healthCheckUrl || '',
    healthCheckInterval: data.healthCheckInterval || 60,
    healthCheckAction: data.healthCheckAction || 'alert',
    healthStatus: 'healthy',
    
    // Output parsing
    outputPatterns: data.outputPatterns || [],
    
    status: 'stopped', pid: null, startedAt: null,
    crashCount: 0, lastCrash: null, lastStopped: null,
  };
  scripts.push(script);
  saveScripts();
  if (script.cronEnabled && script.cronSchedule) scheduleCron(script);
  updateTrayMenu();
  return script;
});

ipcMain.handle('remove-script', (_, id) => {
  stopScript(id);
  if (cronJobs[id]) { cronJobs[id].stop(); delete cronJobs[id]; }
  scripts = scripts.filter(s => s.id !== id);
  saveScripts(); updateTrayMenu();
  return { ok: true };
});

ipcMain.handle('update-script', (_, data) => {
  const idx = scripts.findIndex(s => s.id === data.id);
  if (idx === -1) return { ok: false };
  
  const oldScript = scripts[idx];
  scripts[idx] = { ...scripts[idx], ...data };
  saveScripts();
  
  if (scripts[idx].cronEnabled && scripts[idx].cronSchedule) scheduleCron(scripts[idx]);

  // Restart file watcher if settings changed
  stopFileWatcher(data.id);
  if (scripts[idx].fileWatchEnabled && scripts[idx].fileWatchPath) startFileWatcher(data.id);

  // Restart port monitor if settings changed
  stopPortMonitor(data.id);
  if (scripts[idx].portMonitorEnabled && scripts[idx].portMonitorPort) startPortMonitor(data.id);

  // Restart webhook listener if token changed
  if (scripts[idx].webhookEnabled) restartWebhookServer();

  // Restart health check if settings changed
  if (scripts[idx].healthCheckEnabled && processes[data.id]) {
    stopHealthCheck(data.id);
    startHealthCheck(data.id);
  } else if (!scripts[idx].healthCheckEnabled) {
    stopHealthCheck(data.id);
  }
  
  updateTrayMenu();
  return { ok: true, script: scripts[idx] };
});

ipcMain.handle('start-script',   (_, id)       => startScript(id));
ipcMain.handle('stop-script',    (_, id)       => stopScript(id));
ipcMain.handle('restart-script', (_, id)       => restartScript(id));
ipcMain.handle('send-stdin',     (_, id, text) => sendStdin(id, text));
ipcMain.handle('git-pull',       (_, id)       => gitPull(id));
ipcMain.handle('git-pull-restart', async (_, id) => {
  const r = gitPull(id);
  if (r.ok) { stopScript(id); setTimeout(() => startScript(id), 1200); }
  return r;
});

ipcMain.handle('reset-crash-count', (_, id) => {
  const s = getScript(id);
  if (s) { s.crashCount = 0; s.lastCrash = null; saveScripts(); }
  return { ok: true };
});

// ── Templates ─────────────────────────────────────────────────────────────────
ipcMain.handle('get-templates', () => templates);

ipcMain.handle('create-from-template', (_, { templateId, name, path, cwd }) => {
  const template = templates.find(t => t.id === templateId);
  if (!template) return { ok: false, error: 'Template not found' };
  
  const script = {
    ...template,
    id: Date.now().toString(),
    name: name || template.name,
    path: path || '',
    cwd: cwd || '',
    status: 'stopped',
    pid: null,
    startedAt: null,
    crashCount: 0,
    lastCrash: null,
    lastStopped: null,
  };
  
  delete script.id; // Remove template id
  script.id = Date.now().toString(); // Generate new id
  
  scripts.push(script);
  saveScripts();
  return { ok: true, script };
});

// ── Profiles ──────────────────────────────────────────────────────────────────
ipcMain.handle('get-profiles', (_, scriptId) => profiles[scriptId] || {});
ipcMain.handle('save-profile', (_, { scriptId, profileName, config }) => saveProfile(scriptId, profileName, config));
ipcMain.handle('apply-profile', (_, { scriptId, profileName }) => applyProfile(scriptId, profileName));
ipcMain.handle('delete-profile', (_, { scriptId, profileName }) => deleteProfile(scriptId, profileName));

// ── Collections ───────────────────────────────────────────────────────────────
ipcMain.handle('get-collections', () => collections);
ipcMain.handle('add-collection', (_, data) => {
  const collection = {
    id: Date.now().toString(),
    name: data.name,
    color: data.color || '#4af0a0',
    scripts: data.scripts || [],
    startOrder: data.startOrder || 'parallel'
  };
  collections.push(collection);
  saveCollections();
  return collection;
});
ipcMain.handle('update-collection', (_, data) => {
  const idx = collections.findIndex(c => c.id === data.id);
  if (idx === -1) return { ok: false };
  collections[idx] = { ...collections[idx], ...data };
  saveCollections();
  return { ok: true };
});
ipcMain.handle('delete-collection', (_, id) => {
  collections = collections.filter(c => c.id !== id);
  saveCollections();
  return { ok: true };
});
ipcMain.handle('reorder-collections', (_, orderedIds) => {
  const reordered = orderedIds.map(id => collections.find(c => c.id === id)).filter(Boolean);
  const rest = collections.filter(c => !orderedIds.includes(c.id));
  collections = [...reordered, ...rest];
  saveCollections();
  return { ok: true };
});
ipcMain.handle('start-collection', (_, id) => startCollection(id));
ipcMain.handle('stop-collection', (_, id) => stopCollection(id));

// ── Stats History ─────────────────────────────────────────────────────────────
// ── Trigger IPC ───────────────────────────────────────────────────────────────
ipcMain.handle('test-port', (_, port) => {
  return new Promise(resolve => {
    const net = require('net');
    const tester = net.createConnection({ port, host: '127.0.0.1' });
    tester.on('connect', () => { tester.end(); resolve({ ok: true, listening: true }); });
    tester.on('error', () => resolve({ ok: true, listening: false }));
  });
});

ipcMain.handle('generate-webhook-token', () => ({ token: generateWebhookToken() }));

ipcMain.handle('get-webhook-port', () => ({ port: WEBHOOK_PORT }));

ipcMain.handle('get-trigger-status', (_, scriptId) => ({
  fileWatcher: !!fileWatchers[scriptId],
  portMonitor: !!portMonitors[scriptId],
  webhookActive: !!(scripts.find(s => s.id === scriptId)?.webhookEnabled),
}));

ipcMain.handle('get-stats-history', (_, { scriptId, timeRange }) => {
  if (!statsHistory[scriptId]) return [];
  
  const now = Date.now();
  let cutoff = now - (24 * 60 * 60 * 1000); // Default 24 hours
  
  if (timeRange === '1h') cutoff = now - (60 * 60 * 1000);
  else if (timeRange === '6h') cutoff = now - (6 * 60 * 60 * 1000);
  else if (timeRange === '7d') cutoff = now - (7 * 24 * 60 * 60 * 1000);
  
  return statsHistory[scriptId].filter(s => s.timestamp > cutoff);
});

// ── Email / SMTP ──────────────────────────────────────────────────────────────
ipcMain.handle('get-smtp-settings', () => {
  const settings = loadSettings();
  return settings.smtp || { enabled: false };
});
ipcMain.handle('save-smtp-settings', (_, smtpConfig) => {
  const settings = loadSettings();
  settings.smtp = smtpConfig;
  saveSettings(settings);
  return { ok: true };
});
ipcMain.handle('test-email', async (_, testEmail) => {
  return await sendEmail('Test Email', `This is a test email from ScriptManager.\n\nSent at: ${new Date().toLocaleString()}`);
});

// ── Discord IPC ───────────────────────────────────────────────────────────────
ipcMain.handle('get-discord-settings', () => {
  const settings = loadSettings();
  return settings.discord || { enabled: false, webhookUrl: '' };
});
ipcMain.handle('save-discord-settings', (_, config) => {
  const settings = loadSettings();
  settings.discord = config;
  saveSettings(settings);
  return { ok: true };
});
ipcMain.handle('test-discord', async () => {
  return await sendDiscord('Test Notification', `This is a test from ScriptManager.\n\nSent at: ${new Date().toLocaleString()}`);
});

// ── Slack IPC ─────────────────────────────────────────────────────────────────
ipcMain.handle('get-slack-settings', () => {
  const settings = loadSettings();
  return settings.slack || { enabled: false, webhookUrl: '' };
});
ipcMain.handle('save-slack-settings', (_, config) => {
  const settings = loadSettings();
  settings.slack = config;
  saveSettings(settings);
  return { ok: true };
});
ipcMain.handle('test-slack', async () => {
  return await sendSlack('Test Notification', `This is a test from ScriptManager.\n\nSent at: ${new Date().toLocaleString()}`);
});

// ── Custom Webhook IPC ────────────────────────────────────────────────────────
ipcMain.handle('get-custom-webhook-settings', () => {
  const settings = loadSettings();
  return settings.customWebhook || { enabled: false, url: '', method: 'POST', secret: '' };
});
ipcMain.handle('save-custom-webhook-settings', (_, config) => {
  const settings = loadSettings();
  settings.customWebhook = config;
  saveSettings(settings);
  return { ok: true };
});
ipcMain.handle('test-custom-webhook', async () => {
  return await sendCustomWebhook('Test Notification', `This is a test from ScriptManager.\n\nSent at: ${new Date().toLocaleString()}`);
});

// ── Script Sharing ────────────────────────────────────────────────────────────
ipcMain.handle('import-from-url', async (_, url) => await importScriptFromUrl(url));
ipcMain.handle('export-script-json', (_, scriptId) => exportScriptAsJson(scriptId));

// ── Backup & Restore ──────────────────────────────────────────────────────────
ipcMain.handle('backup-scripts', () => backupScriptFiles());

ipcMain.handle('restore-scripts', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Backup Folder',
    properties: ['openDirectory'],
    defaultPath: BACKUP_DIR,
  });
  
  if (result.canceled) return { ok: false };
  
  return restoreScriptFiles(result.filePaths[0]);
});

ipcMain.handle('list-backups', () => {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  
  const files = fs.readdirSync(BACKUP_DIR);
  const backups = files
    .filter(f => f.startsWith('full-backup-'))
    .map(f => {
      const fullPath = path.join(BACKUP_DIR, f);
      const stats = fs.statSync(fullPath);
      return {
        name: f,
        path: fullPath,
        timestamp: stats.mtime,
        size: stats.size,
      };
    })
    .sort((a, b) => b.timestamp - a.timestamp);
  
  return backups;
});

// ── Log files ─────────────────────────────────────────────────────────────────
ipcMain.handle('get-log-file-path', (_, scriptId) => {
  const script = getScript(scriptId);
  if (!script) return null;
  
  const safeName = script.name.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(LOGS_DIR, `${safeName}-${scriptId}.log`);
});

ipcMain.handle('read-log-file', (_, { scriptId, maxLines = 1000 }) => {
  const script = getScript(scriptId);
  if (!script) return { ok: false, error: 'Script not found' };
  const safeName = script.name.replace(/[^a-zA-Z0-9_-]/g, '_');
  const logPath = path.join(LOGS_DIR, `${safeName}-${scriptId}.log`);
  if (!fs.existsSync(logPath)) return { ok: true, path: logPath, lines: [] };
  try {
    const raw = fs.readFileSync(logPath, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean).slice(-Math.max(1, Math.min(10000, Number(maxLines) || 1000)));
    return { ok: true, path: logPath, lines };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('clear-log-file', (_, scriptId) => {
  const script = getScript(scriptId);
  if (!script) return { ok: false, error: 'Script not found' };
  const safeName = script.name.replace(/[^a-zA-Z0-9_-]/g, '_');
  const logPath = path.join(LOGS_DIR, `${safeName}-${scriptId}.log`);
  try {
    if (scriptLogFiles[scriptId]) {
      scriptLogFiles[scriptId].end();
      delete scriptLogFiles[scriptId];
    }
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.writeFileSync(logPath, '');
    return { ok: true, path: logPath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── Window controls ───────────────────────────────────────────────────────────
ipcMain.handle('browse-file', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Scripts', extensions: ['js','py','mjs','ts','sh','bat','ps1','exe'] }, { name: 'All', extensions: ['*'] }],
  });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('browse-folder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

// ── Export log ───────────────────────────────────────────────────────────────
ipcMain.handle('export-log', async (_, { scriptName, logText }) => {
  const safe = (scriptName || 'log').replace(/[^a-zA-Z0-9_-]/g, '_');
  const stamp = new Date().toISOString().slice(0,19).replace(/:/g,'-');
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Log',
    defaultPath: `${safe}-${stamp}.txt`,
    filters: [{ name: 'Text', extensions: ['txt'] }, { name: 'All', extensions: ['*'] }],
  });
  if (result.canceled) return { ok: false };
  try {
    fs.writeFileSync(result.filePath, logText, 'utf8');
    return { ok: true, path: result.filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── Config file paths ────────────────────────────────────────────────────────
ipcMain.handle('get-config-paths', () => ({
  dataFile:  DATA_FILE,
  groupsFile: GROUPS_FILE,
  templatesFile: TEMPLATES_FILE,
  profilesFile: PROFILES_FILE,
  collectionsFile: COLLECTIONS_FILE,
  settingsFile: SETTINGS_FILE,
  statsHistoryFile: STATS_HISTORY_FILE,
  backupDir: BACKUP_DIR,
  logsDir: LOGS_DIR,
  dataDir:   DATA_DIR,
}));

// ── Export config ─────────────────────────────────────────────────────────────
ipcMain.handle('export-config', async () => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export ScriptManager Config',
    defaultPath: `scripts-export-${new Date().toISOString().slice(0,10)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled) return { ok: false };
  try {
    fs.writeFileSync(result.filePath, JSON.stringify(scripts, null, 2));
    return { ok: true, path: result.filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── Import config ─────────────────────────────────────────────────────────────
ipcMain.handle('import-config', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import ScriptManager Config',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled) return { ok: false };
  try {
    const raw  = fs.readFileSync(result.filePaths[0], 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return { ok: false, error: 'Invalid config file — expected an array.' };

    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: 'Import Config',
      message: `Import ${data.length} scripts?`,
      detail: 'Choose how to import:',
      buttons: ['Merge with existing', 'Replace all', 'Cancel'],
      defaultId: 0, cancelId: 2,
    });
    if (response === 2) return { ok: false };

    // Reset statuses so imported scripts don't appear running
    const clean = data.map(s => ({ ...s, status: 'stopped', pid: null, startedAt: null }));

    if (response === 0) {
      // Merge — skip any with duplicate IDs
      const existingIds = new Set(scripts.map(s => s.id));
      const newOnes = clean.filter(s => !existingIds.has(s.id));
      scripts.push(...newOnes);
    } else {
      scripts = clean;
    }
    saveScripts();
    updateTrayMenu();
    return { ok: true, count: clean.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── Open file in Explorer ─────────────────────────────────────────────────────
ipcMain.handle('open-in-explorer', (_, filePath) => {
  try {
    const { shell } = require('electron'); // shell must be imported at call-time
    shell.showItemInFolder(filePath);
    return { ok: true };
  } catch (e) {
    return { ok: false };
  }
});

// ── Windows startup (run on boot) ────────────────────────────────────────────
// Electron's getLoginItemSettings is unreliable on Windows — it ignores the
// StartupApproved\Run key that Task Manager uses to block startup items.
// We bypass it entirely and use reg.exe to read/write the registry directly.
const STARTUP_REG_KEY  = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const STARTUP_REG_NAME = 'ScriptManager';

function getStartupEnabledFromRegistry() {
  try {
    const out = execSync(
      `reg query "${STARTUP_REG_KEY}" /v "${STARTUP_REG_NAME}"`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    return out.includes(STARTUP_REG_NAME);
  } catch (_) {
    return false; // key absent → not enabled
  }
}

ipcMain.handle('get-startup-enabled', () => {
  if (!app.isPackaged) return { enabled: false, devMode: true };
  return { enabled: getStartupEnabledFromRegistry(), devMode: false };
});

ipcMain.handle('set-startup-enabled', (_, enable) => {
  if (!app.isPackaged) return { ok: false, error: 'Only works in packaged .exe — not in dev mode.' };
  try {
    const exePath = app.getPath('exe');
    if (enable) {
      execSync(
        `reg add "${STARTUP_REG_KEY}" /v "${STARTUP_REG_NAME}" /t REG_SZ /d "${exePath}" /f`,
        { encoding: 'utf8', stdio: 'ignore' }
      );
    } else {
      try {
        execSync(
          `reg delete "${STARTUP_REG_KEY}" /v "${STARTUP_REG_NAME}" /f`,
          { encoding: 'utf8', stdio: 'ignore' }
        );
      } catch (_) { /* already absent — that's fine */ }
    }
    return { ok: true, enabled: getStartupEnabledFromRegistry() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Window controls
ipcMain.on('win-minimize', () => mainWindow.minimize());
ipcMain.on('win-maximize', () => mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize());
ipcMain.on('win-close',    () => mainWindow.close());
ipcMain.on('win-show',     () => { mainWindow.show(); mainWindow.focus(); });
