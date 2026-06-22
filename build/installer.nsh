!macro preInit
  ; Stage legacy data before electron-builder removes an old per-user install.
  ; This matters when switching from "Only for me" to the all-users layout.
  RMDir /r "$TEMP\ScriptManagerMigration"
  CreateDirectory "$TEMP\ScriptManagerMigration"
  CopyFiles /SILENT "$PROGRAMFILES64\ScriptManager\*.json" "$TEMP\ScriptManagerMigration"
  CopyFiles /SILENT "$LOCALAPPDATA\Programs\ScriptManager\*.json" "$TEMP\ScriptManagerMigration"

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
  ; Installed builds share mutable state here. Grant normal users Modify access
  ; so the tray app and the SYSTEM boot instance use the same configuration.
  CreateDirectory "$APPDATA\ScriptManager"
  nsExec::ExecToLog 'icacls.exe "$APPDATA\ScriptManager" /grant *S-1-5-32-545:(OI)(CI)M /T /C'

  ; Preserve the most important configuration from either old install layout.
  IfFileExists "$APPDATA\ScriptManager\scripts.json" stagedMigrationDone 0
  CopyFiles /SILENT "$TEMP\ScriptManagerMigration\*.json" "$APPDATA\ScriptManager"
  stagedMigrationDone:
  RMDir /r "$TEMP\ScriptManagerMigration"

  IfFileExists "$APPDATA\ScriptManager\scripts.json" scriptsDone 0
  IfFileExists "$INSTDIR\scripts.json" 0 scriptsFromUser
  CopyFiles /SILENT "$INSTDIR\scripts.json" "$APPDATA\ScriptManager"
  Goto scriptsDone
  scriptsFromUser:
  IfFileExists "$LOCALAPPDATA\Programs\ScriptManager\scripts.json" 0 scriptsDone
  CopyFiles /SILENT "$LOCALAPPDATA\Programs\ScriptManager\scripts.json" "$APPDATA\ScriptManager"
  scriptsDone:

  IfFileExists "$APPDATA\ScriptManager\settings.json" settingsDone 0
  IfFileExists "$INSTDIR\settings.json" 0 settingsFromUser
  CopyFiles /SILENT "$INSTDIR\settings.json" "$APPDATA\ScriptManager"
  Goto settingsDone
  settingsFromUser:
  IfFileExists "$LOCALAPPDATA\Programs\ScriptManager\settings.json" 0 settingsDone
  CopyFiles /SILENT "$LOCALAPPDATA\Programs\ScriptManager\settings.json" "$APPDATA\ScriptManager"
  settingsDone:

  IfFileExists "$APPDATA\ScriptManager\groups.json" groupsDone 0
  IfFileExists "$LOCALAPPDATA\Programs\ScriptManager\groups.json" 0 groupsDone
  CopyFiles /SILENT "$LOCALAPPDATA\Programs\ScriptManager\groups.json" "$APPDATA\ScriptManager"
  groupsDone:

  IfFileExists "$APPDATA\ScriptManager\templates.json" templatesDone 0
  IfFileExists "$LOCALAPPDATA\Programs\ScriptManager\templates.json" 0 templatesDone
  CopyFiles /SILENT "$LOCALAPPDATA\Programs\ScriptManager\templates.json" "$APPDATA\ScriptManager"
  templatesDone:

  IfFileExists "$APPDATA\ScriptManager\profiles.json" profilesDone 0
  IfFileExists "$LOCALAPPDATA\Programs\ScriptManager\profiles.json" 0 profilesDone
  CopyFiles /SILENT "$LOCALAPPDATA\Programs\ScriptManager\profiles.json" "$APPDATA\ScriptManager"
  profilesDone:

  IfFileExists "$APPDATA\ScriptManager\collections.json" collectionsDone 0
  IfFileExists "$LOCALAPPDATA\Programs\ScriptManager\collections.json" 0 collectionsDone
  CopyFiles /SILENT "$LOCALAPPDATA\Programs\ScriptManager\collections.json" "$APPDATA\ScriptManager"
  collectionsDone:

  IfFileExists "$APPDATA\ScriptManager\stats-history.json" statsDone 0
  IfFileExists "$LOCALAPPDATA\Programs\ScriptManager\stats-history.json" 0 statsDone
  CopyFiles /SILENT "$LOCALAPPDATA\Programs\ScriptManager\stats-history.json" "$APPDATA\ScriptManager"
  statsDone:
!macroend
