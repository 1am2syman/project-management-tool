# Test maintenance audit

The audit covers all 44 maintained files under `tests/`: eight Python suites, 21 JavaScript unit suites, 14 browser suites and one browser-server helper. Each suite was checked against current production modules and its supported behavior. Literal production-module imports resolve. Windows-only checks, older file/database formats and inert metadata are supported contracts, so their age alone does not make them removable.

## Removed obsolete coverage

Removed `StorageTests.test_invalid_writes_preserve_saved_state` from `test_storage.py`. It posted full workspace updates using the bootstrap response as the request envelope. That response contains `dataFile`, which the HTTP endpoint rejects as an extra field; a non-null revision would also be rejected because full HTTP saves are bootstrap-only. Its six malformed state fixtures never reached state validation. A focused probe wrapping `persistence.validate_state` confirmed that only the valid initial state and subsequent readbacks were validated while the test still passed.

The useful assertions now belong to existing current-contract tests in `test_durability.py`:

- `PatchHTTPTests.test_strict_fields_duplicates_numbers_and_request_size` submits the six malformed states to `/api/projects` with exactly `revision: null` and `state`. It asserts HTTP 400, verifies that each supplied state reaches validation, and checks that no database was created. Existing assertions retain wrong-content-type and foreign-origin rejection.
- `PatchHTTPTests.test_bootstrap_patch_identity_stale_and_incompatible_full_client` retains the explicit rejection of full updates, and now also checks that a no-op patch with a valid same-origin header succeeds without advancing the revision.
- Invalid patch invariants, malformed task records, transaction rollback and preservation of committed state remain covered by the existing durability suite.

Removed two unused full-state fixture mutations from the storage history/rollback tests as well. Those tests already send explicit patches; their database, history and rollback assertions remain intact.

No other test or helper was confirmed obsolete. No production code changed in this cleanup.

## Python suites

| File | Current contract and disposition |
|---|---|
| `test_desktop_launcher.py` | Keep: batch-to-app handoff, shortcuts, option forwarding, browser discovery, window ownership/focus, lifecycle, icon and app-session endpoints. |
| `test_durability.py` | Keep and consolidate: bootstrap/patch HTTP validation, atomic updates, replay, accounting, bounded work, schema upgrade and failure recovery. Receives the useful assertions from the obsolete full-update test. |
| `test_file_api.py` | Keep: native file-service authorization, readiness, operation ownership, workspace revisions, connection tokens and source alias protection. |
| `test_native_dialogs.py` | Keep: Windows chooser worker dispatch, bounded shutdown, cancellation and raise ownership. Mocked checks remain useful on Linux. |
| `test_project_files.py` | Keep: file connection durability, conflicts, aliases, journal recovery, locks, concurrent saves and format validation. |
| `test_runtime.py` | Keep: bundled runtime provenance, checksums, executable architecture and isolation; actual interpreter execution requires Windows. |
| `test_storage.py` | Keep remaining coverage: SQLite restart/history, conflicts, corruption handling, diagnostics, HTTP resource handling, startup burst and source launcher. Remove the obsolete full-update validation test described above. |
| `test_updater.py` | Keep: the maintained Windows updater's explicit backup/cancel choices, clean updates and interrupted-input behavior. Windows/Git requirements justify the platform skip. |

## JavaScript unit suites

| File | Current contract and disposition |
|---|---|
| `calendar.test.mjs` | Keep: working-day arithmetic, scheduling bounds, old file calendars, import and independent schedule oracles. |
| `commit.test.mjs` | Keep: candidate isolation, acknowledgement ordering, compound actions, retries, editor adoption and strict names. |
| `contour.test.mjs` | Keep: the active contour animation's geometry, noise, fades, reduced-motion inputs and bounded tracing work. |
| `critical-target.test.mjs` | Keep: milestone-scoped critical paths, float, target preferences, invalid-target fallback and read-only views. |
| `delays.test.mjs` | Keep: agreed dates, own/inherited delay, revisions, causes, inclusion/omission, recoveries, versions and exports. |
| `diagnostics.test.mjs` | Keep: bounded diagnostics, redaction, URL labels, startup/resource errors, storage checks and pending operations. External URL strings are redaction fixtures, not cloud service tests. |
| `localfiles.test.mjs` | Keep: file-service session rotation, retry identity, initialization failure and chooser recovery controls. |
| `longest-path.test.mjs` | Keep: driving-chain rules, independent oracles, preferences, file compatibility and exports. |
| `people.test.mjs` | Keep: local owner resolution and preservation of inert legacy reminder/sharing metadata. No live Microsoft 365 feature is exercised. |
| `persistence.test.mjs` | Keep: saved workspace/history restoration, preview settings migration, quota handling, undo limits and adoption. The non-database preview path still supports browser storage. |
| `projectfiles.test.mjs` | Keep: current/older `.plan` files, safe imports, save/download behavior, permissions, conflict handling and commit barriers. Legacy sharing identifiers are privacy/compatibility fixtures. |
| `relationships.test.mjs` | Keep: link uniqueness, cycles, editing and explicit resolution of older duplicate constraints. |
| `scheduling.test.mjs` | Keep: automatic/manual/anchor modes, scheduling changes, default modes and saved state. |
| `slack.test.mjs` | Keep: total/free slack, independent feasible-schedule oracles, target scope and recomputation. |
| `storage-barrier.test.mjs` | Keep: canonical database identity, bootstrap locks, patch transport, lost acknowledgements, retry and prevention of browser shadow writes. |
| `structure.test.mjs` | Keep: hierarchy, subtree moves, insertion/conversion, undo and read-only restrictions. |
| `task-calendars.test.mjs` | Keep: per-task calendars, receiver-calendar rules, imports, versions and attribution. |
| `task-dialog.test.mjs` | Keep: atomic task-field validation, actual dates/notes, link editing and model operations used by the dialog. |
| `versiondiff.test.mjs` | Keep: comparison, trends, chart markup, waterfall details and PDF/Excel output. |
| `versions.test.mjs` | Keep: snapshots, previews, restore/copy, limits and older version-bearing files. Read-only imported snapshots remain a compatibility contract. |
| `waterfall.test.mjs` | Keep: finish attribution, parallel branches, dependency/calendar changes, residuals and deterministic generated schedules. |

## Browser suites and helper

The browser suites own temporary SQLite data, fresh contexts/profiles and loopback servers. They cover interactions and integration that unit suites cannot establish. File-picker mocks and supplied handles do not establish native Windows chooser behavior.

| File | Current contract and disposition |
|---|---|
| `browser-contour.mjs` | Keep: active animated surfaces, layering, pointer response, reduced motion and script failure. |
| `browser-critical-path.mjs` | Keep: critical method/target controls, persistence, slack inspection and exports. |
| `browser-delays.mjs` | Keep: delay dialogs, causes, agreed dates, decisions, analysis and export controls. |
| `browser-diagnostics.mjs` | Keep: Log/download controls and startup dependency-failure recovery. |
| `browser-durability-actions.mjs` | Keep: rendered editor/decision/import/version actions across acknowledgement and rejection boundaries. |
| `browser-durability.mjs` | Keep: server faults, lost acknowledgements, read-only profiles, identity changes and Download copy during outages. |
| `browser-fit.mjs` | Keep: Fit, responsive layout, scheduling, connected saves and critical targets. |
| `browser-gantt-controls.mjs` | Keep: current axis markers, automatic Fit, critical focus controls and Gantt layout. |
| `browser-local-files.mjs` | Keep: Python-managed file-service integration and response-loss recovery through actual app controls, using an injected chooser. |
| `browser-slack.mjs` | Keep: slack display, inspection, overlays, target scope, exports and scaled geometry. |
| `browser-structure.mjs` | Keep: hierarchy actions, drag/drop, calendars, import and persisted structure. |
| `browser-task-calendars.mjs` | Keep: calendar controls, draft/reset behavior, layout, import/export and reload. |
| `browser-task-dialog.mjs` | Keep: item dialog, progress/actuals, connections, preview restrictions and layout. |
| `browser-versions.mjs` | Keep: version controls, restore/copy, comparison, file round trips and scaled layouts. |
| `file_api_browser_server.py` | Keep: explicitly used by `browser-local-files.mjs` to inject chooser outcomes without touching the real file registry or OS chooser. |

## Verification

Use the maintained commands in [testing.md](testing.md). Audit results are recorded there after verification. Linux results cannot establish Windows shortcut installation, native chooser behavior or execution of `update.bat` in `cmd.exe`.
