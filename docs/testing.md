# Development and testing

Plan uses Python 3.10+ and browser ES modules without a front-end build step. On Windows, `start.bat` uses the bundled Python runtime with no downloads or package installation. With an existing Python installation, run `python start.py`; `uv run --locked project-management-tool` is also available for development but can download Python and build dependencies during setup. Node.js is needed only for JavaScript regression tests; Playwright is optional for browser tests.

## Regression tests

Run these commands from the repository root:

```sh
python -B -m unittest discover -s tests -p "test_*.py" -v
node --test tests/diagnostics.test.mjs tests/persistence.test.mjs tests/relationships.test.mjs tests/projectfiles.test.mjs tests/structure.test.mjs tests/calendar.test.mjs tests/scheduling.test.mjs tests/critical-target.test.mjs tests/slack.test.mjs
```

Use `python3` if that is your Python command. These commands use an existing development Python installation; with an already configured uv environment, `uv run --locked python -B -m unittest discover -s tests -p "test_*.py" -v` is equivalent.

The diagnostics unit tests cover bounded recording, reload retention, redaction, pending-operation warnings, console/JavaScript/resource failures, fetch metadata, and precise Open stages including stalled reads and AbortError. The Python suite also checks the diagnostics endpoint without reading or initializing project storage and verifies that source changes alter its fingerprint.

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
node tests/browser-structure.mjs
node tests/browser-fit.mjs
node tests/browser-diagnostics.mjs
node tests/browser-slack.mjs
```

All suites start their own server on an available local port, use a temporary SQLite database and isolated browser profiles, and block requests to external services. They do not open or edit your saved projects. Each suite closes its browser and server and removes temporary files on normal completion or a caught test failure.

| Suite | Coverage |
|---|---|
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
```

### Visual rendering checks

When changing Gantt positioning or styling, also review the chart at 100%, 150% and 200% display scaling in both Compact and Adaptive density. Include task bars with internal and external labels, parent summaries, milestones, critical paths and rounded dependency connectors. Check Fit and timeline zoom, then move and resize a bar and cancel a drag with Escape. Labels should remain centered, bar edges should stay defined, and connectors should meet their bars.

Display scaling changes the browser's device pixel ratio; this is separate from the CSS zoom exercised by `browser-fit.mjs`. The suite checks layout and interactions, but does not automatically judge visual sharpness.

### Optional screenshots

By default, screenshots are written inside the suite's temporary directory and removed during cleanup. To keep screenshots for review, set `PLAN_TEST_ARTIFACTS` to a directory outside the checkout. The structure, fit and slack suites create separate `structure/`, `fit/` and `slack/` subdirectories there, including a failure screenshot when possible. The diagnostics suite writes `diagnostics-report.json` directly into the chosen directory.

For example, in PowerShell:

```powershell
$env:PLAN_TEST_ARTIFACTS = Join-Path $env:TEMP "plan-browser-results"
node tests/browser-structure.mjs
node tests/browser-fit.mjs
node tests/browser-diagnostics.mjs
node tests/browser-slack.mjs
```

In a POSIX shell:

```sh
PLAN_TEST_ARTIFACTS=/tmp/plan-browser-results node tests/browser-structure.mjs
PLAN_TEST_ARTIFACTS=/tmp/plan-browser-results node tests/browser-fit.mjs
PLAN_TEST_ARTIFACTS=/tmp/plan-browser-results node tests/browser-diagnostics.mjs
PLAN_TEST_ARTIFACTS=/tmp/plan-browser-results node tests/browser-slack.mjs
```

These optional outputs can be deleted after review. Generated screenshots, logs, databases and local agent/check ledgers do not belong in commits. Keep one-off comparison scripts and source snapshots outside the checkout and remove them with their screenshots after validation. The existing regression suites are maintained development tools and stay in the repository.

For a clean folder copy to another user, use GitHub's repository ZIP or `git archive --format=zip --output=../plan.zip HEAD` from the committed checkout. Both include the bundled Windows runtime and maintained tests while excluding ignored local caches, virtual environments, agent notes and validation output. When cleaning a working checkout, stop any processes using its virtual environment before removing `.venv`; remove generated `__pycache__`, `.ruff_cache`, `.pytest_cache` and completed local validation output as needed. Keep the entire `runtime/windows-x64` directory, its license, manifest and SPDX metadata together.

## Native Windows reminder feasibility

Run `python3 -B -m unittest discover -s tests -p "test_reminder_*.py" -v` for the isolated native regressions. They exercise authorization/account binding, alias differences, protected-state serialization using a test-only protector, Graph outcome classification, task configuration/repair, transactional self-test claims, crash uncertainty, source fencing, control endpoint origin/allowlist checks, and bundled dependency hashes/licenses/native architecture. The full Python discovery command above includes this suite.

The [native feasibility runbook](native-reminder-feasibility.md) documents maintainer app registration, dependency reproduction, an isolated Windows profile/task, test-mail receipt checks, relocation, restart and cleanup. Normal startup does not enable this harness or change scheduler ownership. Its worker never reads or initializes project storage; every mail test is explicitly requested and addressed only to the connected test mailbox.

These automated checks have run on Linux. Actual bundled-interpreter MSAL imports and DPAPI are Windows-only tests and remain skipped here; no Task Scheduler registration, managed-device approval, corporate sign-in or live test-mail receipt has been verified. The native application ID is not provisioned. The phase-one feasibility gate and all remaining production rollout gates in [the plan](windows-reminder-agent-plan.md) remain unresolved. Keep private test state and any uncertain submissions for review; stop/remove the isolated task before deleting its checkout.

## Verification limits

Automated native picker results are supplied by the tests. The file-handle suite uses real browser-private file handles to exercise writes and persistence across refresh; it does not operate the OS Open/Save As dialogs. Permission, external-edit conflicts, cancellation and uncertain save outcomes also have unit coverage. A separate manual check on Linux used an isolated database/profile and the real native chooser to open the reported `.plan` file, then clicked Log → Download log and verified all Open/IndexedDB stages in the actual download. This does not verify the Windows chooser.

Slack tails were reviewed visually in Chromium on Linux at 100%, 150% and 200% device scaling in both densities; other browsers and Windows display scaling have not been reviewed.

Microsoft 365 behavior has been checked with mocked Graph responses, not a live tenant. Launcher and persistence tests have run on Linux, including source startup with isolated imports and bundle integrity checks. The test that executes the Windows interpreter is skipped on Linux. Windows batch launcher/updater scripts have been reviewed, but have not been executed in Windows cmd.exe; before distributing a runtime update, also launch `start.bat` on Windows with networking disabled and confirm browser startup and SQLite saves. The PowerShell examples above document setup rather than a completed Windows test run.
