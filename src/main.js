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

// ── Data file location ───────────────────────────────────────────────────────
// In production (.exe) → same folder as the exe so it's easy to find & back up.
// In dev (npm start)   → project root, so it doesn't pollute AppData.
const DATA_DIR  = app.isPackaged
  ? path.dirname(app.getPath('exe'))
  : path.join(__dirname, '..');
const DATA_FILE   = path.join(DATA_DIR, 'scripts.json');
const BACKUP_DIR  = path.join(DATA_DIR, 'scripts-backups');
const ICON_PATH   = path.join(__dirname, '../assets/icon.ico');
const ICON_PNG    = path.join(__dirname, '../assets/icon.png');
const TRAY_16     = path.join(__dirname, '../assets/tray-16.png');
const TRAY_32     = path.join(__dirname, '../assets/tray-32.png');

// ── Persistence ───────────────────────────────────────────────────────────────
function loadScripts() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      scripts = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch { scripts = []; }
}

function saveScripts() {
  const json = JSON.stringify(scripts, null, 2);
  fs.writeFileSync(DATA_FILE, json);
  autoBackup(json);
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
    },
    icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
  });
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

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  loadScripts();
  // Reset statuses (were running before app closed)
  scripts.forEach(s => { s.status = 'stopped'; s.pid = null; });
  createWindow();
  createTray();
  // Auto-start scripts
  scripts.forEach(s => { if (s.autoStart) startScript(s.id); });
  // Re-schedule cron
  scripts.forEach(s => { if (s.cronEnabled && s.cronSchedule) scheduleCron(s); });
  // CPU/RAM polling every 3s
  statsTimer = setInterval(pollStats, 3000);
});

app.on('before-quit', () => {
  app.isQuitting = true;
  if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
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
      send('stats-update', {
        scriptId,
        cpu: stat.cpu.toFixed(1),
        mem: Math.round(stat.memory / 1024 / 1024),  // MB
        uptime: Date.now() - entry.startedAt,
      });
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
  processes[scriptId] = { process: proc, startedAt };
  script.status    = 'running';
  script.pid       = proc.pid;
  script.startedAt = startedAt;
  if (!script.crashCount) script.crashCount = 0;
  saveScripts();

  send('status-update', { scriptId, status: 'running', pid: proc.pid, startedAt });
  appendLog(scriptId, `▶ Started PID ${proc.pid} — ${new Date().toLocaleString()}\n`);
  updateTrayMenu();

  proc.stdout.on('data', d => appendLog(scriptId, d.toString()));
  proc.stderr.on('data', d => appendLog(scriptId, `[ERR] ${d.toString()}`));

  proc.on('close', code => {
    delete processes[scriptId];
    const crashed = code !== 0 && code !== null;
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

// ── IPC ───────────────────────────────────────────────────────────────────────
ipcMain.handle('get-scripts', () => scripts);

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
  scripts[idx] = { ...scripts[idx], ...data };
  saveScripts();
  if (scripts[idx].cronEnabled && scripts[idx].cronSchedule) scheduleCron(scripts[idx]);
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

ipcMain.handle('browse-file', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Scripts', extensions: ['js','py','mjs','ts','sh','bat','ps1'] }, { name: 'All', extensions: ['*'] }],
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
  backupDir: BACKUP_DIR,
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
// Uses Electron's built-in loginItem API which writes to the Windows registry
// HKCU\Software\Microsoft\Windows\CurrentVersion\Run — no admin required.
ipcMain.handle('get-startup-enabled', () => {
  // Only works in packaged .exe — always returns false in dev
  if (!app.isPackaged) return { enabled: false, devMode: true };
  const settings = app.getLoginItemSettings();
  return { enabled: settings.openAtLogin, devMode: false };
});

ipcMain.handle('set-startup-enabled', (_, enable) => {
  if (!app.isPackaged) return { ok: false, error: 'Only works in packaged .exe — not in dev mode.' };
  try {
    app.setLoginItemSettings({
      openAtLogin: enable,
      // Start minimized to tray so it doesn't flash a window on every boot
      openAsHidden: true,
      // Name shown in Task Manager / Startup apps list
      name: 'ScriptManager',
    });
    // Verify it actually took effect
    const check = app.getLoginItemSettings();
    return { ok: true, enabled: check.openAtLogin };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Window controls
ipcMain.on('win-minimize', () => mainWindow.minimize());
ipcMain.on('win-maximize', () => mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize());
ipcMain.on('win-close',    () => mainWindow.close());
ipcMain.on('win-show',     () => { mainWindow.show(); mainWindow.focus(); });
