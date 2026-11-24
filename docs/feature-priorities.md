# Feature priorities for Plan

Research checked: 20 November 2026. Scope: Oracle Primavera P6 Professional, Oracle Primavera Cloud, Microsoft Project desktop, and selected current Planner capabilities. Oracle means Primavera Cloud for this comparison, as clarified by the user; Aconex and Fusion Project Management are outside this review.

For the itemized delivery backlog, implementation checklists, dependencies, and acceptance criteria, see the [product roadmap](roadmap.md).

## Recommendation

Prioritize the weekly planning and review workflow: **find the relevant work, identify unreliable logic, see the next few weeks, monitor commitments, and communicate decisions**. Plan already has a substantial scheduling and delay-analysis foundation. Its best near-term opportunities are extensions around that foundation.

Build **saved filters/search, schedule health checks, and rolling lookaheads first**. They offer the broadest value with limited data-model change. Follow with a local cross-project milestone watchlist and a baseline overlay in the main Gantt. Then add a concise status pack, owner overlap warnings, task notes/blockers, activity codes, and dated progress reviews.

These are product and engineering judgments based on the inspected implementation, not measured customer demand, delivery estimates, or financial ROI. The assumed main users are project managers and planners maintaining dependency-based schedules and preparing regular reviews. Engineering/construction examples fit the comparison products, but the recommendations also apply to other project types. No customer interviews, usage analytics, or representative customer schedule benchmarks were supplied.

## What was examined

The review used primary Oracle and Microsoft documentation and the current local source tree. Repository discovery began with jevgrep, followed by direct reads of the task model, derived schedule calculations, grid, Gantt, import, version comparison, delay accounting, file validation, exports, local owner suggestions, and settings persistence. This was a documentation and source review; it did not include hands-on vendor trials or a new runtime regression test of Plan.

### Product distinctions that affect the comparison

- **P6 Professional:** deep activity scheduling and control, including activity codes, filters/layouts, schedule checking, baselines, actual/remaining durations, resources, and constraints. The Activities Window documentation links these capabilities explicitly. [S1–S4]
- **Primavera Cloud:** CPM scheduling plus baselines/scenarios, resource availability and leveling, schedule health, short-term work planning, task constraints, and qualitative risk analysis. Cloud's task constraints are execution blockers such as missing materials or deliverables; they differ from date constraints in a CPM scheduler. [S5–S10]
- **Microsoft Project desktop:** scheduling, tracking Gantt/baselines, status dates, resources, reports, custom fields, filters, and task inspection. These are useful comparators for a standalone local app. [S11–S17]
- **Microsoft Planner:** current premium capabilities include timeline, dependencies, critical path, People view, custom fields, and task history. Product and license boundaries differ from desktop Project. [S18]
- **Project Online:** Microsoft specifies retirement on 30 September 2026. Standalone Project desktop is not retired by that change. This review therefore does not treat Project Online/PWA cloud APIs as a future integration target. Some support pages still contain legacy Project Online instructions. [S19]

### What Plan already supports

| Area | Verified existing capability | Implication for prioritization |
| --- | --- | --- |
| Schedule authoring | Spreadsheet grid, WBS hierarchy, draggable Gantt, milestones, FS/SS/FF/SF links with lag | Adding generic Gantt, dependencies, or hierarchy would duplicate existing functionality. |
| Scheduling control | Auto/manual/date-anchor modes; global auto-schedule switch; violated relationship detection | Build review and explanation on the existing calculations. |
| Calendars | Global workweek/holidays and per-task overrides; calendar-change preview | Weekends, holidays, and mixed calendars must carry into any new reports. |
| Criticality | Longest Path or total-float threshold; selected milestone target; total/free slack and explanations | Critical path and float are already strong foundations. Near-critical filtering can be added without a new engine. |
| Baselines and history | Explicit versions, baseline/status/draft types, read-only preview, restore/copy, automatic local state history | Baseline creation and generic undo/history are not primary gaps. |
| Comparison | Finish/milestone trends, changes, baseline ghost bars in Analysis, finish waterfall, slips, critical-path changes, owner summaries | Add everyday visibility and condensed output, rather than another full comparison engine. |
| Delay accounting | Agreed dates, original/revised agreement, own/inherited delay, causes/party/notes, scope inclusions/omissions, key milestones | General deadline tracking and retrospective delay logs already exist. Forward-looking blockers are a separate opportunity. |
| People | One owner name and optional email per task; workbook-local suggestions | There is no resource capacity, effort, rate, or multi-assignment model to support true resource utilization. |
| Portability | `.plan`, Excel/CSV import, Excel/PDF export, templates, local SQLite persistence | Extend these paths when adding durable task metadata. |
| Operating model | Local, offline-capable; no account required; M365/cloud integrations explicitly out of scope | Favor local capabilities that preserve that operating model. |

Important limits verified in the README and code: no status date, actual start/finish, automatic rescheduling of unfinished work, or delay-claim register in the current release; no general task search/filter/view builder in the main editor; no general task notes/blocker fields or activity codes in the task sanitizer; no workload/capacity system. Search/filter controls inside Analysis apply to its comparison log, not the main task sheet.

Evidence anchors: [README](../README.md), [task normalization](../src/project_management_tool/web/js/model.js#L191), [derived scheduling and visible rows](../src/project_management_tool/web/js/model.js#L725), [grid columns](../src/project_management_tool/web/js/grid.js#L9), [local people](../src/project_management_tool/web/js/people.js#L9), [version metrics/comparison](../src/project_management_tool/web/js/versiondiff.js#L16), [file format](../src/project_management_tool/web/js/projectfiles.js#L12), and [settings](../src/project_management_tool/web/js/appstate.js#L4).

## Rating method

**Value: 1–5, higher is better.** It reflects expected breadth/frequency of use, avoided planning errors, decision usefulness, and fit with Plan's current purpose. A 5 is a core recurring planning/review need; 4 is a strong recurring improvement; 3 serves a narrower workflow; 2 is occasional convenience; 1 has little expected impact. Value is incremental to what Plan already does.

**Complexity: 1–5, lower is better.** It includes model and file changes, UI integration, scheduling risk, and verification. A 1 is a small isolated UI/derived-data addition; 2 is low complexity using existing state; 3 is moderate complexity involving multiple modules or persisted metadata; 4 is a major scheduling/interchange change; 5 requires substantial platform or enterprise infrastructure. Complexity is not a promise of elapsed time.

**Priority ratio = Value / Complexity**, rounded to two decimals. This is a transparent triage heuristic over ordinal scores, not an economic calculation. Ties favor broader recurring use, foundational reuse, and less uncertainty. Treat tied groups as comparable opportunities rather than precisely measured differences. Complexity assumes the bounded first version below, and later recommendations can reuse earlier foundations; it is not the sum of ten standalone builds.

| Rank | Recommended addition | Value / 5 | Complexity / 5 | Priority ratio | Confidence in feasibility rating |
| --- | --- | ---: | ---: | ---: | --- |
| 1 | Search, saved filters, and named task views | 5 | 2 | 2.50 | High |
| 2 | Actionable schedule health checks | 5 | 2 | 2.50 | High |
| 3 | Rolling 2/4/6-week lookahead | 5 | 2 | 2.50 | High after #1 |
| 4 | Cross-project milestone watchlist | 4 | 2 | 2.00 | Medium |
| 5 | Saved baseline overlay in the main Gantt | 4 | 2 | 2.00 | High |
| 6 | Weekly status pack with concise PDF output | 5 | 3 | 1.67 | Medium |
| 7 | Owner overlap warnings and weekly heatmap | 5 | 3 | 1.67 | Medium |
| 8 | Task notes and forward-looking blocker tracking | 5 | 3 | 1.67 | Medium |
| 9 | Activity codes/tags for discipline, area, or contractor | 4 | 3 | 1.33 | Medium |
| 10 | Reporting/status date and planned-versus-reported progress | 4 | 3 | 1.33 | Medium, with the reporting-only scope below |

## The top ten in detail

### 1. Search, saved filters, and named task views

**Value 5/5 · Complexity 2/5 · Ratio 2.50**

**Problem solved:** A planner should be able to answer “show my unfinished tasks due soon” without scanning the entire schedule. Plan's Focus feature traces relationships but does not select tasks by ordinary business criteria.

**Competitor evidence:** P6 offers saved filters, grouping/sorting, and configurable layouts. Project offers predefined/custom filters, AutoFilters, and highlight mode. [S1, S12]

**First version:** Search task names and owner names; combine owner, reported completion state, date range, milestone, critical/near-critical, violated-link, and agreed-date variance filters. Save a named view with its filter, visible columns, and zoom. Ship useful defaults such as “My unfinished work”, “Overdue forecast finish”, “Unassigned”, and “Near critical”. Keep forecast lateness and agreed-deadline lateness distinct.

**Why complexity is low:** Tasks, owners, progress, dates, criticality, link violations, and layout settings already exist. Begin with a small set of AND-combined criteria, preserving WBS order; arbitrary formulas, nested Boolean logic, custom sorting, and new grouping layouts are outside this first version.

**Implementation seam:** Add a shared view projection consumed by grid, Gantt, row navigation, and Fit; persist local view definitions through `appState`. `Store.rows` currently reflects collapse state only. Preserve ancestor context, show a filter count and clear action, and provide a way to reveal a match inside a collapsed group. Filtering must never remove hidden tasks from scheduling calculations or alter task IDs. Hidden dependency endpoints should have an explicit indicator rather than misleading connector routing.

**Acceptance:** The same task set appears in sheet and Gantt; selecting or navigating cannot land on a hidden row; clearing the filter restores all tasks; the selected saved view survives refresh. Confirm scheduling output is identical with filtering on/off.

**Success measure:** Time and number of interactions needed to find a specified subset in a representative schedule, compared with the present workflow.

### 2. Actionable schedule health checks

**Value 5/5 · Complexity 2/5 · Ratio 2.50**

**Problem solved:** A valid-looking schedule can still hide broken logic or poorly specified work. Existing violated-link indicators expose one problem type but do not provide a systematic review list.

**Competitor evidence:** P6 has Check Schedule. Cloud's Schedule Health Score checks open ends, dangling starts/finishes, lag, large/negative float, long durations, missing resources, and other conditions. [S3, S6]

**First version:** A “Check schedule” panel with clickable findings for violated relationships, missing predecessors/successors, unusually long tasks, large/negative float, unassigned work, and manual tasks that contradict dependencies. Explain each finding and jump to the row. Flag leads/long lags as review items, with configurable thresholds. Allow legitimate project start/finish activities to be exempted.

**Why complexity is low:** The model already calculates leaf tasks, incoming/outgoing links, durations, float, and violations. Most checks are pure derived-data rules. Use severity and counts before inventing a composite percentage.

**Implementation seam:** A pure checker over an isolated project view, using full project completion for project-wide float checks. The current selected milestone can legitimately leave unrelated tasks without total float, so a health check must not treat that as an error. The existing diagnostic Log concerns software/runtime failures and serves a different purpose.

**Acceptance:** Seeded bad schedules produce named findings; legitimate boundary activities can be acknowledged; summaries do not double-count; changing a threshold changes the result predictably. Report unavailable checks as unavailable. Invalid actual-date and true out-of-sequence-progress checks need data Plan does not yet have.

**Scope discipline:** Oracle's default thresholds are reference examples, not universal quality standards. Legitimate SS/FF/SF links and negative lag should not be rejected automatically, and the tool should not claim DCMA certification.

**Success measure:** Actionable findings corrected before a plan is agreed, plus the rate of findings dismissed as irrelevant.

### 3. Rolling 2/4/6-week lookahead

**Value 5/5 · Complexity 2/5 · Ratio 2.50**

**Problem solved:** Teams need a short working agenda covering current work and upcoming handoffs, while the full Gantt may span months.

**Competitor evidence:** P6 documents a six-week lookahead filter with relative dates. Cloud's Work Plan offers daily/weekly planning periods and task grouping. [S2, S7]

**First version:** One-click 2/4/6-week windows, grouped sections for overdue unfinished work, work continuing through the window, starts, finishes, and milestones. Include owner, dates, progress, near-critical status, and a link back to the task. Offer a reference-date control and printable list. Add explicit blocker badges when #8 is available.

**Why complexity is low:** This composes #1's filtering with existing date/calendar calculations. It does not need a new scheduling engine or a separate card-board model.

**Implementation seam:** Include any unfinished task whose scheduled interval overlaps the window, not just tasks starting inside it. Include overdue unfinished tasks separately even when their planned interval ended before the window. Milestones need point-date inclusion because their duration is zero. Use calendar weeks for the window and task calendars for workday facts.

**Acceptance:** A task that started earlier and continues into the window appears; an unfinished overdue task appears; a zero-duration milestone on the boundary appears once; completed work is excluded by default; shifting the reference date updates the agenda.

**Scope discipline:** A future scheduled start is not evidence that work is ready to begin. Completion percentages alone cannot establish readiness for all FS/SS/FF/SF relationships, lags, and field constraints. Show dependencies and known blockers without asserting physical readiness.

**Success measure:** Preparation time for a weekly planning meeting and the proportion of reviewed near-term tasks with an assigned owner.

### 4. Cross-project milestone watchlist

**Value 4/5 · Complexity 2/5 · Ratio 2.00**

**Problem solved:** Users with several project tabs must open each one to identify threatened commitments.

**Competitor evidence:** Project's overview/timeline/reporting and master-project capabilities support summary visibility; Cloud manages schedules across programs. The proposed local watchlist is a deliberately smaller version of that visibility. [S5, S11, S16]

**First version:** A read-only page listing key milestones across the projects already open in the local workbook: project, milestone, owner, agreed date where present, expected date, variance, and reported completion. Filter to upcoming, overdue, or slipping commitments; click to open the correct project and task. Reuse Plan's existing starred/key milestones and offer “all milestones”.

**Why complexity is low:** Workbook tabs, milestone identity, dates, agreement calculations, key milestone selections, and computed project views already exist. No cross-project dependency engine is required.

**Implementation seam:** Reuse `Store.view()` and existing delay calculations, ensuring the watchlist is computed from current live projects even if a saved version is displayed in the editor. Distinguish no agreed date from on time. Show workday variance in each task's calendar, and avoid adding values from different calendars into an unexplained total. Keep source project visible on every row.

**Acceptance:** The same-named milestone in two projects stays distinct; clicking navigates correctly; edits/deletion update the page; no agreed date is displayed explicitly; reading the watchlist leaves active-project state unchanged.

**Scope discipline:** This is local workbook visibility. It does not imply live access to colleagues' schedules or a resource-constrained master schedule.

**Success measure:** Time to identify all threatened key milestones across the user's current workbook.

### 5. Saved baseline overlay in the main Gantt

**Value 4/5 · Complexity 2/5 · Ratio 2.00**

**Problem solved:** Baseline comparison currently requires opening Analysis, while planners often need to see agreement versus forecast during ordinary editing.

**Competitor evidence:** Project's Tracking Gantt displays baseline versus scheduled dates. P6 supports baseline comparison and customizable Gantt bars. [S1, S13]

**First version:** Select one saved version and toggle thin baseline ghost bars beneath current bars in the ordinary Gantt. Display finish variance on hover, identify the selected version, and distinguish tasks added after that version. Keep removed-task detail in Analysis initially.

**Why complexity is low:** Plan already matches stable task IDs and draws baseline ghost bars in Analysis. The new work is integrating that visual reference with the interactive Gantt, not creating baselines or comparison calculations.

**Implementation seam:** Use the selected version's frozen dates and stable IDs through `versionView()`/`facts()`. Main-Gantt rendering is separate from Analysis, so share data preparation and styling rather than assuming its renderer is directly interchangeable. Include baseline extents in Fit; handle collapsed/filtered rows and coexistence with slack and delay overlays. Persist the selection locally and handle deletion of the referenced version.

**Acceptance:** Zoom, pan, Fit, filtering, task moves, and summary collapse preserve alignment; changing the current calendar never recalculates frozen baseline dates; overlays do not intercept drag handles; no baseline selection silently changes agreed dates.

**Scope discipline:** A selected snapshot baseline and the current agreed deadline can differ after an approved revision. Label them separately. Baseline-to-current variance is not automatically contractual delay.

**Success measure:** Fewer switches into Analysis during ordinary plan review while preserving correct interpretation of agreement and variance.

### 6. Weekly status pack with concise PDF output

**Value 5/5 · Complexity 3/5 · Ratio 1.67**

**Problem solved:** Plan's detailed Analysis is useful for investigation but can be too much for a recurring sponsor/client update.

**Competitor evidence:** Project's built-in Project Overview combines phase progress, upcoming milestones, and overdue tasks; its reports can be customized and shared. [S16]

**First version:** A fixed-format executive summary with project/report date, forecast completion versus agreed completion, selected baseline movement, key milestone exceptions, critical/near-critical work, biggest changes, and the next two weeks. Add known blockers after #8. Provide a concise first PDF page with clearly linked or appended overflow detail. Before #10, label the timestamp as the report generation date and progress as current reported progress.

**Why complexity is moderate:** Plan already has metrics, comparison data, delay explanations, PDF tables, Excel output, and pagination. Defining consistent status semantics, useful selection rules, and readable output across dense schedules is the real work.

**Implementation seam:** Reuse `versiondiff.metrics()`, `compareViews()`, delay summaries, and the export primitives. A single report data object should drive the on-screen preview and exported document so the numbers agree. Use a fixed template first; a drag-and-drop report designer adds much more scope.

**Acceptance:** Screen/PDF figures match; new projects without baselines or agreed dates still produce a useful summary; long names and large exception lists paginate; the project, comparison version, and date basis are visible. No hidden cost/earned-value assumptions appear in the report.

**Success measure:** Time from completing the weekly update to producing the document actually used in the review meeting.

### 7. Owner overlap warnings and weekly heatmap

**Value 5/5 · Complexity 3/5 · Ratio 1.67**

**Problem solved:** A dependency-valid plan can allocate several simultaneous tasks to the same owner without making the potential conflict obvious.

**Competitor evidence:** Project's Resource Usage/Graph views show workloads and overallocations; Cloud offers resource/role histograms, usage sheets, and leveling. Those systems model work and capacity more fully than Plan. [S5, S14]

**First version:** For a bounded upcoming window, show owners by week with counts of concurrent unfinished tasks, and list the exact overlapping task/date pairs. Start within the active project; optionally include the current local workbook through the same view infrastructure as #4. Use email as a stronger identity key where supplied, with conservative name matching and visible ambiguity.

**Why complexity is moderate:** Owners and calendar-aware task intervals already exist. Identity reconciliation, overlap calculation, summaries, and clear presentation need careful work. Restrict the time window so very long supported task durations do not cause per-day scans across years.

**Implementation seam:** Exclude summary rows and completed tasks. Count overlaps only on days both tasks actually work; handle holidays and independent task calendars. Treat milestones as events rather than full-day workload. Progress percentage does not establish which future hours are still needed.

**Acceptance:** Different owners do not conflict; same-owner tasks with no shared working days do not conflict; summaries do not inflate the count; cross-project results label their source; clicking a heatmap cell reveals the underlying work.

**Scope discipline:** Label the result **possible owner conflicts**, not utilization or proven overallocation. Plan has no assignment effort, allocation percentage, available hours, part-time capacity, or crew size. Two parallel tasks can be perfectly reasonable. Automatic leveling belongs to a later resource-model project.

**Success measure:** Conflicts confirmed useful by planners and resolved before execution, alongside a false-positive/dismissal rate.

### 8. Task notes and forward-looking blocker tracking

**Value 5/5 · Complexity 3/5 · Ratio 1.67**

**Problem solved:** “Waiting for drawing approval” or “material not delivered” is needed before a date slips. A retrospective delay reason cannot fully serve as an active work blocker.

**Competitor evidence:** P6 has activity notebooks and steps; Project has task notes; Cloud has a constraints register covering issues/materials/deliverables with responsibility and resolution dates. [S1, S8, S15]

**First version:** A task details drawer with a plain-text note and one active blocker: reason, responsible person, needed-by date, open/resolved state. Show a badge in the grid and lookahead, and an open-blocker list. Allow references as ordinary text initially. Keep the task's schedule owner distinct from the person resolving its blocker.

**Why complexity is moderate:** UI entry is straightforward; durable fields must survive normalization, undo/redo, snapshots, copying, `.plan` portability, and appropriate exports. The current sanitizer reconstructs an explicit task object and would discard unrecognized fields. Implementing only a text box would be incomplete.

**Implementation seam:** Extend the task schema and validation deliberately, and define whether resolved blocker details remain as task context. Keep this distinct from delay log entries. Resolving a blocker should not silently mark the task complete or move agreed/forecast dates. A future link from a blocker to a recorded delay can reduce re-entry without conflating their meanings.

**Acceptance:** Note/blocker data survives refresh, save/open, snapshots, copy, undo/redo, and intended exports; readonly versions cannot be edited; script-like text is rendered safely as text; the blocker list excludes resolved items by default.

**Scope discipline:** Start with a single current blocker and plain notes. Multiple constraint records shared across tasks, attachments, threaded chat, checklists, and approval workflows are separate expansions.

**Success measure:** Upcoming blocked work identified before its planned start, and time to find the responsible person and required action.

### 9. Activity codes/tags for discipline, area, or contractor

**Value 4/5 · Complexity 3/5 · Ratio 1.33**

**Problem solved:** WBS hierarchy describes one breakdown of a project. Users also need to isolate every electrical task, all work in an area, or everything assigned to a contractor without rearranging that hierarchy.

**Competitor evidence:** P6 has activity codes; Cloud's work plan groups by activity/task codes and company; Project has task custom fields and filtering. [S1, S7, S11]

**First version:** A small project-scoped set of categorical fields, such as Discipline, Area, and Contractor, with controlled dropdown values. Use these in #1's saved filters and as columns in list reports. Keep category changes distinct from WBS movement. Start with filtering; arbitrary grouped Gantt layouts are a later UI feature.

**Why complexity is moderate:** The values themselves are simple. Definitions and assignments must survive files, snapshots, copies/templates, and imports/exports without losing meanings or IDs. Updates must not erase tasks using retired values.

**Implementation seam:** Reuse patterns from delay-cause IDs, rename/retire behavior, and file-local mappings, but keep activity codes as a separate concept. Wire the new fields into normalization, grid/details editing, version comparisons where appropriate, spreadsheet column mapping, and portable files. Avoid a generalized typed-field/formula engine in the first version.

**Acceptance:** Tasks retain code assignments after renaming a value, reopening a file, copying, and snapshot restoration; filtering by a code never changes hierarchy or dates; Excel round-trips preserve supported categories; absent old-file fields get safe defaults.

**Success measure:** Time to assemble a discipline/contractor/area work list and reduction in task-name conventions used to encode categories.

### 10. Reporting/status date and planned-versus-reported progress

**Value 4/5 · Complexity 3/5 · Ratio 1.33**

**Problem solved:** A Friday progress report prepared on Monday should have an explicit Friday reporting basis. The current UI's trend sparkline is a schematic curve based on the current schedule and today's date, not a saved-baseline progress history.

**Competitor evidence:** Project documents the status date and its effects on progress/remaining work; P6 separates planned, actual, and remaining durations with data-date-aware scheduling. [S4, S17]

**First version:** Save an explicit reporting/status date with a Status update snapshot. Display that line in the Gantt and report. For tasks with a selected baseline, show the duration-based planned fraction at close of the reporting date, the snapshot's reported percentage, and the difference in percentage points. Provide a table of “planned to have started/finished by this date” versus reported state. This is a dated reporting feature; forecast dates continue to follow the existing scheduling rules.

**Calculation:** For a normal baseline task, planned fraction is baseline working days elapsed through the chosen date divided by baseline duration, clamped to 0–100%. Use that task's baseline calendar and inclusive report-day cutoff. For a milestone, use a 0/100 step at its baseline date. Example: a five-working-day Monday–Friday task has 60% duration elapsed at close of Wednesday; 30% reported completion is 30 percentage points below that reference. This is only an indicative comparison if reported progress represents physical completion or nonuniform effort. Label the basis rather than implying earned value or measured productivity.

**Why complexity is moderate within this scope:** Calendars, percentages, and frozen snapshots already exist. Reporting-date persistence, snapshot metadata, file compatibility, and coherent date semantics are the additional work. Pair the date with the data captured for that update. Choosing an earlier date on the current live plan must not pretend to reconstruct historical progress.

**Implementation seam:** Add reporting-date metadata to status snapshots through `cleanVersions()` and `snapshotVersion()`, with matching project-file validation/encoding. Keep the snapshot capture timestamp separate from the user-declared reporting cutoff. Use `versionView()` for historical data and the baseline calendar helpers for planned fractions; do not read today's live percentage when rendering an older update. Add the status-date line alongside the existing Gantt date/overlay controls.

**Acceptance:** Historical reports use the selected saved status update; weekends/holidays and milestones are correct; missing baseline tasks are marked “No baseline”; changing only the report date moves the reference line/calculation but does not reschedule tasks; saved historical dates remain frozen.

**Scope discipline:** Actual start/finish, remaining duration, split work, out-of-sequence progress policies, and moving unfinished work past the status date form a larger engine project, rated complexity **4–5/5**. Do not describe this first version as P6-equivalent progress forecasting. The README explicitly places those behaviors outside the current release.

**Success measure:** Reproducibility of weekly reports and fewer date-basis corrections during review.

## Other candidates considered

These are valid capabilities, but have a weaker incremental value/complexity case under Plan's present scope.

| Candidate | Incremental value / 5 | Complexity / 5 | Ratio | Why it falls behind the ten above |
| --- | ---: | ---: | ---: | --- |
| Full actuals/remaining-duration forecasting | 5 | 4 | 1.25 | High long-term value; changes progress and scheduling semantics, including all relationship types, calendars, actual-date protection, manual modes, and delay attribution. Raise to 5 complexity for broad P6 parity. |
| Microsoft Project XML / P6 XER or XML exchange | 4 | 4 | 1.00 | Valuable where users exchange native schedules. Unsupported calendar, resource, actual, constraint, and time-unit semantics require a mapping/loss policy. Native `.mpp` is an additional binary-format problem. A bounded subset importer could be a separate discovery project. |
| General what-if scenario workspace | 3 | 3 | 1.00 | Cloud has strong scenario management [S9], but Plan already offers copies, versions, comparisons, calendar previews, and limited finish-impact previews. Full scenario lineage, cross-scenario comparison, and controlled promotion have less immediate incremental reach than the shortlist. |
| Qualitative risk register | 3 | 3 | 1.00 | Cloud supports probability/impact and response actions [S10]. Useful, but a general register adds another maintained dataset. Active blockers and schedule exceptions are more directly actionable for the assumed weekly workflow. Raise this if formal risk review is a customer requirement. |
| Kanban/sprint board | 3 | 3 | 1.00 | Planner supports sprints [S18]. A board can help some teams, but introduces another execution interaction model; the lookahead uses existing schedule structure more directly. |
| Expanded task-level change timeline | 3 | 3 | 1.00 | Plan already has snapshots, automatic save history, comparison logs, and explicit delay records. A unified per-task history is useful polish, but claiming complete actor-level auditability requires more event metadata. |
| Full costing/earned value | 4 | 5 | 0.80 | Requires costs, budgets, actuals, assignment units/rates, time phasing, and progress rules before meaningful financial indicators can be produced. Percent complete alone is insufficient. |
| Automatic resource leveling | 4 | 5 | 0.80 | Needs a capacity/work/assignment model and policies for priorities, splitting, calendars, and preservation of manual or agreed dates. Owner name overlap alone cannot support it. |
| General custom fields/formulas | 3 | 4 | 0.75 | A small category set addresses common needs sooner. General types, formulas, summary rollups, validation, editors, and interchange form a larger customization platform. |
| Multiuser sync, comments, permissions, cloud reminders | 3 | 5 | 0.60 | Adds server identity, synchronization/conflict handling, roles, delivery/authentication, and operations. The README deliberately excludes M365/cloud integration. Collaboration demand could change the product strategy, but it is not a low-complexity extension of the local app. |
| Cross-project dependency scheduling | 3 | 5 | 0.60 | Requires durable references, coordinated scheduling, missing-project behavior, cycles across projects, and portable export decisions. A local milestone watchlist captures visibility value earlier. |

Basic baselines, deadline/agreement dates, critical path, working calendars, task hierarchy, templates, and ordinary Excel/PDF export were excluded as *new* recommendations because Plan already supports them. Improvements to their visibility appear explicitly in the shortlist.

## Delivery order and dependencies

Rank is an opportunity ranking; delivery order should also account for reuse.

1. **Foundation:** #1 saved filters/search and #2 schedule checks. Create shared read-only query/derived-data helpers and a consistent way to jump to a task.
2. **Fast visible results:** #3 lookahead, #4 milestone watchlist, #5 main-Gantt baseline overlay. #3 depends on #1. #4 establishes local cross-project projections reusable by #7. #5 is largely independent.
3. **Operational context:** #8 notes/blockers, #9 activity codes, #7 owner overlap warnings. Add the new metadata coherently and reuse it in lookahead/views. Active-project owner overlap can ship before cross-project support.
4. **Reporting completion:** #10 dated status updates and #6 final weekly status pack. A basic #6 can ship earlier using existing data; completing it after #8/#10 produces a more useful report with known blockers and an explicit reporting basis.

Use one coherent portable-file migration for genuinely compatible new metadata if features land together; otherwise version them separately. Do not leave new information browser-only merely because the editor looks correct. `sanitize()`, serialization, snapshot restoration, templates/copies, project-file encoding/validation, and intended spreadsheet paths need explicit coverage. Pure view preferences can stay in app settings.

For view features, verify that hiding rows never changes the scheduled network. For durable fields, verify old files, undo/redo, snapshots, readonly behavior, and save/open round-trips. For calendar calculations, cover different workweeks, holidays, milestones, and completed work. Appropriate existing test families are listed in [the testing guide](testing.md); no new application test suite was necessary for this research-only change.

## Uncertainty and sensitivity

- The top three are tied, not objectively ordered by a measured 2.50 ROI. #1 comes first because it enables #3 and makes #2's findings more useful. A team reviewing imported schedules might reasonably build #2 first.
- If implementation discovery raises a complexity-2 item to 3, a value-5 item drops from 2.50 to 1.67; a value-4 item drops from 2.00 to 1.33. Prototype hierarchy/filter/connector interaction before promising the first rating.
- If notes/blockers have value 4 rather than 5 for the target users, #8 moves into the final tied group. The first five remain unaffected.
- If users manage only one project, the watchlist's value falls and its slot should be reconsidered; a simple qualitative risk list could take its place for risk-heavy users.
- If native client/contractor schedule exchange is a purchasing requirement, XML/XER interoperability becomes a strategic priority despite its higher complexity. If time-now forecasting is central, full actuals moves up for the same reason. These are decisions about product scope, not evidence that the work is cheap.
- No shortlist item adds measured earned value, crew capacity, contractual claim validity, or real-time collaboration merely by presenting a familiar enterprise-style screen.

Validate the first release with representative weekly-review tasks: finding an owner's upcoming work, identifying weak schedule logic, locating threatened milestones, and producing a useful review document. Measure the current workflow first, then compare; no unsupported percentage time-saving claims are assumed here.

## Primary sources

The numbered sources support product capability claims. Proposed Plan scopes, value scores, complexity scores, implementation recommendations, and success measures are this review's judgments.

- **S1 — Oracle P6 Professional 26: Activities Window.** Activity codes, filters/layouts, steps/notebooks, baseline comparison, actuals, resources, risks. https://docs.oracle.com/en/industries/construction-engineering/primavera-p6-professional/26/pro-help/activities_window.html
- **S2 — Oracle P6 Professional 26: Create a lookahead filter.** Relative-date six-week lookahead and hide/highlight options. https://docs.oracle.com/en/industries/construction-engineering/primavera-p6-professional/26/pro-help/createalookaheadfilter-19669a.html
- **S3 — Oracle P6 Professional 26: Check a schedule.** Check report, failed-test filters, and configurable long-lag/float/duration thresholds. https://docs.oracle.com/en/industries/construction-engineering/primavera-p6-professional/26/pro-help/checkaschedule-101251a.html
- **S4 — Oracle P6 Professional 26: Status tab, Activity Details.** Planned/actual/remaining duration, actual dates, completion types, constraints, units/costs. https://docs.oracle.com/en/industries/construction-engineering/primavera-p6-professional/26/pro-help/status_tab_-_activity_details.html
- **S5 — Oracle Primavera Cloud: Schedule Overview.** CPM, baselines, scenarios, resources/roles, leveling, schedule health, program scheduling, version comparison. https://docs.oracle.com/cd/E80480_01/English/user_guides/schedule_management_user_guide/90786.htm
- **S6 — Oracle Primavera Cloud: Schedule Health Score Reference.** Individual health checks and score calculation. https://docs.oracle.com/cd/E80480_01/help/en/user/149231.htm
- **S7 — Oracle Primavera Cloud: Work Plan Overview.** Daily/weekly board, task grouping, planning periods, commitments. https://docs.oracle.com/cd/E80480_01/English/user_guides/task_management_user_guide/101909.htm
- **S8 — Oracle Primavera Cloud: Constraints Overview.** Execution blockers, responsibility, needed/promised/resolved dates, linked tasks. https://docs.oracle.com/cd/E80480_01/English/user_guides/task_management_user_guide/221625.htm
- **S9 — Oracle Primavera Cloud: Schedule Scenarios Overview.** Isolated what-if schedules, sources, and promotion to current schedule. https://docs.oracle.com/cd/E80480_01/English/user_guides/schedule_management_user_guide/107323.htm
- **S10 — Oracle Primavera Cloud: Risk Scoring Overview.** Qualitative probability/impact assessment and response actions. https://docs.oracle.com/cd/E80480_01/English/user_guides/risk_management_user_guide/186843.htm
- **S11 — Microsoft Learn: Project desktop client service description.** Feature matrix covering scheduling, resources, reports, filtered views, custom fields, and import/export. https://learn.microsoft.com/en-us/office365/servicedescriptions/project-online-service-description/project-online-desktop-client-service-description
- **S12 — Microsoft Support: Filter tasks or resources.** Predefined/custom filters, AutoFilters, and highlighting. https://support.microsoft.com/en-us/project/filter-tasks-or-resources
- **S13 — Microsoft Support: Create or update a baseline or an interim plan in Project desktop.** Baseline storage, variance tables, and Tracking Gantt. https://support.microsoft.com/en-us/project/create-or-update-a-baseline-or-an-interim-plan-in-project-desktop
- **S14 — Microsoft Support: View resource workloads and availability in Project desktop.** Resource Usage/Graph views, capacity/units, and overallocation. Desktop sections used; legacy Project Online sections are not a current cloud recommendation. https://support.microsoft.com/en-us/project/view-resource-workloads-and-availability-in-project-desktop
- **S15 — Microsoft Support: Add notes to a task or to the project schedule.** Task/resource/assignment/project notes. https://support.microsoft.com/en-us/project/add-notes-to-a-task-or-to-the-project-schedule
- **S16 — Microsoft Support: Create a Project report.** Project Overview, upcoming milestones, overdue tasks, report customization/sharing. https://support.microsoft.com/en-us/project/create-a-project-report
- **S17 — Microsoft Support: Set the status date for project reporting.** Reporting cutoff, Gantt line, actual/remaining work behavior. https://support.microsoft.com/en-us/project/set-the-status-date-for-project-reporting
- **S18 — Microsoft Support: Advanced capabilities with premium plans in Planner.** People view, task history, timeline/dependencies/critical path, custom fields, sprints. https://support.microsoft.com/en-us/planner/teams/advanced-capabilities-with-premium-plans-in-planner
- **S19 — Microsoft Learn: Prepare for Project Online retirement.** Retirement date and distinction from standalone desktop Project. https://learn.microsoft.com/en-us/planner/prepare-for-project-online-retirement
