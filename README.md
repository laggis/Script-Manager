# ScriptManager v1.2

Desktop manager for Node.js, Python, Batch and PowerShell scripts on Windows.
Minimises to system tray — scripts keep running in the background.

---

## What's New in v1.2
- ✅ System tray icon — minimize to tray, scripts keep running
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
> - **Run on Windows Startup** — requires the registry entry that `electron-builder` sets up.
>   The toggle is intentionally disabled in dev mode.

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
- `ScriptManager Setup 1.2.0.exe` — full installer with Start Menu & desktop shortcut
- `ScriptManager-Portable-1.2.0.exe` — single `.exe`, no install needed

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
| `scripts-backups/` | Up to 10 rolling auto-backups |

> Scripts are **not** stored in `%APPDATA%`. This is intentional — keeping everything in one folder makes the app fully portable.

---

## Features

| Feature | Details |
|---|---|
| **Script types** | Discord Bot, Python, Node.js, npm start/dev, Batch, PowerShell, Shell, Bun, Deno |
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
| **System tray** | Minimize to tray; scripts keep running; tray menu for quick start/stop |
| **Notifications** | Windows toast on crash or restart |
| **Auto-backup** | Rolling backups of `scripts.json` — up to 10 kept, max one per minute |
| **Export / Import** | Export or import your full config as JSON |
| **Log export** | Save a script's log output as a `.txt` file |
| **Windows Startup** | Launch ScriptManager silently on boot (packaged `.exe` only) |
| **Open in Explorer** | Jump straight to a script file or folder from the UI |
| **Frameless window** | Custom titlebar with minimize / maximize / close controls |

---

## Keyboard & UI Tips

- **Double-click the tray icon** to show the window
- **Close button** — if scripts are running, you'll be asked whether to keep them running in the tray or stop all and quit
- **Crash badge** turns yellow at 3+ crashes, red at 5+. Click "Reset" to clear it.
- The **Windows Startup toggle** is greyed out in dev mode (`npm start`) — build the `.exe` first.

---

## Requirements at Runtime

- Windows 10 or 11 (x64)
- No Node.js required when running the packaged `.exe`
- Git only needed if you use the Git Pull feature

---

## License

MIT
