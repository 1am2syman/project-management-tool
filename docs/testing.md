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

Delay accounting unit tests (`delays.test.mjs`) reproduce the mockup's Office fit-out numbers (Permit +10; Handover Dec 20 → 23 → 27; completion Jan 5 → 8 → 12) and check that own + inherited + pending + revision equals every task's total, that each impact-grid column sums exactly to its milestone total (including absorbed delay and Other / unexplained), that agreed dates change only through the listed actions, shading only on the originating task, overdue detection with calendars and holidays, inclusions and omissions, cause rename/retire/import, undo and redo of every action (including classifying an earlier delay of a task with two), the unclassified-delay list for the baseline notice, owner revisions counted once, the Current agreed subtotal, key milestones in format 6, and format 6 round trips with older files opening without agreed data. The timing test only guards against quadratic work (limit 3 s) because test files run in parallel.

Contour unit tests (`contour.test.mjs`) cover the backdrop's pure maths: deterministic noise in range and continuous, the entrance easing and radius, increasing contour levels, terrain drift, the pointer hill and expiring waves, the page corner's fade (full strength to 1% of the page width, a straight fall to nothing at 60%, nothing beyond, the matching radial mask and the entrance that starts at the corner), and marching-squares tracing (nothing outside the levels, one interpolated line across a ramp, every fourth level heavier, saddle cells, bounds, and a bounded line count at dialog size). The animated drawing itself is checked by `browser-contour.mjs`.

Slack unit tests enumerate working-day starts with an independent daily oracle for every dependency type, positive/zero/negative lag, task/milestone combinations, multiple successors, tied limits and holidays. They also cover negative slack, terminal tasks, summary exclusions, milestone scope, free slack exceeding total slack, undo/calendar changes and portable-file recomputation.

The Python suite covers SQLite persistence, saved history, conflict handling and launcher behavior. Runtime tests validate the bundled Windows files against the recorded checksums and upstream SPDX metadata, check x64 executable headers, and verify the standard-library ZIP and isolation configuration. A Windows-only test executes the bundled interpreter and app help; the source launcher integration test uses the bundled interpreter on Windows and isolated system Python on other systems, covering paths with spaces, argument forwarding, SQLite saves and running-instance reuse. JavaScript tests cover task hierarchy and subtree movement, relationship validation, working calendars, all four dependency types, critical-path calculations, scheduling modes, project-file validation, native Save behavior and undo/redo. Targeted critical-path tests compare float against an independent exhaustive schedule oracle for mixed endpoint types, signed lags, milestones and holidays. They also verify independent/shared branches, unchanged dates/history, per-project persistence, export views and invalid/deleted/converted target fallback.

`task-calendars.test.mjs` exercises independent overrides, reset and undo, the agreed Friday-to-Tuesday lag example, all four relationship types with signed lag and mixed calendars against a day-by-day scheduling/slack oracle, task/milestone combinations, date edits and group drags, storage/templates/copies/versions, format 5 including overrides found only in saved versions, Excel metadata inference, and version-difference/finish-replay attribution.

`longest-path.test.mjs` verifies Oracle-style Longest Path versus total-float threshold highlighting, real positive float across weekend/holiday gaps, tied branches, milestone scope, manual/anchor barriers, completed/summary handling, per-project persistence, versions, portable files and exports. Driving links are checked against an independent daily oracle for all relationship types, signed lags and mixed calendars. `browser-critical-path.mjs` exercises the method dialog, threshold validation, red bars/connectors with positive slack, unchanged project data, refresh and fresh-profile database restoration, narrow-screen layout and PDF/Excel output.

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
node tests/browser-task-calendars.mjs
node tests/browser-critical-path.mjs
node tests/browser-critical-path-edges.mjs
node tests/browser-fit.mjs
node tests/browser-diagnostics.mjs
node tests/browser-slack.mjs
node tests/browser-local-only.mjs
node tests/browser-versions.mjs
node tests/browser-delays.mjs
node tests/browser-contour.mjs
```

All suites start their own server on an available local port, use a temporary SQLite database and isolated browser profiles, and block requests to external services. They do not open or edit your saved projects. Each suite closes its browser and server and removes temporary files on normal completion or a caught test failure.

| Suite | Coverage |
|---|---|
| `browser-local-files.mjs` | Isolated local API, injected delayed chooser, no browser picker or IndexedDB dependency, lost start/attach/commit responses, refresh while a chooser is pending, connection reuse across browser profiles and server restart, and the Show file window/Cancel notice for a chooser that stays open. The injected chooser does not test Windows dialogs. |
| `browser-versions.mjs` | Snapshot dialog and unchanged-plan notice, version list and keyboard closing, read-only preview (blocked typing, undo and toolbar actions; live plan unchanged on the server), Back to current, restore with “save current first”, undo/redo of a restore, rename and delete, version analysis sections, baseline/compared selection and swap, finish waterfall (unchanged/delayed/earlier comparison, single-source attribution, connected added/removed scope with labelled items imported through a real `.plan` document, table/chart selection, keyboard arrows and Home/End, multi-step details, smaller-width fit and screenshots at 100%, 150% and 200% display scaling), change-log filters and search, *Only changed rows*, keyboard isolation from the plan, PDF/Excel downloads, Compare to current, exporting the version on screen, Copy as new project, `.plan` Save/Open with versions while a version is shown, reload returning to the current plan, the empty analysis state, and banner/card fit at 1366px with screenshots at 1366 and 1920px. |
| `browser-delays.mjs` | Delay accounting: agreed-deadline dialog (one-click expected date and the picker), Agreed baseline atomicity, columns beside Days fully visible at 1920 and 1366 after a revision, the record popover (Record, Revision, Skip reason, Cancel undoing only its own edit), its placement at both sizes, keyboard use (Tab and Shift+Tab wrap inside it, focus returns to the grid on Record/Skip/Cancel/Escape, Enter in a text field records, Explain stepper keeps focus) and AA label contrast, converting between task and milestone (a recovery or a recorded delay), Auto-schedule turned back on attributing the catch-up to upstream delays, late start, Overdue chip, pending/agreed inclusion and omission, classifying delays later (task menu, Cause cell by double-click, F2 and Enter, Delay log row, an entry picker for a task with two delays, each one Ctrl+Z step, no edit in a read-only preview or saved version), the Agreed-baseline notice for unclassified delays (listed, classified in place without losing the dialog's fields, never blocking, absent otherwise), Settings → Delay causes persisting across refresh and a fresh profile, version types and the read-only preview, and the Analysis page: default Agreed-baseline comparison, every delay section, impact-grid columns adding up, Show all and key-milestone stars saved with the project, the Current agreed subtotal and neutral agreed-change colours, PDF and Excel downloads containing the three delay tables, and re-importing the sheet export without extra rows. |
| `browser-contour.mjs` | Motion Brew look: Geist and Geist Mono load from the bundled files; every dialog (Settings, Project calendar, Import) and menu or popover (Export, Templates, Columns, Versions, sheet menu, task menu) gets exactly one canvas directly behind it that matches its size, ignores the pointer, leaves items clickable, shows light drifting lines, reacts to the pointer and is removed on close; the full-page Analysis view and the Log dialog stay plain; ink pill buttons, grey form rows and ink focus; the grid and Gantt share the look (Geist type, white headers, ink-grey pill bars with ink progress, ink current day) with unchanged row, bar and column sizes, critical-path red and a blue selection, show no teal, purple or blue accents beyond the active cell's outline (sheet tab, selected-column header and focus-mode rails are ink or grey), and never get a canvas inside them, however the pointer moves over them; the main page has exactly one quiet corner canvas of the same lines at the bottom-left of the work area (60% of the page wide, behind the content, pointer-transparent, fading from 1% to 60% with nothing visible beyond, identical pixels over the task rows with and without it, drifting while idle and stirred by pointer movement far from the corner, resting while a dialog is open, following a resize, still under reduced motion, absent when the script is blocked); reduced motion draws one still frame that neither moves nor reacts; and with `contour.js` blocked the dialog stays solid white and usable. |
| `browser-local-only.mjs` | No Microsoft controls or integration/external requests, workbook owner suggestions and manual entry, inert legacy settings, editable copies of older read-only snapshots, and SQLite restoration in a fresh profile. |
| `browser-critical-path.mjs` | Longest Path and float-threshold dialog, mixed-calendar red bars/connectors with positive slack, unchanged project data, reload and fresh-profile restoration, narrow dialog, and PDF/Excel method and critical flags. |
| `browser-critical-path-edges.mjs` | 49 independent fixtures covering all dependency types, signed lags, mixed calendars, milestone endpoints, weekend/holiday buffers, tied and independent paths, manual/anchor gaps, violations, completed work, summary progress, empty plans and escaped long labels. Checks actual bar/diamond colors and connector classes, scope/threshold changes, invalid thresholds, toggle, dialog cancellation/focus, target conversion/deletion, duration edits, undo/redo, collapse and reload. Measures row/bar alignment, Fit and dialog bounds in 14 Compact/Adaptive configurations at 760/1000/1440px, 125/150% CSS zoom and 100/150/200% device scaling; retains 43 screenshots and an `audit.json` report when artifacts are enabled. |
| `browser-slack.mjs` | Total/free slack cells and keyboard inspection, latest dates and limiting successors, milestone scope and summaries, Off/Selected/All overlays, Fit bounds, passive slack tails during move/resize/cancel/undo, unchanged project data, SQLite preference restoration across profiles, Excel values and re-import, PDF columns/options/download, read-only inspection, narrow dialog layout, and row/tail alignment, working-calendar tail end plus screenshots at 100%, 150% and 200% device scaling in both densities. |
| `browser-diagnostics.mjs` | Bottom-bar Log clicks, JSON downloads, browser/runtime metadata, cookie/storage checks, errors and request metadata, secret/project-content exclusion, retention through refresh, keyboard isolation, narrow footer, and startup failure/recovery for a blocked main module, missing dependency, invalid MIME type, syntax error and missing export. Failure checks verify the error banner, both Log entry points, import rejection details, resource status, unchanged saved workbook and successful Reload after repair. |
| `browser-task-calendars.mjs` | Task and Gantt context menus, summary exclusion, shared overlay draft/validation/preview/apply/cancel, receiver-calendar scheduling, purple markers, Global/Task calendars tabs with override-only rows, holiday details, Edit and reset preview, undo/redo, global independence, real XLSX bytes and `.plan` round-trips, keyboard tabs, reload and fresh-profile SQLite restoration, read-only calendar inspection, and laptop layouts at 1366×768 and 1440×900. Layout checks measure unobstructed actions and visible preview feedback for global, new/existing task, long-preview, reset and returned-draft states, with long names and nine holidays. Holiday lists and previews have separate scroll limits; every changed row is listed and the final row is reachable. Returning from reset preserves unsaved weekdays/holidays and leaves saved data unchanged. |
| `browser-structure.mjs` | Nested cascades, pointer reordering/nesting, invalid drops, cancellation and autoscroll, insertion/conversion menus, keyboard shortcuts, calendar draft/apply/cancel, Excel calendar round-trips, narrow menus, read-only restrictions and restoration from SQLite in a fresh browser profile. |
| `browser-fit.mjs` | Measured Fit label bounds, start-to-start elbows and connection handles beside earliest milestones in both densities, 6px sheet/Gantt scrollbars, single-row responsive toolbar and accessible icon actions, Compact/Adaptive density selection and Auto-schedule staying on the first row in a 789px timeline pane, full switch labels at 125–200% zoom and narrow pane splits, sheet/Gantt alignment, adaptive density on resize/collapse, scheduling actions and sheet-only badges, undo/redo, saving an active edit, connected file reuse after refresh and Save As; milestone critical-path selection/clearing in the chooser and context menus, scoped bars/float with unchanged dates, selected-target toolbar layout, SQLite restoration across refresh and a fresh browser profile, target labels and calculated critical/float values in PDF/Excel exports, and Excel re-import without extra task rows. |

### Browser and Python selection

Set `PLAYWRIGHT_CHROMIUM` to an installed Chromium executable to test with that browser instead of Playwright's bundled build. Set `PYTHON` to a Python executable if `python3` is unavailable, as is common on Windows. Set `PLAN_TEST_HEADED=1` for the diagnostics suite to show the browser; remote Windows runs must launch it in the logged-in console session rather than SSH session 0.

For example, in PowerShell:

```powershell
$env:PYTHON = "python"
$env:PLAYWRIGHT_CHROMIUM = "C:\Program Files\Google\Chrome\Application\chrome.exe"
node tests/browser-structure.mjs
node tests/browser-task-calendars.mjs
node tests/browser-fit.mjs
node tests/browser-diagnostics.mjs
node tests/browser-slack.mjs
node tests/browser-versions.mjs
```

### Visual rendering checks

When changing Gantt positioning or styling, also review the chart at 100%, 150% and 200% display scaling in both Compact and Adaptive density. Include task bars with internal and external labels, parent summaries, milestones, critical paths and rounded dependency connectors. Check Fit and timeline zoom, then move and resize a bar and cancel a drag with Escape. Labels should remain centered, bar edges should stay defined, and connectors should meet their bars.

Display scaling changes the browser's device pixel ratio; this is separate from the CSS zoom exercised by `browser-fit.mjs`. The suite checks layout and interactions, but does not automatically judge visual sharpness.

### Optional screenshots

By default, screenshots are written inside the suite's temporary directory and removed during cleanup. To keep screenshots for review, set `PLAN_TEST_ARTIFACTS` to a directory outside the checkout. The task-calendars, critical-path, structure, fit, slack and versions suites create separate `task-calendars/`, `critical-path/`, `critical-path-edges/`, `structure/`, `fit/`, `slack/` and `versions/` subdirectories there, including a failure screenshot when possible. The diagnostics suite writes `diagnostics-report.json` and a narrow `startup-failure.png` directly into the chosen directory.

For example, in PowerShell:

```powershell
$env:PLAN_TEST_ARTIFACTS = Join-Path $env:TEMP "plan-browser-results"
node tests/browser-structure.mjs
node tests/browser-task-calendars.mjs
node tests/browser-fit.mjs
node tests/browser-diagnostics.mjs
node tests/browser-slack.mjs
node tests/browser-versions.mjs
```

In a POSIX shell:

```sh
PLAN_TEST_ARTIFACTS=/tmp/plan-browser-results node tests/browser-structure.mjs
node tests/browser-task-calendars.mjs
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

Startup and diagnostics checks also ran with the bundled Python and installed Edge 157 on Windows in the logged-in console session, with isolated app data, databases and browser profiles. A mixed installation was reconstructed from the old entry point plus deleted Microsoft/reminder modules; its source fingerprint exactly matched the reported failing copy. It reproduced the empty grid and **Loading saved projects…** message with 404s for the removed imports. Complete current source reached **Saved to this computer** and restored the saved workbook after refresh. The maintained diagnostics suite separately verified the error banner, Log downloads and Reload recovery for each injected import failure on Windows. These startup checks do not exercise OS file choosers.

The Python-managed path was exercised on Windows 10 with the bundled interpreter, installed Chrome and Edge, real Windows choosers, isolated databases, local app-data registries and browser profiles. Checks covered Unicode Open with reminders disabled, Open/Save As cancellation, connected Save, new-file Save As, overwrite decline/accept, external edits, server restart, switching browsers, repeated dialogs and their ownership/foreground state, shutdown with a chooser open, read-only and locked files, and temporary OneDrive destinations. Firefox was not installed and was not tested; network-share destinations remain unverified.

Windows regression checks also cover rewritten-file metadata differences, occupied-port handling on a second launch, and bounded chooser shutdown. The isolated real-chooser shutdown probe closed both an active dialog and an idle worker; the unit suite checks dispatch outside the lock, same-thread close and bounded timeout fallback. The maintained browser suites still use injected chooser results and do not by themselves establish Windows dialog behavior.

Chooser visibility depends on Windows' foreground lock. On an idle machine (no input for longer than the lock timeout) any process may take focus, so a chooser that would appear behind the browser in real use looks correct in automation. Arm the lock before starting the chooser: send input from a separate process, such as a zero-distance `SendInput` mouse move, or click the browser with real input. Then compare the dialog's z-order with the window that was in the foreground. Under an armed lock on Windows 10, the previous release opened the chooser behind that window and unfocused. The current build placed it above that window in every run; Windows still refused keyboard focus. The run used the real server API, raised the chooser, refused raise requests from another client and closed it as cancelled.

Automated native picker results are supplied by the tests. The file-handle suite uses real browser-private file handles to exercise writes and persistence across refresh; it does not operate the OS Open/Save As dialogs. Permission, external-edit conflicts, cancellation and uncertain save outcomes also have unit coverage. A separate manual check on Linux used an isolated database/profile and the real native chooser to open the reported `.plan` file, then clicked Log → Download log and verified all Open/IndexedDB stages in the actual download. This does not verify the Windows chooser.

Version previews and the version analysis overlay were reviewed in Chromium on Linux at 1366×768 and 1920×1000. The analysis layout also has normal and long-name captures at 1024px and 800px. The overlay leads with finish movement and four supporting metrics; **All metrics**, **Why this step?**, **All contributions** and **Calculation notes** reveal the remaining information on demand. The change log groups fields under each item, the milestone legend can emphasize a series, and **Full names** expands wrapped Gantt labels. Browser checks cover section highlighting on clicks and manual scrolling, disclosure access, table-to-inspector selection, visible focus on unselected steps, both waterfall endpoints fitting in dense comparisons, and the compact header. These checks use isolated databases and profiles.

The finish waterfall was also reviewed at 100%, 150% and 200% display scaling, including a connected addition/removal example. The exported analysis PDF's waterfall chart and contribution table were rendered and reviewed; the Excel waterfall chart and contribution sheets were rendered through LibreOffice. The workbook has not been opened in Microsoft Excel.

Delay accounting visuals were reviewed in Chromium on Linux at 1366×768 and 1920×1000 (sheet columns, popover, dialogs, Analysis sections) and the Gantt shading at 100%, 150% and 200% display scaling in both densities; Windows display scaling, other browsers and the delay PDF/Excel exports in Excel itself were not reviewed (the files were checked structurally and re-imported). The version suite now waits for the saved plan to render before opening Analysis in fresh scaled profiles, fixing the earlier startup race. Both `browser-versions.mjs` and `browser-fit.mjs` pass with installed Chromium 151 on Linux. Playwright's bundled Chromium still crashes during the Fit suite's connected Save after refresh in this environment; the same crash was reproduced on the unchanged base commit. Use `PLAYWRIGHT_CHROMIUM` to select the installed browser for that check.

The Motion Brew restyle (Geist type, ink pill buttons, grey form rows, the grid and Gantt look, and the contour backdrop on dialogs and menus) was reviewed in Chromium on Linux at 1366×768 and 1920×1000 for Settings, Project calendar, Import, the delay popover and deadline dialog, the Export, Templates, Columns, Versions, sheet and task menus, and the main grid and Gantt page, including the page corner. The corner is drawn at 30 frames a second and only when nothing covers the page. The dialog scrim deliberately has no backdrop blur: with the canvas repainting every frame the blur cost about 80 ms a frame in software rendering and made the version tests race the grid render. Windows, other browsers and display scaling were not reviewed, and the animation's frame rate was not measured on slower machines.

Slack tails were reviewed visually in Chromium on Linux at 100%, 150% and 200% device scaling in both densities; other browsers and Windows display scaling have not been reviewed.

Longest Path checks ran with installed Chromium 151 on Linux using isolated databases and browser profiles. All 49 edge fixtures and 14 layout configurations passed, and all 43 screenshots were reviewed. The critical-path, task-calendar, slack, Fit and version browser suites also passed. This verifies the browser display and file contents in that environment; it does not establish Windows rendering, native chooser behavior or other browsers.

`update.bat` was executed in Windows `cmd.exe` on Windows 10 with Git 2.49, a local bare repository as the published remote and no Git identity configured. Checks covered: repairing a copy at an older commit with removed modules missing, a stray JavaScript file, generated `__pycache__` files, a stale `index.lock` and a locally modified updater (all set aside in one stash; tracked tree and `src` clean afterwards); an update that replaces the running `update.bat` with a longer file; an up-to-date run; refusal while the bundled `python.exe` runs from the folder; a file locked during the update, reported as unfinished and completed by a rerun after release; an unreachable remote; and a detached checkout without an upstream. The refusal cases left HEAD and files unchanged. Network-share folders and real GitHub downloads were not part of that run.

Launcher and persistence tests have run on Linux, including source startup with isolated imports and bundle integrity checks. The test that executes the Windows interpreter is skipped on Linux. `start.bat` has been reviewed but not executed in Windows `cmd.exe` by the automated suites; before distributing a runtime update, also launch `start.bat` on Windows with networking disabled and confirm browser startup and SQLite saves. The PowerShell examples above document setup rather than a completed Windows test run.
