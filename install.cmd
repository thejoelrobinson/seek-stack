@echo off
REM ---------------------------------------------------------------------------
REM  seek-stack installer - double-click this file.
REM
REM  This exists so you never have to think about which folder your terminal is
REM  in. %~dp0 is the folder THIS file lives in, so the installer is found no
REM  matter where you launch it from, and no matter what the folder is called.
REM ---------------------------------------------------------------------------

setlocal
cd /d "%~dp0"

if not exist "%~dp0install.ps1" (
  echo.
  echo   ERROR: install.ps1 is not next to this file.
  echo.
  echo   That usually means the ZIP was only partly extracted. Extract the whole
  echo   thing, then double-click install.cmd from inside the extracted folder.
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" (
  echo   The installer stopped before finishing. Scroll up to see why.
  echo   You can fix the problem and run this again - it picks up where it left off.
  echo   Stuck? See docs\TROUBLESHOOTING.md
) else (
  echo   Finished. You can close this window.
)
echo.
pause
exit /b %RC%
