# Development and testing

Plan uses Python 3.10+ and browser ES modules without a front-end build step. On Windows, `start.bat` uses the bundled Python runtime with no downloads or package installation. With an existing Python installation, run `python start.py`; `uv run --locked project-management-tool` is also available for development but can download Python and build dependencies during setup. Node.js is needed only for JavaScript regression tests; Playwright is optional for browser tests.

## Regression tests

Run these commands from the repository root:

```sh
python -B -m unittest discover -s tests -p "test_*.py" -v
node --test tests/*.test.mjs
```

Use `python3` if that is your Python command. These commands use an existing development Python installation; with an already configured uv environment, `uv run --locked python -B -m unittest discover -s tests -p "test_*.py" -v` is equivalent.

The bundled Windows interpreter uses `._pth` isolation, so test discovery must explicitly add the repository root. From the repository root, run:

```powershell
runtime\windows-x64\python.exe -B -c "import sys,unittest; from pathlib import Path; sys.path.insert(0,str(Path.cwd())); suite=unittest.defaultTestLoader.discover('tests',pattern='test_*.py'); result=unittest.TextTestRunner(verbosity=2).run(suite); sys.exit(not result.wasSuccessful())"
```

Subprocess regression tests likewise add the repository root explicitly, so they exercise the bundled interpreter without changing its runtime isolation configuration.

The diagnostics unit tests cover bounded recording, reload retention, redaction, pending-operation warnings, console/JavaScript/resource failures, fetch metadata, and precise Open stages including stalled reads and AbortError. The Python suite also checks the diagnostics endpoint without reading or initializing project storage and verifies that source changes alter its fingerprint.

Version unit tests cover snapshots of the live plan, the read-only preview (edits, undo and saves never reach the live plan), saved dates under Auto-schedule, one-step undoable restore without reused IDs, rename/delete numbering, stale-window and read-only refusals, persistence, copies/duplicates/shared snapshots without versions, and format 4 `.plan` round-trips and validation. Comparison tests check working-day deltas across weekends and holidays, task/relationship/calendar changes by stable ID, ranked slips with causes, milestone status, critical-path and slack changes, owner totals, change-log filters, trends with missing milestones, the baseline Gantt, and that the PDF and Excel exports contain every analysis section. Waterfall tests check explicit schedule replay, no downstream double counting, named insertions/removals with connected dependency changes, parallel revisions and controlling-path switches, completed drivers, independence from milestone scope, zero-effect and offsetting changes, calendars, paused/manual/anchored dates, unexplained saved-date differences and baseline alignment, empty/cyclic graphs, input immutability, all four dependency types with signed lag, structural conversions, and sixty deterministic generated schedules. Chart tests check selection markup, empty-state geometry and escaping; exports check the PDF contribution chart/table and the Excel contribution and chart sheets, including pagination with carried-forward dates.

Slack unit tests enumerate working-day starts with an independent daily oracle for every dependency type, positive/zero/negative lag, task/milestone combinations, multiple successors, tied limits and holidays. They also cover negative slack, terminal tasks, summary exclusions, milestone scope, free slack exceeding total slack, undo/calendar changes and portable-file recomputation.

The Python suite covers SQLite persistence, saved history, conflict handling and launcher behavior. Runtime tests validate the bundled Windows files against the recorded checksums and upstream SPDX metadata, check x64 executable headers, and verify the standard-library ZIP and isolation configuration. A Windows-only test executes the bundled interpreter and app help; the source launcher integration test uses the bundled interpreter on Windows and isolated system Python on other systems, covering paths with spaces, argument forwarding, SQLite saves and running-instance reuse. JavaScript tests cover task hierarchy and subtree movement, relationship validation, working calendars, all four dependency types, critical-path calculations, scheduling modes, project-file validation, native Save behavior and undo/redo. Targeted critical-path tests compare float against an independent exhaustive schedule oracle for mixed endpoint types, signed lags, milestones and holidays. They also verify independent/shared branches, unchanged dates/history, per-project persistence, export views and invalid/deleted/converted target fallback.

## Optional browser tests

Install Playwright for development, then install its Chromium browser:

```sh
npm install --no-save --package-lock=false playwright
npx playwright install chromium
```

Playwright is not required to run Plan. If Playwright is installed outside this checkout, set `PLAYWRIGHT_MODULE` to the absolute path of its `index.mjs` module instead of installing it here.

Run the interaction suites:

```sh
node tests/browser-local-files.mjs
node tests/browser-structure.mjs
node tests/browser-fit.mjs
node tests/browser-diagnostics.mjs
node tests/browser-slack.mjs
node tests/browser-local-only.mjs
node tests/browser-versions.mjs
```

All suites start their own server on an available local port, use a temporary SQLite database and isolated browser profiles, and block requests to external services. They do not open or edit your saved projects. Each suite closes its browser and server and removes temporary files on normal completion or a caught test failure.

| Suite | Coverage |
|---|---|
| `browser-local-files.mjs` | Isolated local API, injected delayed chooser, no browser picker or IndexedDB dependency, lost start/attach/commit responses, refresh while a chooser is pending, connection reuse across browser profiles and server restart, and the Show file window/Cancel notice for a chooser that stays open. The injected chooser does not test Windows dialogs. |
| `browser-versions.mjs` | Snapshot dialog and unchanged-plan notice, version list and keyboard closing, read-only preview (blocked typing, undo and toolbar actions; live plan unchanged on the server), Back to current, restore with “save current first”, undo/redo of a restore, rename and delete, version analysis sections, baseline/compared selection and swap, finish waterfall (unchanged/delayed/earlier comparison, single-source attribution, connected added/removed scope with labelled items imported through a real `.plan` document, table/chart selection, keyboard arrows and Home/End, multi-step details, smaller-width fit and screenshots at 100%, 150% and 200% display scaling), change-log filters and search, *Only changed rows*, keyboard isolation from the plan, PDF/Excel downloads, Compare to current, exporting the version on screen, Copy as new project, `.plan` Save/Open with versions while a version is shown, reload returning to the current plan, the empty analysis state, and banner/card fit at 1366px with screenshots at 1366 and 1920px. |
| `browser-local-only.mjs` | No Microsoft controls or integration/external requests, workbook owner suggestions and manual entry, inert legacy settings, editable copies of older read-only snapshots, and SQLite restoration in a fresh profile. |
| `browser-slack.mjs` | Total/free slack cells and keyboard inspection, latest dates and limiting successors, milestone scope and summaries, Off/Selected/All overlays, Fit bounds, passive slack tails during move/resize/cancel/undo, unchanged project data, SQLite preference restoration across profiles, Excel values and re-import, PDF columns/options/download, read-only inspection, narrow dialog layout, and row/tail alignment, working-calendar tail end plus screenshots at 100%, 150% and 200% device scaling in both densities. |
| `browser-diagnostics.mjs` | Bottom-bar Log clicks, JSON downloads, browser/runtime metadata, cookie/storage checks, errors and request metadata, secret/project-content exclusion, retention through refresh, keyboard isolation, narrow footer and Log availability when the main module cannot load. |
| `browser-structure.mjs` | Nested cascades, pointer reordering/nesting, invalid drops, cancellation and autoscroll, insertion/conversion menus, keyboard shortcuts, calendar draft/apply/cancel, Excel calendar round-trips, narrow menus, read-only restrictions and restoration from SQLite in a fresh browser profile. |
| `browser-fit.mjs` | Measured Fit label bounds, start-to-start elbows and connection handles beside earliest milestones in both densities, 6px sheet/Gantt scrollbars, single-row responsive toolbar and accessible icon actions, Compact/Adaptive density selection and Auto-schedule staying on the first row in a 789px timeline pane, full switch labels at 125–200% zoom and narrow pane splits, sheet/Gantt alignment, adaptive density on resize/collapse, scheduling actions and sheet-only badges, undo/redo, saving an active edit, connected file reuse after refresh and Save As; milestone critical-path selection/clearing in the chooser and context menus, scoped bars/float with unchanged dates, selected-target toolbar layout, SQLite restoration across refresh and a fresh browser profile, target labels and calculated critical/float values in PDF/Excel exports, and Excel re-import without extra task rows. |

### Browser and Python selection

Set `PLAYWRIGHT_CHROMIUM` to an installed Chromium executable to test with that browser instead of Playwright's bundled build. Set `PYTHON` to a Python executable if `python3` is unavailable, as is common on Windows.

For example, in PowerShell:

```powershell
$env:PYTHON = "python"
$env:PLAYWRIGHT_CHROMIUM = "C:\Program Files\Google\Chrome\Application\chrome.exe"
node tests/browser-structure.mjs
node tests/browser-fit.mjs
node tests/browser-diagnostics.mjs
node tests/browser-slack.mjs
node tests/browser-versions.mjs
```

### Visual rendering checks

When changing Gantt positioning or styling, also review the chart at 100%, 150% and 200% display scaling in both Compact and Adaptive density. Include task bars with internal and external labels, parent summaries, milestones, critical paths and rounded dependency connectors. Check Fit and timeline zoom, then move and resize a bar and cancel a drag with Escape. Labels should remain centered, bar edges should stay defined, and connectors should meet their bars.

Display scaling changes the browser's device pixel ratio; this is separate from the CSS zoom exercised by `browser-fit.mjs`. The suite checks layout and interactions, but does not automatically judge visual sharpness.

### Optional screenshots

By default, screenshots are written inside the suite's temporary directory and removed during cleanup. To keep screenshots for review, set `PLAN_TEST_ARTIFACTS` to a directory outside the checkout. The structure, fit, slack and versions suites create separate `structure/`, `fit/`, `slack/` and `versions/` subdirectories there, including a failure screenshot when possible. The diagnostics suite writes `diagnostics-report.json` directly into the chosen directory.

For example, in PowerShell:

```powershell
$env:PLAN_TEST_ARTIFACTS = Join-Path $env:TEMP "plan-browser-results"
node tests/browser-structure.mjs
node tests/browser-fit.mjs
node tests/browser-diagnostics.mjs
node tests/browser-slack.mjs
node tests/browser-versions.mjs
```

In a POSIX shell:

```sh
PLAN_TEST_ARTIFACTS=/tmp/plan-browser-results node tests/browser-structure.mjs
PLAN_TEST_ARTIFACTS=/tmp/plan-browser-results node tests/browser-fit.mjs
PLAN_TEST_ARTIFACTS=/tmp/plan-browser-results node tests/browser-diagnostics.mjs
PLAN_TEST_ARTIFACTS=/tmp/plan-browser-results node tests/browser-slack.mjs
PLAN_TEST_ARTIFACTS=/tmp/plan-browser-results node tests/browser-versions.mjs
```

These optional outputs can be deleted after review. Generated screenshots, logs, databases and local agent/check ledgers do not belong in commits. Keep one-off comparison scripts and source snapshots outside the checkout and remove them with their screenshots after validation. The existing regression suites are maintained development tools and stay in the repository.

For a clean folder copy to another user, use GitHub's repository ZIP or `git archive --format=zip --output=../plan.zip HEAD` from the committed checkout. Both include the bundled Windows runtime and maintained tests while excluding ignored local caches, virtual environments, agent notes and validation output. When cleaning a working checkout, stop any processes using its virtual environment before removing `.venv`; remove generated `__pycache__`, `.ruff_cache`, `.pytest_cache` and completed local validation output as needed. Keep the entire `runtime/windows-x64` directory, its license, manifest and SPDX metadata together.

## Isolated file-access tests

Automated suites never open the native chooser or read the real `%LOCALAPPDATA%` registry. Python test servers either pass `native_files=False` to `create_server` and then inject a test service with `use_file_service(...)` (see `tests/file_api_browser_server.py` and `tests/test_file_api.py`), or start `start.py` with `--file-access off`, which the browser suites use. The `off` mode keeps the browser fallback, so picker-mocking suites exercise the same frontend path. The default `--file-access native` is production behavior.

For a manual Windows check, use a throwaway app-data folder and data folder so your real `Documents\Plan` and `%LOCALAPPDATA%\Plan` stay untouched. In PowerShell:

```powershell
$work = Join-Path $env:TEMP "plan-win-check"
$env:LOCALAPPDATA = Join-Path $work "localappdata"
New-Item -ItemType Directory -Force $env:LOCALAPPDATA | Out-Null
runtime\windows-x64\python.exe -B start.py --port 5174 --no-open --data-dir (Join-Path $work "data")
```

Open `http://127.0.0.1:5174/` in Chrome, Edge and Firefox, each with a fresh profile, for example `chrome.exe --user-data-dir="$work\chrome-profile" http://127.0.0.1:5174/`. Use only sample `.plan` files stored under `$work`. Afterward, confirm that the registry is under `$work\localappdata\Plan\file-access` and that nothing changed under your real `%LOCALAPPDATA%\Plan`, then stop the server and delete `$work`.
## Local-only scope checks

Microsoft 365, native mail workers and cloud sharing are removed. There are no tenant, login, mail-delivery or scheduled-task release gates. Local compatibility tests retain old reminder/sharing metadata without executing it.

`node tests/browser-local-only.mjs` uses a temporary database and fresh Chromium profile. It checks that sign-in/reminder/cloud-sharing controls are absent, local owner suggestions work, older read-only snapshots can be copied, legacy metadata remains inert, and no integration or external requests occur. Removed native/feasibility routes and command-line options are covered by Python regressions.

## Verification limits

The Python-managed path was exercised on Windows 10 with the bundled interpreter, installed Chrome and Edge, real Windows choosers, isolated databases, local app-data registries and browser profiles. Checks covered Unicode Open with reminders disabled, Open/Save As cancellation, connected Save, new-file Save As, overwrite decline/accept, external edits, server restart, switching browsers, repeated dialogs and their ownership/foreground state, shutdown with a chooser open, read-only and locked files, and temporary OneDrive destinations. Firefox was not installed and was not tested; network-share destinations remain unverified.

Windows regression checks also cover rewritten-file metadata differences, occupied-port handling on a second launch, and bounded chooser shutdown. The isolated real-chooser shutdown probe closed both an active dialog and an idle worker; the unit suite checks dispatch outside the lock, same-thread close and bounded timeout fallback. The maintained browser suites still use injected chooser results and do not by themselves establish Windows dialog behavior.

Chooser visibility depends on Windows' foreground lock. On an idle machine (no input for longer than the lock timeout) any process may take focus, so a chooser that would appear behind the browser in real use looks correct in automation. Arm the lock before starting the chooser: send input from a separate process, such as a zero-distance `SendInput` mouse move, or click the browser with real input. Then compare the dialog's z-order with the window that was in the foreground. Under an armed lock on Windows 10, the previous release opened the chooser behind that window and unfocused. The current build placed it above that window in every run; Windows still refused keyboard focus. The run used the real server API, raised the chooser, refused raise requests from another client and closed it as cancelled.

Automated native picker results are supplied by the tests. The file-handle suite uses real browser-private file handles to exercise writes and persistence across refresh; it does not operate the OS Open/Save As dialogs. Permission, external-edit conflicts, cancellation and uncertain save outcomes also have unit coverage. A separate manual check on Linux used an isolated database/profile and the real native chooser to open the reported `.plan` file, then clicked Log → Download log and verified all Open/IndexedDB stages in the actual download. This does not verify the Windows chooser.

Version previews and the version analysis overlay were reviewed in Chromium on Linux at 1366×768 and 1920×1000. The analysis layout also has normal and long-name captures at 1024px and 800px. The overlay leads with finish movement and four supporting metrics; **All metrics**, **Why this step?**, **All contributions** and **Calculation notes** reveal the remaining information on demand. The change log groups fields under each item, the milestone legend can emphasize a series, and **Full names** expands wrapped Gantt labels. Browser checks cover section highlighting on clicks and manual scrolling, disclosure access, table-to-inspector selection, visible focus on unselected steps, both waterfall endpoints fitting in dense comparisons, and the compact header. These checks use isolated databases and profiles.

The finish waterfall was also reviewed at 100%, 150% and 200% display scaling, including a connected addition/removal example. The exported analysis PDF's waterfall chart and contribution table were rendered and reviewed; the Excel waterfall chart and contribution sheets were rendered through LibreOffice. The workbook has not been opened in Microsoft Excel.

Slack tails were reviewed visually in Chromium on Linux at 100%, 150% and 200% device scaling in both densities; other browsers and Windows display scaling have not been reviewed.

Launcher and persistence tests have run on Linux, including source startup with isolated imports and bundle integrity checks. The test that executes the Windows interpreter is skipped on Linux. Windows batch launcher/updater scripts have been reviewed, but have not been executed in Windows cmd.exe; before distributing a runtime update, also launch `start.bat` on Windows with networking disabled and confirm browser startup and SQLite saves. The PowerShell examples above document setup rather than a completed Windows test run.
