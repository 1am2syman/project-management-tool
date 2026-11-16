@echo off
setlocal DisableDelayedExpansion
pushd "%~dp0"
if errorlevel 1 goto folder_error

git --version >nul 2>&1
if errorlevel 1 goto git_error
if not exist ".git" goto repo_error

rem Parse the complete update block before Git can replace this batch file.
(
    echo Updating Plan...
    git pull --ff-only
    if errorlevel 1 (
        echo.
        echo Update failed. Resolve the Git error above, then run update.bat again.
        popd
        pause
        endlocal
        exit /b 1
    )
    echo.
    echo Plan is up to date. Run start.bat to reopen the app.
    popd
    pause
    endlocal
    exit /b 0
)

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
