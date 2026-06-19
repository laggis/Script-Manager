const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Scripts CRUD
  getScripts:      ()          => ipcRenderer.invoke('get-scripts'),
  getAppVersion:   ()          => ipcRenderer.invoke('get-app-version'),
  addScript:       (data)      => ipcRenderer.invoke('add-script', data),
  removeScript:    (id)        => ipcRenderer.invoke('remove-script', id),
  updateScript:    (data)      => ipcRenderer.invoke('update-script', data),

  // Groups CRUD
  getGroups:       ()          => ipcRenderer.invoke('get-groups'),
  addGroup:        (data)      => ipcRenderer.invoke('add-group', data),
  updateGroup:     (data)      => ipcRenderer.invoke('update-group', data),
  removeGroup:     (id)        => ipcRenderer.invoke('remove-group', id),

  // Templates
  getTemplates:    ()          => ipcRenderer.invoke('get-templates'),
  createFromTemplate: (data)   => ipcRenderer.invoke('create-from-template', data),

  // Backup & Restore
  backupScripts:   ()          => ipcRenderer.invoke('backup-scripts'),
  restoreScripts:  ()          => ipcRenderer.invoke('restore-scripts'),
  listBackups:     ()          => ipcRenderer.invoke('list-backups'),

  // Dependencies / setup wizard / update / web UI
  installDependencies: (id)    => ipcRenderer.invoke('install-dependencies', id),
  checkDependencyTools:(id)    => ipcRenderer.invoke('check-dependency-tools', id),
  inspectProjectFolder:(path)  => ipcRenderer.invoke('inspect-project-folder', path),
  checkForUpdates:    (url)    => ipcRenderer.invoke('check-for-updates', url),
  getWebUiSettings:   ()       => ipcRenderer.invoke('get-webui-settings'),
  saveWebUiSettings:  (cfg)    => ipcRenderer.invoke('save-webui-settings', cfg),
  generateWebUiToken: ()       => ipcRenderer.invoke('generate-webui-token'),
  getUpdateSettings:  ()       => ipcRenderer.invoke('get-update-settings'),
  saveUpdateSettings: (cfg)    => ipcRenderer.invoke('save-update-settings', cfg),

  // Log files
  getLogFilePath:  (id)        => ipcRenderer.invoke('get-log-file-path', id),
  readLogFile:     (id, maxLines = 1000) => ipcRenderer.invoke('read-log-file', { scriptId: id, maxLines }),
  clearLogFile:    (id)        => ipcRenderer.invoke('clear-log-file', id),

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
  onHealthUpdate:  (cb) => ipcRenderer.on('health-update',(_, d) => cb(d)),
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

  // Stats History / Analytics
  getStatsHistory: (scriptId, timeRange) => ipcRenderer.invoke('get-stats-history', { scriptId, timeRange }),

  // Triggers
  testPort:             (port)      => ipcRenderer.invoke('test-port', port),
  generateWebhookToken: ()          => ipcRenderer.invoke('generate-webhook-token'),
  getWebhookPort:       ()          => ipcRenderer.invoke('get-webhook-port'),
  getTriggerStatus:     (scriptId)  => ipcRenderer.invoke('get-trigger-status', scriptId),

  // Profiles / Environments
  getProfiles:   (scriptId)                        => ipcRenderer.invoke('get-profiles', scriptId),
  saveProfile:   (scriptId, profileName, config)   => ipcRenderer.invoke('save-profile', { scriptId, profileName, config }),
  applyProfile:  (scriptId, profileName)           => ipcRenderer.invoke('apply-profile', { scriptId, profileName }),
  deleteProfile: (scriptId, profileName)           => ipcRenderer.invoke('delete-profile', { scriptId, profileName }),

  // Marketplace / Sharing
  importFromUrl:    (url)      => ipcRenderer.invoke('import-from-url', url),
  exportScriptJson: (id)       => ipcRenderer.invoke('export-script-json', id),

  // Collections
  getCollections:    ()        => ipcRenderer.invoke('get-collections'),
  addCollection:     (data)    => ipcRenderer.invoke('add-collection', data),
  updateCollection:  (data)    => ipcRenderer.invoke('update-collection', data),
  deleteCollection:  (id)      => ipcRenderer.invoke('delete-collection', id),
  startCollection:   (id)      => ipcRenderer.invoke('start-collection', id),
  stopCollection:    (id)      => ipcRenderer.invoke('stop-collection', id),
  reorderCollections:(ids)     => ipcRenderer.invoke('reorder-collections', ids),

  // Notification Channels
  getSmtpSettings:          ()       => ipcRenderer.invoke('get-smtp-settings'),
  saveSmtpSettings:         (cfg)    => ipcRenderer.invoke('save-smtp-settings', cfg),
  testEmail:                ()       => ipcRenderer.invoke('test-email'),
  getDiscordSettings:       ()       => ipcRenderer.invoke('get-discord-settings'),
  saveDiscordSettings:      (cfg)    => ipcRenderer.invoke('save-discord-settings', cfg),
  testDiscord:              ()       => ipcRenderer.invoke('test-discord'),
  getSlackSettings:         ()       => ipcRenderer.invoke('get-slack-settings'),
  saveSlackSettings:        (cfg)    => ipcRenderer.invoke('save-slack-settings', cfg),
  testSlack:                ()       => ipcRenderer.invoke('test-slack'),
  getCustomWebhookSettings: ()       => ipcRenderer.invoke('get-custom-webhook-settings'),
  saveCustomWebhookSettings:(cfg)    => ipcRenderer.invoke('save-custom-webhook-settings', cfg),
  testCustomWebhook:        ()       => ipcRenderer.invoke('test-custom-webhook'),

  // Window controls
  minimize: () => ipcRenderer.send('win-minimize'),
  maximize: () => ipcRenderer.send('win-maximize'),
  close:    () => ipcRenderer.send('win-close'),
});
