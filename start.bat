@echo off
echo Starting ScriptManager...
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo ERROR: Node.js is not installed or not in PATH.
    echo Please download it from https://nodejs.org/
    pause
    exit /b 1
)

if not exist node_modules (
    echo Installing dependencies for the first time...
    call npm install
)

npm start
