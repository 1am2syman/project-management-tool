# Development and testing

Plan uses Python 3.10+ and browser ES modules without a front-end build step. Run it with `uv run --locked project-management-tool` or `python start.py`. Node.js is needed only for JavaScript regression tests; Playwright is optional for browser tests.

## Regression tests

Run these commands from the repository root:

```sh
uv run --locked python -B -m unittest discover -s tests -p "test_*.py" -v
node --test tests/persistence.test.mjs tests/relationships.test.mjs tests/projectfiles.test.mjs tests/structure.test.mjs tests/calendar.test.mjs tests/scheduling.test.mjs
```

The Python suite covers SQLite persistence, saved history, conflict handling and launcher behavior. JavaScript tests cover task hierarchy and subtree movement, relationship validation, working calendars, all four dependency types, critical-path calculations, scheduling modes, project-file validation, native Save behavior and undo/redo.

## Optional browser tests

Install Playwright for development, then install its Chromium browser:

```sh
npm install --no-save --package-lock=false playwright
npx playwright install chromium
```

Playwright is not required to run Plan. If Playwright is installed outside this checkout, set `PLAYWRIGHT_MODULE` to the absolute path of its `index.mjs` module instead of installing it here.

Run both interaction suites:

```sh
node tests/browser-structure.mjs
node tests/browser-fit.mjs
```

Both suites start their own server on an available local port, use a temporary SQLite database and isolated browser profiles, and block requests to external services. They do not open or edit your saved projects. Each suite closes its browser and server and removes temporary files on normal completion or a caught test failure.

| Suite | Coverage |
|---|---|
| `browser-structure.mjs` | Nested cascades, pointer reordering/nesting, invalid drops, cancellation and autoscroll, insertion/conversion menus, keyboard shortcuts, calendar draft/apply/cancel, Excel calendar round-trips, narrow menus, read-only restrictions and restoration from SQLite in a fresh browser profile. |
| `browser-fit.mjs` | Measured Fit label bounds, single-row responsive toolbar and accessible icon actions, full switch labels at 125–200% zoom and narrow pane splits, sheet/Gantt alignment, adaptive density on resize/collapse, scheduling actions and sheet-only badges, undo/redo, saving an active edit, connected file reuse after refresh and Save As. |

### Browser and Python selection

Set `PLAYWRIGHT_CHROMIUM` to an installed Chromium executable to test with that browser instead of Playwright's bundled build. Set `PYTHON` to a Python executable if `python3` is unavailable, as is common on Windows.

For example, in PowerShell:

```powershell
$env:PYTHON = "python"
$env:PLAYWRIGHT_CHROMIUM = "C:\Program Files\Google\Chrome\Application\chrome.exe"
node tests/browser-structure.mjs
node tests/browser-fit.mjs
```

### Optional screenshots

By default, screenshots are written inside the suite's temporary directory and removed during cleanup. To keep screenshots for review, set `PLAN_TEST_ARTIFACTS` to a directory outside the checkout. The suites create separate `structure/` and `fit/` subdirectories there, including a failure screenshot when possible.

For example, in PowerShell:

```powershell
$env:PLAN_TEST_ARTIFACTS = Join-Path $env:TEMP "plan-browser-results"
node tests/browser-structure.mjs
node tests/browser-fit.mjs
```

In a POSIX shell:

```sh
PLAN_TEST_ARTIFACTS=/tmp/plan-browser-results node tests/browser-structure.mjs
PLAN_TEST_ARTIFACTS=/tmp/plan-browser-results node tests/browser-fit.mjs
```

These optional outputs can be deleted after review. Generated screenshots, logs, databases and local agent/check ledgers do not belong in commits.

## Verification limits

Native picker results are supplied by the tests. The file-handle suite uses real browser-private file handles to exercise writes and persistence across refresh; it does not operate the OS Open/Save As dialogs. Permission, external-edit conflicts, cancellation and uncertain save outcomes also have unit coverage.

Microsoft 365 behavior has been checked with mocked Graph responses, not a live tenant. Launcher and persistence tests run on Linux. Windows batch launcher/updater scripts have been reviewed, but have not been executed in Windows cmd.exe; the PowerShell examples above document setup rather than a completed Windows test run.
