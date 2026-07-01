!macro preInit
  ; Stage legacy data before electron-builder removes an old per-user install.
  ; This matters when switching from "Only for me" to the all-users layout.
  RMDir /r "$TEMP\ScriptManagerMigration"
  CreateDirectory "$TEMP\ScriptManagerMigration"
  CreateDirectory "$TEMP\ScriptManagerMigration\logs"
  CreateDirectory "$TEMP\ScriptManagerMigration\scripts-backups"
  CopyFiles /SILENT "$PROGRAMFILES64\ScriptManager\*.json" "$TEMP\ScriptManagerMigration"
  CopyFiles /SILENT "$%ProgramData%\ScriptManager\*.json" "$TEMP\ScriptManagerMigration"
  CopyFiles /SILENT "$APPDATA\ScriptManager\*.json" "$TEMP\ScriptManagerMigration"
  CopyFiles /SILENT "$LOCALAPPDATA\Programs\ScriptManager\*.json" "$TEMP\ScriptManagerMigration"
  CopyFiles /SILENT "$PROGRAMFILES64\ScriptManager\logs\*.*" "$TEMP\ScriptManagerMigration\logs"
  CopyFiles /SILENT "$%ProgramData%\ScriptManager\logs\*.*" "$TEMP\ScriptManagerMigration\logs"
  CopyFiles /SILENT "$APPDATA\ScriptManager\logs\*.*" "$TEMP\ScriptManagerMigration\logs"
  CopyFiles /SILENT "$LOCALAPPDATA\Programs\ScriptManager\logs\*.*" "$TEMP\ScriptManagerMigration\logs"
  CopyFiles /SILENT "$PROGRAMFILES64\ScriptManager\scripts-backups\*.*" "$TEMP\ScriptManagerMigration\scripts-backups"
  CopyFiles /SILENT "$%ProgramData%\ScriptManager\scripts-backups\*.*" "$TEMP\ScriptManagerMigration\scripts-backups"
  CopyFiles /SILENT "$APPDATA\ScriptManager\scripts-backups\*.*" "$TEMP\ScriptManagerMigration\scripts-backups"
  CopyFiles /SILENT "$LOCALAPPDATA\Programs\ScriptManager\scripts-backups\*.*" "$TEMP\ScriptManagerMigration\scripts-backups"

  ; Ask an installed ScriptManager instance to shut down cleanly first. This
  ; lets its before-quit handler stop managed child processes and save state.
  IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 forceClose
    Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --quit-for-update'
    Sleep 2500

  forceClose:
  ; A boot/background instance may run in another Windows session and cannot
  ; receive Electron's single-instance event. Stop any remaining copy so the
  ; installer can replace the executable instead of showing an endless Retry.
  nsExec::ExecToLog 'taskkill.exe /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
  Sleep 750
!macroend

!macro customInstall
  ; Installed builds keep mutable state in the install root. Grant normal users
  ; Modify access so the tray app can update JSON, logs, and backups there.
  CreateDirectory "$INSTDIR"
  nsExec::ExecToLog 'icacls.exe "$INSTDIR" /grant *S-1-5-32-545:(OI)(CI)M /T /C'

  ; Preserve the most important configuration from old install/data layouts.
  IfFileExists "$INSTDIR\scripts.json" stagedMigrationDone 0
  CopyFiles /SILENT "$TEMP\ScriptManagerMigration\*.json" "$INSTDIR"
  stagedMigrationDone:

  IfFileExists "$INSTDIR\logs\*.*" stagedLogsDone 0
  CreateDirectory "$INSTDIR\logs"
  CopyFiles /SILENT "$TEMP\ScriptManagerMigration\logs\*.*" "$INSTDIR\logs"
  stagedLogsDone:

  IfFileExists "$INSTDIR\scripts-backups\*.*" stagedBackupsDone 0
  CreateDirectory "$INSTDIR\scripts-backups"
  CopyFiles /SILENT "$TEMP\ScriptManagerMigration\scripts-backups\*.*" "$INSTDIR\scripts-backups"
  stagedBackupsDone:
  RMDir /r "$TEMP\ScriptManagerMigration"

  IfFileExists "$INSTDIR\scripts.json" scriptsDone 0
  IfFileExists "$APPDATA\ScriptManager\scripts.json" 0 scriptsFromUser
  CopyFiles /SILENT "$APPDATA\ScriptManager\scripts.json" "$INSTDIR"
  Goto scriptsDone
  scriptsFromUser:
  IfFileExists "$LOCALAPPDATA\Programs\ScriptManager\scripts.json" 0 scriptsDone
  CopyFiles /SILENT "$LOCALAPPDATA\Programs\ScriptManager\scripts.json" "$INSTDIR"
  scriptsDone:

  IfFileExists "$INSTDIR\settings.json" settingsDone 0
  IfFileExists "$APPDATA\ScriptManager\settings.json" 0 settingsFromUser
  CopyFiles /SILENT "$APPDATA\ScriptManager\settings.json" "$INSTDIR"
  Goto settingsDone
  settingsFromUser:
  IfFileExists "$LOCALAPPDATA\Programs\ScriptManager\settings.json" 0 settingsDone
  CopyFiles /SILENT "$LOCALAPPDATA\Programs\ScriptManager\settings.json" "$INSTDIR"
  settingsDone:

  IfFileExists "$INSTDIR\groups.json" groupsDone 0
  IfFileExists "$APPDATA\ScriptManager\groups.json" 0 groupsFromUser
  CopyFiles /SILENT "$APPDATA\ScriptManager\groups.json" "$INSTDIR"
  Goto groupsDone
  groupsFromUser:
  IfFileExists "$LOCALAPPDATA\Programs\ScriptManager\groups.json" 0 groupsDone
  CopyFiles /SILENT "$LOCALAPPDATA\Programs\ScriptManager\groups.json" "$INSTDIR"
  groupsDone:

  IfFileExists "$INSTDIR\templates.json" templatesDone 0
  IfFileExists "$APPDATA\ScriptManager\templates.json" 0 templatesFromUser
  CopyFiles /SILENT "$APPDATA\ScriptManager\templates.json" "$INSTDIR"
  Goto templatesDone
  templatesFromUser:
  IfFileExists "$LOCALAPPDATA\Programs\ScriptManager\templates.json" 0 templatesDone
  CopyFiles /SILENT "$LOCALAPPDATA\Programs\ScriptManager\templates.json" "$INSTDIR"
  templatesDone:

  IfFileExists "$INSTDIR\profiles.json" profilesDone 0
  IfFileExists "$APPDATA\ScriptManager\profiles.json" 0 profilesFromUser
  CopyFiles /SILENT "$APPDATA\ScriptManager\profiles.json" "$INSTDIR"
  Goto profilesDone
  profilesFromUser:
  IfFileExists "$LOCALAPPDATA\Programs\ScriptManager\profiles.json" 0 profilesDone
  CopyFiles /SILENT "$LOCALAPPDATA\Programs\ScriptManager\profiles.json" "$INSTDIR"
  profilesDone:

  IfFileExists "$INSTDIR\collections.json" collectionsDone 0
  IfFileExists "$APPDATA\ScriptManager\collections.json" 0 collectionsFromUser
  CopyFiles /SILENT "$APPDATA\ScriptManager\collections.json" "$INSTDIR"
  Goto collectionsDone
  collectionsFromUser:
  IfFileExists "$LOCALAPPDATA\Programs\ScriptManager\collections.json" 0 collectionsDone
  CopyFiles /SILENT "$LOCALAPPDATA\Programs\ScriptManager\collections.json" "$INSTDIR"
  collectionsDone:

  IfFileExists "$INSTDIR\stats-history.json" statsDone 0
  IfFileExists "$APPDATA\ScriptManager\stats-history.json" 0 statsFromUser
  CopyFiles /SILENT "$APPDATA\ScriptManager\stats-history.json" "$INSTDIR"
  Goto statsDone
  statsFromUser:
  IfFileExists "$LOCALAPPDATA\Programs\ScriptManager\stats-history.json" 0 statsDone
  CopyFiles /SILENT "$LOCALAPPDATA\Programs\ScriptManager\stats-history.json" "$INSTDIR"
  statsDone:
!macroend
