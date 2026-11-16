@echo off
setlocal
pushd "%~dp0"
if errorlevel 1 goto folder_error

uv run --locked project-management-tool %*
set "PLAN_EXIT=%errorlevel%"
popd
if not "%PLAN_EXIT%"=="0" pause
endlocal & exit /b %PLAN_EXIT%

:folder_error
echo Could not open the Plan folder. Run start.bat from your cloned repository.
pause
exit /b 1
