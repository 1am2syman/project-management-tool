@echo off
setlocal DisableDelayedExpansion
pushd "%~dp0"
if errorlevel 1 goto folder_error

git --version >nul 2>&1
if errorlevel 1 goto git_error
if not exist ".git" goto repo_error

rem Plan must be closed: Windows locks the running runtime, and a running
rem server would keep using the old code after the update.
set "PLAN_DIR=%CD%"
powershell -NoProfile -NonInteractive -Command "$p = ($env:PLAN_DIR.TrimEnd('\') + '\runtime\').ToLower(); if (Get-Process python, pythonw -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.ToLower().StartsWith($p) }) { exit 2 }; exit 0" >nul 2>&1
if "%errorlevel%"=="2" goto running_error

rem A Git command that was interrupted can leave this lock behind.
if not exist ".git\index.lock" goto no_lock
tasklist /fi "imagename eq git.exe" 2>nul | find /i "git.exe" >nul
if not errorlevel 1 goto git_busy
del /f /q ".git\index.lock" >nul 2>&1
:no_lock

git rev-parse --verify --quiet "@{u}" >nul 2>&1
if errorlevel 1 goto upstream_error

echo Checking for updates...
git fetch --prune
if errorlevel 1 goto fetch_error

set "PLAN_LOCAL="
for /f "delims=" %%i in ('git status --porcelain') do set "PLAN_LOCAL=1"
if not defined PLAN_LOCAL goto update_ready

echo.
echo Some app files in this folder have been changed or added on this computer.
echo To install the latest version, Plan needs to replace the changed app files.
echo Your saved projects in Documents\Plan will not be changed.
echo.
echo   1. Back up the changed app files, then update Plan (recommended).
echo      The backup stays in this folder's update history. The updated app
echo      uses the published files; your changes are not reapplied automatically.
echo   2. Cancel and keep the app folder as it is.
echo.
choice /c 12 /n /m "Choose 1 or 2: "
if errorlevel 2 goto update_cancelled
if not errorlevel 1 goto choice_error

:update_ready
rem Parse the complete update block before Git can replace this batch file.
rem Labels and goto must not be used below this point.
(
    echo Updating Plan...
    if defined PLAN_LOCAL (
        rem NUL input disables Git for Windows file-deletion retry prompts.
        git -c "user.name=Plan updater" -c "user.email=plan-updater@localhost" stash push --include-untracked --quiet -m "Set aside by update.bat" <nul
        if errorlevel 1 (
            echo.
            echo Update stopped while backing up local app files. A backup may already be in Git stash.
            echo Close programs using files in the Plan folder, then run update.bat again.
            popd
            pause
            endlocal
            exit /b 1
        )
        echo Backup saved in this folder's update history ^(Git stash^).
        echo If you need those app changes back, ask the person who maintains Plan.
        echo Your saved projects in Documents\Plan were not changed.
    )
    git reset --hard --quiet "@{u}" <nul
    if errorlevel 1 (
        echo.
        echo Update did not finish. Close programs using files in the Plan folder, then run update.bat again.
        popd
        pause
        endlocal
        exit /b 1
    )
    rem Python validates these caches against source; locked caches can stay.
    rem Still remove other stray source files left by interrupted updates.
    git clean -fdxq -e "__pycache__/" -- src <nul
    if errorlevel 1 (
        echo.
        echo Update did not finish. Close programs using files in the Plan folder, then run update.bat again.
        popd
        pause
        endlocal
        exit /b 1
    )
    set "PLAN_DIRTY="
    for /f "delims=" %%i in ('git status --porcelain') do set "PLAN_DIRTY=1"
    if defined PLAN_DIRTY (
        echo.
        echo The Plan folder still differs from the published version:
        git status --short
        echo Close programs using these files, then run update.bat again.
        popd
        pause
        endlocal
        exit /b 1
    )
    echo.
    git --no-pager log -1 "--format=Plan is up to date: %%h %%s"
    echo Open Plan from the Start Menu or run start.bat.
    popd
    pause
    endlocal
    exit /b 0
)

:update_cancelled
echo.
echo Update cancelled. Your app files and saved projects were not changed.
popd
pause
endlocal & exit /b 0

:choice_error
echo.
echo Could not read your choice. The update was cancelled without changing app files.
goto checkout_error

:running_error
echo Plan is still running from this folder. Close Plan (and any Plan launcher
echo window), then run update.bat again. Nothing was changed.
goto checkout_error

:git_busy
echo Another Git command is using this folder. Wait for it to finish, then
echo run update.bat again. Nothing was changed.
goto checkout_error

:upstream_error
echo This copy is not following a published branch. Clone the repository
echo again, then run update.bat. Nothing was changed.
goto checkout_error

:fetch_error
echo.
echo Could not download updates. Check the internet connection, then run
echo update.bat again. Nothing was changed.
goto checkout_error

:git_error
echo Git was not found. Install Git for Windows, then run update.bat again.
goto checkout_error

:repo_error
echo This folder is not a Git checkout. Use the cloned repository, not a ZIP download.

:checkout_error
popd
pause
endlocal & exit /b 1

:folder_error
echo Could not open the Plan folder. Run update.bat from your cloned repository.
pause
endlocal & exit /b 1
