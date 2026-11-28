@echo off
setlocal DisableDelayedExpansion
pushd "%~dp0"
if errorlevel 1 goto folder_error

if not exist "runtime\windows-x64\python.exe" goto runtime_error
"runtime\windows-x64\python.exe" -B "start.py" --install-shortcut %*
set "PLAN_EXIT=%errorlevel%"
if "%PLAN_EXIT%"=="0" (
    echo.
    echo You can now open Plan from the Start Menu, or right-click Plan in the
    echo Start Menu and choose "Pin to taskbar".
)
popd
pause
endlocal & exit /b %PLAN_EXIT%

:runtime_error
echo The bundled Windows Python runtime is missing. Restore the runtime folder
echo from a complete copy of this repository, then run install-shortcut.bat again.
popd
pause
endlocal & exit /b 1

:folder_error
echo Could not open the Plan folder. Run install-shortcut.bat from your repository folder.
pause
endlocal & exit /b 1
