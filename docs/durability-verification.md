# Durability implementation verification

The [durability proposal](durability-proposal.md) is implemented with SQLite as the single authoritative workspace. Substantive actions use isolated candidates and are accepted after the server commits. SQLite retains `BEGIN IMMEDIATE`, revision checks, `synchronous=FULL`, retained history and the existing native file-operation safeguards.

Implementation verification below ran on Linux with isolated databases and browser profiles on 25–26 November 2026. Independent Antigravity Gemini 4 Neon High approved the implementation in its third review pass. A later independent Claude Opus 5.5 high-effort review (cliproxyapi) found and re-verified fixes for further defects and approved the source. Actual Windows chooser and latency/scale checks ran on 26 November 2026. A subsequent follow-up fixed a SQLite query-plan regression, reduced checkpoint compression cost and hardened connection bursts, with independent Astra and Opus approval. The Windows host initially went offline; after it returned, the final source passed bundled-runtime regressions and a matched startup experiment reproduced dependency connection refusals with the old backlog and prevented them in the observed fixed-backlog sample. Additional Windows evidence is recorded below.

## Automated evidence

| Check | Recorded result | What it establishes |
| --- | --- | --- |
| Python regression suite | 101 tests, OK; 1 Windows-only skip | Storage, server, history, file APIs, patch validation/accounting, migration and rollback regressions. |
| JavaScript regression suite | 309 passed, 0 failed | Coordinator isolation/acceptance, model compatibility, file operations and existing analysis/scheduling behavior. |
| Original implementation browser run | All 12 maintained suites passed before the follow-up | Existing task/calendar/version/delay/structure/file/analysis/layout/diagnostic workflows against commit-before-acceptance production at that stage. |
| Post-follow-up browser matrix | All 4 core suites passed in Chrome 158 and Firefox 155 on final source | Fault, action, local-file service and diagnostics workflows; 8 successful suite runs on Linux. |
| Browser fault suite | 10 scenarios passed | Startup failures, held/lost acknowledgements, actual SQLite rollback, delayed-original versus retry conflict, read-only/conflicting profiles, cosmetic no-write behavior, verified preference adoption, independent copy and Log during an outage. |
| Browser action suite | 15 scenarios passed | Compound delay decisions, rejection and corrected resubmission, lost-ack adoption, Gantt previews/cancel, atomic version restore/Undo/Redo, templates, cause input, reset, multi-sheet import and read-only controls. |
| Deferred-transport UI harness | Passed | Dialog input retention, acknowledgement ordering, cause retry adoption and a locked/pending/suspended/stale matrix that blocks editors, confirmations and writes. |
| Whitespace check | Passed | `git diff --check`. |

The single Python skip executes the bundled Windows interpreter from another directory and requires Windows. Passing Linux file APIs or supplied browser handles does not prove OS chooser behavior.

The incremental backend suite contains 36 tests. It checks exact escaped subtree ranges, nested array remapping without decoding retained snapshots, original-hash net history, true no-ops, transaction rollback including a genuine SQLite COMMIT failure, process death before/after commit, concurrent revisions, upgrade rollback and transactional logical byte accounting. A cross-language matrix uses real JavaScript production candidates, delay hooks and structural changes with the Python storage boundary, covering baselined structure changes, milestone conversions and Undo/Redo. Historical agreed-date fields remain compatible.

For the same project-name edit with 1 and 100 projects, the measured request and logical server work remain equal: 97 request bytes, 16 nodes visited, 1 hashed, 1 net written and 0 remapped. Guards also reject decoding or hashing unrelated project bodies and retained undo entries. These are logical node counters, excluding SQLite internal I/O; periodic history checkpoints and large affected-project work retain their documented costs. These figures are not Windows latency measurements.

Run the maintained checks using [testing.md](testing.md). Fault tests use temporary databases/profiles; they do not touch installed user workspaces or native-operation registries.

## Independent review

Antigravity Gemini 4 Neon High, with high effort, completed three source and test audits. Findings were fixed and covered by regressions: atomic overdue validation, preview/cancellation cleanup, reset history, cause acceptance, bootstrap lock release, read-only file refusal, blocked controls, committed-versus-draft copy encoding, verified retry presentation, structural no-ops and frontend/backend schema compatibility. The third pass approved all fixes and the complete Linux browser evidence with zero unresolved implementation defects. The reviewer independently reran all 99 Python tests and 305 JavaScript tests and repeated the HTTP 400 rejection reproduction, confirming retained input and no false success. External Playwright execution was outside the reviewer sandbox, so its browser assessment audited the source and finalized execution ledgers rather than independently launching browsers. The full report was a local working file and is not committed.

Independent Claude Opus 5.5 (`cliproxyapi/claude-opus-5-5`, high effort) later audited the complete diff and untracked files after an earlier Astra reviewer ran out of usage quota before giving any verdict. Astra's partial findings and the Opus findings were all fixed with regressions: a definitively rejected operation no longer blocks the storage barrier after the input is discarded; formula-bar text survives rejection; PDF slack preference adopts after a verified retry; per-task `collapsed` merge on accepted child insertion; an inline editor is bound to its originating project; loading or navigating never schedules and publishes unacknowledged dates; the retire listener ignored its own `input` events and removed the editor mid-typing; a rejected editor was resubmitted by the blur from re-rendering and lost focus; and a stale "Action rejected" badge outlived its discarded input. Opus also ran a differential fuzz of the backend patch applier (6 seeds x 250 random set/remove/splice patches including `/`, `~`, numeric and prefix keys) against a reference applier, matching state, byte accounting and no-op revisions. Final verdict: implementation APPROVED, with Windows evidence treated as external release evidence. The full report was a local working file and is not committed.

## Windows verification (26 November 2026)

Run on the configured Windows 10 (build 19045) machine in the logged-in console session (session 1) with the bundled Python 3.14.10, installed Microsoft Edge 158 and isolated app-data, databases and browser profiles; the real `%LOCALAPPDATA%\Plan` did not exist and was not touched.

- Bundled-interpreter Python suite: 99 tests, OK, 0 skipped (the Windows-only runtime test ran). The process-death storage test now passes the repository root explicitly because the bundled interpreter ignores the working directory and `PYTHONPATH`.
- Browser suites with Edge: fault (10 scenarios), action (14 scenarios at that time; 15 after a later regression was added), local-files, diagnostics, Fit, versions, delays, task-dialog and structure passed. Critical-path failed once from a test race (the bar class was asserted before it was painted); the wait was fixed, a similar race was fixed on Linux, and critical-path then passed three times on Windows and on Linux.
- Actual OS choosers with the foreground lock armed by input from a separate process before each dialog: Open then Cancel (no write, status Saved), Save As to a new `.plan` file (9,675 bytes written), Open of that file (added a project tab) and server shutdown with a chooser open (dialog closed, 21 ms). In every case the chooser was topmost above Edge and was the foreground window, and each dialog was driven through Win32 and UI Automation. Native registry files were under the isolated app-data folder.
- Latency (headed Edge, real server, 400-task chained projects, 15–25 acknowledged edits per row):

| Workspace | Edit | Action-to-ack median / p95 | Request bytes |
| --- | --- | --- | --- |
| 1 large project (state JSON 99 KB, database 1.7 MB) | rename one task | 51 / 57 ms | 98,125 |
| same, plus 24 unrelated 400-task projects (6.16 MB JSON, 34.8 MB database) | rename one task | 49 / 58 ms | 98,125 |
| 1 large project | duration of chain head, cascades through 400 tasks | 188 / 257 ms | 131,917 |
| plus 24 unrelated projects | same | 193 / 1,332 ms (one outlier in 15) | 131,917 |

Growing only unrelated projects left request bytes identical and showed no measured median increase in this Windows sample. This does not establish a general query-complexity bound across SQLite builds. The roughly 98 KB request for a one-task rename is the affected project's undo-history snapshot, which is affected-project cost, not unrelated-project cost. The 1.3 s p95 is a single outlier; its cause was not isolated. Logical nodes visited/hashed/written remain covered by the backend counters, which also pass on Windows.

## Follow-up fixes and measurements (26 November 2026)

The server now sets its listen backlog to 128 instead of inheriting 5. A regression holds the real production server's accept loop, queues 32 connections and then verifies every HTTP response against the actual `main.js` bytes. Astra independently verified the exact regression with 128 passing, an in-memory override to 5 failing at connection establishment, and restored 128 passing. Separate controlled bursts distinguish connection pressure from missing files and broken response bodies. This proves connection-burst hardening on Linux. A subsequent matched Windows experiment below reproduced the reported dynamic-import error and identified refused dependency connections; the original historical incident itself has no network trace. No navigation retry was added, and startup failures still leave the error banner and Log available.

Opus identified an avoidable workspace-wide scan inside each affected-subtree lookup. On system SQLite 3.53.4, the old explicitly collated OR expression selected `SCAN current`; a 400-task cascade executed that lookup roughly 1,200 times. Two disjoint `UNION ALL` branches now search the primary-key index for the exact path and its descendants. A VM-instruction regression grows unrelated rows from zero to 20,000 and rejects a corresponding scan. Both advisers independently ran the regression against the old and new queries, including negative controls. Other SQLite builds already indexed the old query, so this finding does not establish that Windows used the slow plan.

Periodic full hash-map checkpoints now use zlib level 1, reducing compression cost while adding about 11% to the measured snapshot blob size. Object and changes encoding stays at level 6, preserving object hash identity. Astra verified a database containing old level-6 and new level-1 snapshots with both original and current decoders; Opus compared default encoded bytes on 2,345 values. Snapshot cadence, schema, `synchronous=FULL`, DELETE journaling and commit-before-acknowledgement are unchanged.

Opus's isolated backend measurements used actual final code, temporary databases on tmpfs, a quiet CPU and 104 edits per workspace, including an affected-project undo string per edit:

| Workspace | Rename median | 400-task cascade median / max | Checkpoint at revisions 50 / 100 |
| --- | --- | --- | --- |
| 1 project | 3.8 ms | 98 / 118 ms | 16 / 16 ms |
| 25 projects, about 160,000 paths | 3.9 ms | 102 / 124 ms | 314 / 315 ms |

The controlled old-query baseline on the same machine took about 260 ms per cascade with one project and 6.3–12.7 s with 25 projects. Those baseline edits omitted undo strings, so they isolate the scan mechanism rather than provide an exact whole-operation speedup. Tmpfs timings do not measure physical-disk synchronization or Windows latency.

A separate serialized headless Chrome 158 trace used real grid edits and the production commit path, with test-only profiling of candidate creation, transport, backend transaction including COMMIT, adoption and an observation after two animation frames. Each of 180 actions had exactly one successful commit. Thirty renames and thirty 400-task cascades ran in each phase; the final phase prefilled the undo stack to its 150-entry cap. Ordinary edits and checkpoint revisions are reported separately:

| Phase | Rename action-to-ack median / p95 | Cascade action-to-ack median / p95 | Cascade backend median |
| --- | --- | --- | --- |
| 1 project | 133 / 158 ms | 178 / 233 ms | 133 ms |
| 25 projects | 132 / 183 ms | 180 / 205 ms | 134 ms |
| 25 projects, undo stack at cap | 136 / 153 ms | 185 / 202 ms | 143 ms |

For renames the backend median was 5–10 ms; most of the remaining action-to-ack time is browser main-thread rendering that delays observing the response. JavaScript timestamps taken when fetch/body promises resume include that contention, so they cannot attribute the interval solely to transport or server work.

The large-workspace checkpoint at revision 100 took 626 ms action-to-ack, including 443 ms in checkpoint finalization and 573 ms in the backend transaction overall. Later checkpoint acknowledgements were 480 and 529 ms. Whole-workspace snapshots remain an explicit periodic cost; they have not been deferred beyond acknowledgement. The non-checkpoint cascade request median was 129,225 bytes in the small phase and 129,237 bytes after unrelated growth; the 12-byte difference comes from the probe's different task-name strings. No unrelated project bodies were sent. The earlier identical-input byte-count regression remains the exact equality check.

The trace's median acknowledgement-to-final-observation interval was about 121–123 ms for renames and 455–459 ms for cascades. It includes substantial application work after acknowledgement, Playwright polling/control overhead and two animation frames; it is not a direct paint measurement or an attribution of the entire interval to test overhead. These headless Linux observations cannot be substituted for headed Windows interaction measurements or establish the cause of the original Windows 1.3 s sample. The earlier Windows probe recorded a resource response boundary without the new per-revision server correlation.

Local Chrome 158 and Firefox 155 each completed 40 cold starts with current-navigation `app.ready`, hidden startup error and the expected saved/read-only state. No request failures or page errors occurred in those runs. The four core suites now accept `PLAYWRIGHT_BROWSER` and retain their fault, atomic-action, file-service and diagnostics assertions. All four passed in both Chrome and Firefox against the final follow-up source, including the 10-scenario fault suite and 15-scenario action suite in each browser. This is Linux browser-engine evidence; file-service tests inject chooser results. After later test-only fixes (awaiting downloads and a render wait), the fault and action suites reran successfully on Linux Chromium and Firefox.

Astra and Opus (cliproxyapi), both using high effort, independently approved the backend changes and their compatibility. Detailed reports and raw traces were kept in a local, ignored working folder and are not part of the repository; the production response does not include profiling fields.

## Resumed Windows follow-up (26 November 2026)

After the PC returned, a new isolated source copy was matched by SHA256, including the bundled Python 3.14.10 runtime (SQLite 3.50.4, zlib-ng 1.3.1). All 101 Python tests passed with no skips, and all 309 JavaScript tests passed. Scheduled interactive tasks ran in the logged-in console session. The unit, first (traced) startup and latency runs predate the temporary-directory redirect, so their disposable files were created under the user's `%TEMP%`; later runs, including production startup and the environment capture, recorded the redirected isolated temporary directory. No production database, browser profile or application data directory was used, and the real `%LOCALAPPDATA%\Plan` location stayed absent. Console-session identity was recorded per run for the production-startup, environment-capture, chooser and matrix runs; for the traced startup and latency runs it follows from the same launcher and the later capture.

Two separate, interleaved headed Edge 158 experiments compared 30 fresh-browser starts with backlog 5 and 30 with 128. Failed first attempts were retained rather than reloaded into successful results:

| Server configuration | Backlog 5 | Backlog 128 |
| --- | --- | --- |
| Production handlers with accept/GET tracing; native files disabled | 5 failed startups / 30 | 0 / 30 |
| Production entry point and native-file configuration, without accept/GET tracing | 9 failed startups / 30 | 0 / 30 |

In every failed startup, CDP and Chromium netlogs identified uncanceled dependency requests refused by Windows (`WSAECONNREFUSED`, OS error 10061; Chromium `ERR_CONNECTION_REFUSED`, net error −102). The root `main.js` response was HTTP 200 with its full 22,011 bytes, but importing its graph produced the same `Failed to fetch dynamically imported module` diagnostic as the reported problem. The first series contained 19 refused dependencies; the second contained 44. One additional response-body read in the second series was canceled during teardown after a successful CDP response, and is recorded separately from connection failures.

Astra and Opus independently traced the request/connect chains and recomputed the results. In the instrumented series, successful client ports joined server accept records; refused attempts occurred while five successful connections were pending acceptance. Increasing only the backlog prevented the observed failure in both matched samples. This establishes a reproduced Windows failure mechanism and a matched intervention: 0 failures in 60 matched backlog-128 starts (a 95% upper bound of about 5%) against 14 in 60 at backlog 5. The historical untraced incident is strongly consistent with it, while zero failures in these finite samples is not a guarantee against every startup failure. Native file service initialization is lazy; the production-configuration startup run did not itself exercise a chooser.

The headed Edge latency run completed 180 substantive edits, exactly one acknowledged commit per action, with the same three phases and checkpoint separation as the Linux trace:

| Phase | Rename action-to-ack median / p95 | Cascade action-to-ack median / p95 | Cascade backend median |
| --- | --- | --- | --- |
| 1 project | 91 / 97 ms | 207 / 241 ms | 162 ms |
| 25 projects | 97 / 103 ms | 191 / 207 ms | 154 ms |
| 25 projects, undo stack at cap | 96 / 107 ms | 198 / 217 ms | 162 ms |

The large-workspace checkpoint at revision 100 took 557 ms action-to-ack, with 365 ms in finalization and 522 ms in the complete backend transaction. Checkpoint acknowledgements at revisions 150 and 200 were 445 and 433 ms. First-frame observations ranged from 39–72 ms, with none at or above 100 ms; the trace did not show frame throttling. A separate environment capture recorded session 1, Edge 158, DPR 1, a 1280×720 screen and Balanced power mode; the test viewport was 1500×900. The timestamps still include browser scheduling and frame-observation overhead. The earlier single Windows 1.3 s outlier was not reproduced and remains unattributed; this run does not prove a checkpoint caused it.

Actual OS chooser checks then ran with the foreground lock armed by checked `SendInput` calls from a separate helper. The test bound the launched Edge window's HWND, asserted it was foreground before each operation and verified each Python-owned dialog was above that same window. Open and Save As cancellation left workspace state/revision unchanged and wrote no sample file. Local Save As and subsequent Open verified task contents. An existing `Users` share was accessed through a `\\\\<this-PC>\\Users\\<user>\\Documents\\…` path: native UNC Save As, connected Save and native Open round-tripped the expected content. The database and native registry remained in isolated local test folders.

Graceful shutdown used a test-only trigger that calls `server.shutdown()` from another thread, allowing production `main()` to reach its existing `file_service.close()` finally block. Python exited successfully and the open chooser disappeared in 3,593 ms, below the probe's 10 s bound. Earlier probe setup failures were retained separately: a window-title observation race, focus stolen by a helper console, and an assertion that incorrectly included the grid's disclosure marker in the saved name. The corrected probe used a hidden helper console, real input to the owned HWND and the task-name span; it passed all scenarios. These setup failures are not counted as application failures or silent successful retries.

## Windows headed browser matrix

The final clean run (`browsers-headed4` and `firefox-headed4`, with the final actions test `42cf0980…`) executed all four browser suites (durability, durability actions, local files, diagnostics) headed in the console session on Edge 158, Chrome 158 and portable Firefox 148: 12 of 12 suite/engine cells passed. Earlier failed attempts are retained rather than counted as retries:

- A headless Edge run and a headed Edge run each lost the whole browser about two seconds after the PDF-export scenario, and five further diagnostic runs failed the same way (7 of 8 in-suite runs before the fix, one diagnostic run passing). A minimal headed repro isolated the cause to the test, not the application: the durability suite closed its browser context while the PDF download was still in flight, and Windows Edge then exited about two seconds later (3 of 3 failures without waiting; 0 of 12 when `download.path()` was awaited, with or without request interception or a PDF preference change). The headless failure is attributed by its identical signature. The test now awaits the saved file. The actions suite's project download follows the same pattern and awaits the saved file as a precaution; its Edge run had passed without it. Chrome was not run without the wait.
- One Linux Firefox run of the actions suite failed once in seven because the duration cell was read before the adopted value rendered; the test now waits for it. Subsequent Linux runs passed (Chromium and Firefox).
- One Chrome launch exited immediately at the start of a matrix and did not recur: every later Chrome run, including the final matrix, passed.
- Windows Firefox failed the rejected-inline-edit navigation scenario in all six repeats: the first click on another project tab, made while a rejected inline edit was focused, only blurred the editor and did not switch projects. An event trace showed `pointerdown`/`mousedown` on the tab at 69 ms, the editor blur at 70 ms, a tab-strip DOM rebuild at 95 ms and `pointerup`/`mouseup` on the replacement element at 99 ms with no `click` dispatched. The strip is rebuilt when the blur retry blocks input, replacing the pressed tab. A later click, after the retry settles, switches projects (no immediate second click was traced). This is a user-visible Firefox interaction issue in the application; it is recorded here, not fixed, because a fix would change application source and require re-verification. Chromium was not affected in these runs, although the same rebuild is timing-sensitive there. The Firefox test path blurs the editor and waits for the retry before switching, so the project-binding invariants are still asserted; the Chromium path keeps the original direct tab click.

## Remaining before rollout

The 128 backlog is hardening with margin (the largest queue depth observed was 6), not a guarantee against every startup failure. In Firefox, the first click on another project tab while a rejected inline edit is focused may only blur the editor; a second click switches. Owner acceptance of measured Windows interaction delay remains a product decision; no numerical product latency target was set. The headed browser matrix is above.

The UNC checks establish same-PC loopback SMB behavior through an existing share. A separate remote server/NAS, network disconnects and different remote credentials remain untested; no such destination was configured. No SMB, account or security settings were changed.

Do not infer network filesystem locking support for the authoritative `plan.db` from portable-file tests; keep that database on a local filesystem. Testing an existing designated scratch destination does not require enabling SMB or changing accounts/security settings.

Close editing tabs and restart Python when installing this change; live database replacement remains unsupported. Download copy offers portable project data during a service outage, while unsubmitted/unconfirmed input remains memory-only.

## Grid scrolling (26 November 2026)

Scrolling the task grid was janky even before this work; HEAD behaved the same, so the durability changes are not the cause. Chromium traces showed the main-thread Layerize step costing about 330 ms per frame. Two pre-existing style patterns caused it: the first two cells of every row are `position:sticky`, and Focus dimming used group `opacity` on about 200 link groups plus an opacity transition on each dimmed row. Rows now form their own stacking context, and dimmed links fade their strokes. Measured slow frames (over 50 ms, of about 200) in headless Chromium: 49 to 84 before and 0 to 1 after, on a fresh page, after selecting a task and after an edit. Visible change: dimmed rows switch instantly instead of fading over 0.2 s. Because a selection is restored at load, the dimming (and the jank) could appear without any click. Headless software rendering only; real headed Chrome/Edge, momentum scrolling and Firefox are unmeasured.
