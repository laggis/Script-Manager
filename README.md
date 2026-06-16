# ScriptManager v1.5

Desktop manager for Node.js, Python, Batch and PowerShell scripts on Windows.
Minimises to system tray — scripts keep running in the background.

---

## What's New in v1.5

- ✅ **Script Collections** — Bundle related scripts and start/stop them all with one click (sequential or parallel)
- ✅ **Drag-to-Reorder Collections** — Drag collection cards into any order, persisted across restarts
- ✅ **Analytics / Stats History** — CPU & RAM charts with 1h / 6h / 24h / 7d time range selector
- ✅ **Profiles / Environments** — Save and switch between dev/prod configs per script
- ✅ **Script Triggers** — Auto-restart on file change (file watcher) or port drop (port monitor)
- ✅ **Notification Channels** — SMTP email, Discord webhook, Slack webhook, custom webhook alerts on crash/health fail
- ✅ **Script Marketplace** — Import scripts from a URL or GitHub; export your own configs as shareable JSON
- ✅ **Webhook Server** — Optional inbound webhook to trigger scripts remotely
- ✅ **Fixed: Navigation** — Sidebar buttons (Scripts, Analytics, Collections, etc.) now work correctly
- ✅ **Fixed: Cache errors** — Eliminated the `cache_util` / `gpu_disk_cache` Access Denied errors on startup

## Previous Features (v1.4)

- ✅ **Script Dependencies** — Define startup order; scripts wait for their dependencies
- ✅ **Enhanced Logging** — Automatic file-based logs with rotation in `logs/` folder
- ✅ **Output Parsing** — Watch for regex patterns, auto-restart/stop/notify on match
- ✅ **Script Templates** — Pre-configured templates for Discord bots, Express, Flask
- ✅ **Web UI / API** — Optional REST API for remote monitoring (disabled by default)

## Previous Features (v1.3)

- ✅ **Script Groups/Categories** — Organize scripts into custom groups with colors
- ✅ **Resource Limits & Alerts** — Set CPU/RAM thresholds, auto-restart or stop on limit breach
- ✅ **Health Checks** — Periodic process or HTTP endpoint checks with auto-recovery
- ✅ System tray icon with quick start/stop menu
- ✅ CPU & RAM usage per script (live, every 3s)
- ✅ Uptime display per script
- ✅ Crash counter with colour coding
- ✅ Git Pull & Restart button
- ✅ Interactive Console — send stdin input to running scripts
- ✅ Windows Toast notifications on crash/restart
- ✅ Auto-backup — up to 10 rolling backups of your config (max once/min)
- ✅ Export & Import config (JSON)
- ✅ Export log to .txt
- ✅ Run on Windows Startup toggle (packaged .exe only)
- ✅ Open script/folder directly in Explorer

---

## Running in Dev Mode

Requires [Node.js v18+](https://nodejs.org/)

```
npm install
npm start
```

Or double-click `start.bat`.

> **Note:** Some features are only available in the packaged `.exe`:
> - **Run on Windows Startup** — requires a registry entry that `electron-builder` sets up.
>   The toggle is intentionally greyed out in dev mode.

---

## Building the .exe

### Requirements
- Node.js v18 or newer — https://nodejs.org/
- Git (optional, only needed for the Git Pull feature)

### Steps
```
npm install
npm run build
```

Output goes to the `dist/` folder:
- `ScriptManager Setup 1.5.0.exe` — full installer with Start Menu & desktop shortcut
- `ScriptManager-Portable-1.5.0.exe` — single `.exe`, no install needed

### Portable vs Installer
| | Portable | Installer |
|---|---|---|
| Installation | Just copy & run | Runs setup wizard |
| Shortcuts | None | Desktop + Start Menu |
| Data location | Next to the `.exe` | Next to the `.exe` |
| Uninstall | Delete the file | Windows Add/Remove Programs |

### Adding an App Icon
Place `icon.ico` (256×256) and `icon.png` in the `assets/` folder before building.
Free PNG→ICO converter: https://convertio.co

---

## Data Storage

All data is stored **next to the `.exe`** (or in the project root during dev), making it easy to back up and move between machines.

| File / Folder | Contents |
|---|---|
| `scripts.json` | All your script configs |
| `groups.json` | Script group definitions |
| `templates.json` | Script templates |
| `profiles.json` | Per-script environment profiles |
| `collections.json` | Script collections and their order |
| `scripts-backups/` | Up to 10 rolling auto-backups |

> Scripts are **not** stored in `%APPDATA%`. This is intentional — keeping everything in one folder makes the app fully portable.

---

## Features

| Feature | Details |
|---|---|
| **Script types** | Discord Bot, Python, Node.js, npm start/dev, Batch, PowerShell, Shell, Bun, Deno, Executable |
| **Script groups** | Organize scripts into custom categories with colors |
| **Script collections** | Bundle scripts and launch or stop them all at once; drag to reorder |
| **Profiles** | Save dev/prod/staging environment configs per script and switch instantly |
| **Resource limits** | Set CPU & RAM thresholds with auto-restart/stop on breach |
| **Health checks** | HTTP endpoint or process checks with configurable intervals |
| **File watcher trigger** | Auto-restart a script when its source files change |
| **Port monitor trigger** | Auto-restart if a monitored port goes down |
| **Analytics** | CPU & RAM history charts per script — 1h, 6h, 24h or 7d view |
| **Notifications** | SMTP email, Discord, Slack, and custom webhook alerts on crash or health fail |
| **Runtime selector** | python3.12, node18, bun, deno run, custom, etc. |
| **Auto-restart** | Never / On Failure / Always |
| **Auto-start** | Start scripts automatically when ScriptManager opens |
| **Cron schedule** | Standard 5-part cron expressions (uses `node-cron`) |
| **Environment vars** | Per-script `KEY=VALUE` editor |
| **CPU & RAM** | Live stats updated every 3 seconds (uses `pidusage`) |
| **Uptime** | Live uptime counter per script |
| **Crash counter** | Counts + highlights repeated crashes; reset button included |
| **Git integration** | Set repo dir, branch, pull on start, or Pull & Restart in one click |
| **Console** | Send stdin input to running processes |
| **Marketplace** | Import scripts from a URL or GitHub; export your own as shareable JSON |
| **Web UI / API** | Optional REST API for remote monitoring (port configurable) |
| **System tray** | Minimize to tray; scripts keep running; tray menu for quick start/stop |
| **Windows Startup** | Launch ScriptManager silently on boot (packaged `.exe` only) |
| **Auto-backup** | Rolling backups of `scripts.json` — up to 10 kept, max one per minute |
| **Export / Import** | Export or import your full config as JSON |
| **Log export** | Save a script's log output as a `.txt` file |
| **Open in Explorer** | Jump straight to a script file or folder from the UI |
| **Frameless window** | Custom titlebar with minimize / maximize / close controls |

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+N` | Register a new script |
| `Ctrl+F` or `/` | Focus the script search box |
| `Ctrl+L` | Go to Logs |
| `Ctrl+D` | Go to Dashboard |
| `Escape` | Close modal / dialog |

---

## Tips

- **Double-click the tray icon** to show the window
- **Close button** — if scripts are running, you'll be asked whether to keep them running in the tray or stop all and quit
- **Crash badge** turns yellow at 3+ crashes, red at 5+. Click "Reset" to clear it
- **Collections** can be dragged into any order — grab the ⠿⠿ handle on the left of each card
- The **Windows Startup toggle** is greyed out in dev mode (`npm start`) — build the `.exe` first
- **Notification channels** (email, Discord, Slack) are configured in Settings and can be tested with a single click

---

## Requirements at Runtime

- Windows 10 or 11 (x64)
- No Node.js required when running the packaged `.exe`
- Git only needed if you use the Git Pull feature

---

## License

MIT
