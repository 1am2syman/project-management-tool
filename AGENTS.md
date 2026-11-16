# Repo memory

- File-dialog regressions need an isolated database/profile and the actual OS chooser; supplied handles do not prove Windows behavior (see [testing](docs/testing.md)).
- Keep diagnostic capture before the main module graph so module-load failures leave Log available; preserve `runtime/windows-x64` and user databases during cleanup.
