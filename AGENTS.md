# Repo memory

- File-dialog regressions need an isolated database/profile and the actual OS chooser; supplied handles do not prove Windows behavior (see [testing](docs/testing.md)).
- Remote Windows checks: SSH runs in session 0, where no chooser is visible. Launch the server and browsers in the logged-in console session (for example an interactive scheduled task) and drive dialogs with UI Automation. Keep test sample files out of `AppData`/`%TEMP%` for browser-picker paths: Chrome and Edge refuse those folders and report AbortError.
- Keep diagnostic capture before the main module graph so module-load failures leave Log available; preserve `runtime/windows-x64` and user databases during cleanup.
