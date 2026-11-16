@echo off
setlocal DisableDelayedExpansion
pushd "%~dp0"
if errorlevel 1 goto folder_error

if not exist "runtime\windows-x64\python.exe" goto runtime_error
"runtime\windows-x64\python.exe" -B "start.py" %*
set "PLAN_EXIT=%errorlevel%"
popd
if not "%PLAN_EXIT%"=="0" pause
endlocal & exit /b %PLAN_EXIT%

:runtime_error
echo The bundled Windows Python runtime is missing. Restore the runtime folder
echo from a complete copy of this repository, then run start.bat again.
popd
pause
endlocal & exit /b 1

:folder_error
echo Could not open the Plan folder. Run start.bat from your repository folder.
pause
endlocal & exit /b 1
