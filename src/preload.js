const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Scripts CRUD
  getScripts:      ()          => ipcRenderer.invoke('get-scripts'),
  addScript:       (data)      => ipcRenderer.invoke('add-script', data),
  removeScript:    (id)        => ipcRenderer.invoke('remove-script', id),
  updateScript:    (data)      => ipcRenderer.invoke('update-script', data),

  // Process control
  startScript:     (id)        => ipcRenderer.invoke('start-script', id),
  stopScript:      (id)        => ipcRenderer.invoke('stop-script', id),
  restartScript:   (id)        => ipcRenderer.invoke('restart-script', id),

  // Interactive console
  sendStdin:       (id, text)  => ipcRenderer.invoke('send-stdin', id, text),

  // Git
  gitPull:         (id)        => ipcRenderer.invoke('git-pull', id),
  gitPullRestart:  (id)        => ipcRenderer.invoke('git-pull-restart', id),

  // Stats
  resetCrashCount: (id)        => ipcRenderer.invoke('reset-crash-count', id),

  // File browsing
  browseFile:      ()          => ipcRenderer.invoke('browse-file'),
  browseFolder:    ()          => ipcRenderer.invoke('browse-folder'),

  // Events from main → renderer
  onLog:           (cb) => ipcRenderer.on('log',          (_, d) => cb(d)),
  onStatusUpdate:  (cb) => ipcRenderer.on('status-update',(_, d) => cb(d)),
  onStatsUpdate:   (cb) => ipcRenderer.on('stats-update', (_, d) => cb(d)),
  removeAllListeners: (ch) => ipcRenderer.removeAllListeners(ch),

  // Log export
  exportLog: (scriptName, logText) => ipcRenderer.invoke('export-log', { scriptName, logText }),

  // Windows startup
  getStartupEnabled: ()       => ipcRenderer.invoke('get-startup-enabled'),
  setStartupEnabled: (enable) => ipcRenderer.invoke('set-startup-enabled', enable),

  // Config management
  getConfigPaths:  ()     => ipcRenderer.invoke('get-config-paths'),
  exportConfig:    ()     => ipcRenderer.invoke('export-config'),
  importConfig:    ()     => ipcRenderer.invoke('import-config'),
  openInExplorer:  (p)    => ipcRenderer.invoke('open-in-explorer', p),

  // Window controls
  minimize: () => ipcRenderer.send('win-minimize'),
  maximize: () => ipcRenderer.send('win-maximize'),
  close:    () => ipcRenderer.send('win-close'),
});
