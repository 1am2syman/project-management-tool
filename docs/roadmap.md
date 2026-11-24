# Plan product roadmap

Status: Proposed backlog. All implementation and acceptance checkboxes below are open.

Prepared: 20 November 2026.

Research basis: [Feature priorities and competitor research](feature-priorities.md), comparing Oracle Primavera P6 Professional, Oracle Primavera Cloud, Microsoft Project desktop, and relevant current Microsoft Planner capabilities. That document preserves the app inventory, rationale, alternatives, and 19 primary vendor sources. Source IDs below refer to its [primary source list](feature-priorities.md#primary-sources).

## 1. Product objective

Make Plan more useful for recurring planning, coordination, and progress reviews by helping users find relevant work, identify unreliable schedule logic, see upcoming commitments, resolve blockers, and produce clear updates.

Build on the existing scheduling foundation: WBS hierarchy, all four relationship types with lag, automatic/manual/date-anchor scheduling, task calendars, critical path, total/free slack, agreed deadlines, delay accounting, snapshots, version comparison, and Excel/PDF exports.

The near-term roadmap preserves Plan's local, offline-capable operating model. Its primary audience is project managers and planners maintaining dependency-based schedules. Value ratings assume recurring weekly reviews; customer demand and time savings still need validation.

## 2. Prioritization and tracking

### Rating scale

- **Value, 1–5:** Higher means greater expected incremental benefit. A 5 supports a core recurring workflow; a 4 is a strong recurring improvement; a 3 serves a narrower workflow.
- **Complexity, 1–5:** Lower means easier. A 1 is isolated work; 2 is a low-complexity extension of existing data; 3 touches multiple modules or persisted metadata; 4 changes major scheduling/interchange behavior; 5 requires substantial infrastructure or a new domain model.
- **Priority score:** Value divided by complexity, rounded to two decimal places. Scores are judgment-based triage aids, not financial ROI or delivery estimates.
- **Ties:** Favor recurring use, foundational reuse, and lower uncertainty. The first three items are comparable opportunities; filters lead because they enable lookahead and help users act on findings.

Complexity assumes each item's first-release boundary and reuse of earlier foundations. Calendar dates and engineering estimates should be assigned after implementation discovery. Ranking and implementation sequence differ where dependencies make that useful.

### Ranked backlog

| Rank | ID | Feature | Value / 5 | Complexity / 5 | Priority score | Delivery phase | Status |
| --- | --- | --- | ---: | ---: | ---: | --- | --- |
| 1 | RM-01 | Search, saved filters, and named task views | 5 | 2 | 2.50 | A | Proposed |
| 2 | RM-02 | Actionable schedule health checks | 5 | 2 | 2.50 | A | Proposed |
| 3 | RM-03 | Rolling 2/4/6-week lookahead | 5 | 2 | 2.50 | B | Proposed |
| 4 | RM-04 | Cross-project milestone watchlist | 4 | 2 | 2.00 | B | Proposed |
| 5 | RM-05 | Saved baseline overlay in the main Gantt | 4 | 2 | 2.00 | B | Proposed |
| 6 | RM-06 | Weekly status pack with concise PDF output | 5 | 3 | 1.67 | D; basic template can ship earlier | Proposed |
| 7 | RM-07 | Owner overlap warnings and weekly heatmap | 5 | 3 | 1.67 | C | Proposed |
| 8 | RM-08 | Task notes and forward-looking blockers | 5 | 3 | 1.67 | C | Proposed |
| 9 | RM-09 | Activity codes for discipline, area, or contractor | 4 | 3 | 1.33 | C | Proposed |
| 10 | RM-10 | Reporting/status date and planned-versus-reported progress | 4 | 3 | 1.33 | D | Proposed |

Suggested lifecycle: Proposed → Ready → In progress → Verified → Released. Assign an owner, estimate, and target release when an item becomes Ready. Mark implementation and acceptance separately; a completed UI alone does not mean the feature is verified.

## 3. Delivery phases

### Phase A — Find work and check the schedule

Items: **RM-01, RM-02**.

- [ ] Establish shared read-only task selection and task-navigation helpers.
- [ ] Deliver saved task views and explainable schedule findings.
- [ ] Verify that presentation changes leave scheduling calculations unchanged.
- [ ] Record a baseline for time spent locating task subsets and reviewing schedule issues.

Exit outcome: A planner can isolate relevant work and find actionable schedule problems without scanning every row.

### Phase B — Prepare the weekly planning review

Items: **RM-03, RM-04, RM-05**.

- [ ] Reuse saved-filter infrastructure for lookahead windows.
- [ ] Add a local workbook milestone watchlist with task navigation.
- [ ] Add a selected saved baseline to the editable Gantt.
- [ ] Review the combined workflow on schedules with hierarchy, milestones, and different task calendars.

Exit outcome: A planner can prepare the upcoming work agenda and review threatened commitments with a visible baseline reference.

### Phase C — Add operational context

Suggested sequence: **RM-08, RM-09, RM-07**. Owner overlap can be delivered independently if that is the most urgent need.

- [ ] Agree a coherent schema and portable-file migration for task context and categorical metadata.
- [ ] Add task notes/blockers and make them visible in saved views and lookahead.
- [ ] Add activity codes and corresponding filter/import/export support.
- [ ] Add calendar-aware possible owner conflicts, starting within one project.
- [ ] Extend overlap analysis across local projects if that scope is justified.

Exit outcome: Users can identify the work, the relevant discipline/area/contractor, the person resolving a blocker, and potential competing demands on owners.

### Phase D — Make progress reporting reproducible

Suggested sequence: **RM-10, then the complete RM-06**.

- [ ] Pair status snapshots with an explicit reporting date.
- [ ] Add baseline planned-versus-reported progress with clear calculation labels.
- [ ] Build the final weekly status pack from the same data used in its preview.
- [ ] Include blocker and date-basis information when those inputs are available.
- [ ] Verify a historical update can be reproduced after the live plan changes.

Exit outcome: A weekly update has a clear reporting basis and produces a concise document suitable for the review meeting.

A basic RM-06 template can ship after Phase B using existing metrics. Its final integration with blockers and dated updates follows RM-08/RM-10.

## 4. Detailed work items

### RM-01 — Search, saved filters, and named task views

**Priority:** 1. **Value:** 5/5. **Complexity:** 2/5. **Score:** 2.50. **Phase:** A.

**Outcome:** A user can quickly answer questions such as “Which unfinished tasks belong to Alex?” or “What work is close to becoming critical?”

**Dependencies:** None. Enables RM-03 and the filter integration for RM-09; improves navigation from RM-02.

**Competitor basis:** P6 activity filters/layouts and Project predefined/custom filters and highlighting. Sources S1 and S12.

**Implementation checklist**

- [ ] Define supported criteria: task/owner search, owner, completion state, date range, milestone, criticality, near-critical threshold, violated relationships, and agreed-date variance.
- [ ] Define unfinished forecast-overdue and agreed-deadline-overdue as separate predicates.
- [ ] Implement a shared projection for the sheet, Gantt, keyboard navigation, selection, and Fit.
- [ ] Preserve WBS order and ancestor context; distinguish contextual parent rows from matching rows.
- [ ] Provide a way to reveal matches inside collapsed groups.
- [ ] Show active filter criteria, match count, empty state, and a clear-all action.
- [ ] Save named views with criteria, visible columns, and zoom in local app settings.
- [ ] Provide initial views such as My unfinished work, Unassigned, Overdue forecast finish, and Near critical. Let users choose the owner for a personal view; no sign-in is required.
- [ ] Handle hidden relationship endpoints explicitly so connectors do not imply a different dependency.

**Acceptance checklist**

- [ ] The grid and Gantt display the same projected task rows.
- [ ] Keyboard navigation and selection never land on a hidden row.
- [ ] Filtering and clearing filters leave task IDs, dates, links, criticality, and float calculations unchanged.
- [ ] Named views and their selected settings survive reload.
- [ ] Collapsed ancestors and empty results have predictable behavior.

**Implementation areas:** `model.js` derived rows, `grid.js`, `gantt.js`, `main.js`, and `appstate.js`. Keep the full scheduling network separate from presentation rows.

**First-release boundary:** A small set of AND-combined criteria. Arbitrary formulas, nested Boolean logic, free sorting, and grouped Gantt layouts are later work.

**Success measure:** Time and interactions required to locate a specified task subset in a representative schedule.

### RM-02 — Actionable schedule health checks

**Priority:** 2. **Value:** 5/5. **Complexity:** 2/5. **Score:** 2.50. **Phase:** A.

**Outcome:** A user can identify weak or inconsistent schedule logic and navigate directly to the affected work.

**Dependencies:** None for the checker. RM-01 improves finding/highlighting affected tasks.

**Competitor basis:** P6 Check Schedule and Primavera Cloud Schedule Health Score. Sources S3 and S6.

**Implementation checklist**

- [ ] Implement a pure checker over the complete project view, separate from runtime diagnostic logging.
- [ ] Add checks for violated links, missing predecessors/successors, unusually long tasks, large/negative float, unassigned work, and manual-date dependency conflicts.
- [ ] Add review findings for long lags and negative lags with configurable thresholds.
- [ ] Explain each rule, list affected tasks, show severity/counts, and provide jump-to-task actions.
- [ ] Allow legitimate project start/end activities to be acknowledged or exempted, with invalidated acknowledgments reconsidered when relevant inputs change.
- [ ] Use project-completion float for project-wide checks, independently of the editor's selected milestone target.
- [ ] Mark checks needing unavailable actual-date/progress data as unavailable.
- [ ] Persist local checking preferences and acknowledgments with an explicit project/task association.

**Acceptance checklist**

- [ ] Seeded schedule problems produce the expected named findings.
- [ ] Legitimate boundary activities can be acknowledged without suppressing unrelated problems.
- [ ] Summaries do not double-count leaf findings.
- [ ] Changing thresholds or the schedule updates findings predictably.
- [ ] Checking the schedule does not alter dates or relationships.
- [ ] Unrelated tasks outside a selected milestone's float scope are not treated as defective solely because their total float is unavailable.

**Implementation areas:** Existing incoming/outgoing links, task calendars, durations, float, and relationship violations in `model.js`; a separate pure checker and findings UI.

**First-release boundary:** Explainable findings and counts. No claim of DCMA certification, universal quality thresholds, actual-date validation without actuals, or automatic rejection of valid relationship types.

**Success measure:** Useful findings corrected before agreement and the proportion dismissed as irrelevant.

### RM-03 — Rolling 2/4/6-week lookahead

**Priority:** 3. **Value:** 5/5. **Complexity:** 2/5. **Score:** 2.50. **Phase:** B.

**Outcome:** A user can open a short work agenda suitable for a weekly coordination meeting.

**Dependencies:** RM-01. RM-08 later supplies blocker badges.

**Competitor basis:** P6 relative-date lookahead filters and Primavera Cloud daily/weekly Work Plan. Sources S2 and S7.

**Implementation checklist**

- [ ] Add 2-, 4-, and 6-week presets with an explicit reference-date control.
- [ ] Include unfinished tasks whose scheduled intervals overlap the selected window.
- [ ] Include unfinished overdue tasks in a separate section even when their scheduled finish predates the window.
- [ ] Include milestones using point-date rules and clearly defined window boundaries.
- [ ] Present ongoing work, upcoming starts, finishes, and milestones in readable sections.
- [ ] Show owner, dates, progress, critical/near-critical status, and task navigation.
- [ ] Add a printable list using the same task selection as the screen.
- [ ] Show known blocker badges after RM-08 without making them a prerequisite for the initial release.

**Acceptance checklist**

- [ ] A task starting before the window and continuing into it appears.
- [ ] An unfinished overdue task appears even if its scheduled interval is entirely in the past.
- [ ] Milestones on a defined boundary are included consistently and without duplicate entries in the milestone list.
- [ ] Completed tasks are excluded by default.
- [ ] Moving the reference date updates the agenda without changing scheduled dates.

**Implementation areas:** RM-01 projection helpers, calendar-aware model facts, and existing list/export primitives. Use calendar weeks for the window and effective task calendars for working-day facts.

**First-release boundary:** Scheduled agenda and known blockers. Do not infer physical readiness from dates or percent complete alone.

**Success measure:** Preparation time for the weekly meeting and owner coverage of near-term work.

### RM-04 — Cross-project milestone watchlist

**Priority:** 4. **Value:** 4/5. **Complexity:** 2/5. **Score:** 2.00. **Phase:** B.

**Outcome:** A user can identify threatened key milestones across the projects already open in the local workbook.

**Dependencies:** None. Establishes project projections/navigation reusable by cross-project RM-07.

**Competitor basis:** Cloud program schedule visibility and Project overview/master-project capabilities. Sources S5, S11, and S16.

**Implementation checklist**

- [ ] Build a read-only projection of current live projects without changing the active editor state.
- [ ] Reuse existing starred/key milestones and provide an all-milestones option.
- [ ] Display project, milestone, owner, agreed date, expected date, variance, and reported completion.
- [ ] Add upcoming, overdue, and slipping filters.
- [ ] Label missing agreed dates explicitly.
- [ ] Keep project identity visible and use project plus task ID as the navigation key.
- [ ] Refresh after relevant project edits, deletions, and workbook changes.
- [ ] Navigate directly to the correct project/task from a watchlist row.

**Acceptance checklist**

- [ ] Same-named milestones in different projects remain distinct.
- [ ] Reading the watchlist leaves the current project's selection, displayed version, and data unchanged.
- [ ] Edits and deletions update the watchlist without stale rows.
- [ ] Missing agreement is not displayed as on time.
- [ ] Workday variance uses the appropriate task calendar and is not combined into an unexplained cross-calendar total.

**Implementation areas:** `Store.view()`, existing delay calculations, saved key-milestone selections, and project/tab navigation.

**First-release boundary:** Local workbook visibility. Cross-project scheduling dependencies and live access to colleagues' projects are later capabilities.

**Success measure:** Time to locate all threatened key milestones in a multi-project workbook.

### RM-05 — Saved baseline overlay in the main Gantt

**Priority:** 5. **Value:** 4/5. **Complexity:** 2/5. **Score:** 2.00. **Phase:** B.

**Outcome:** A user can see baseline-to-current date movement while editing the ordinary Gantt.

**Dependencies:** None. Must integrate with RM-01 when filtering is available.

**Competitor basis:** Project Tracking Gantt and P6 baseline/Gantt comparison. Sources S1 and S13.

**Implementation checklist**

- [ ] Add a saved-version selector and baseline overlay toggle.
- [ ] Match tasks by stable ID and use the selected version's frozen dates.
- [ ] Draw thin ghost bars below current task bars and identify the selected version clearly.
- [ ] Display finish variance in hover/details and identify tasks added after the baseline.
- [ ] Include baseline extents in Fit and handle milestones, summaries, filtering, and collapse.
- [ ] Keep baseline graphics clear alongside slack and delay overlays.
- [ ] Persist local selection and handle a deleted baseline version gracefully.
- [ ] Share comparison facts/style where useful while keeping main-Gantt interaction behavior intact.

**Acceptance checklist**

- [ ] Zoom, pan, Fit, and row collapse preserve alignment.
- [ ] Current-calendar changes do not recalculate frozen baseline dates.
- [ ] Ghost bars do not intercept drag handles or alter task editing.
- [ ] Filtering uses the same rows for current and baseline graphics.
- [ ] The chosen snapshot and current agreed deadline are labelled separately.

**Implementation areas:** `versionView()`, `versiondiff.js` facts, baseline rendering conventions in Analysis, and `gantt.js` layout/overlays.

**First-release boundary:** One selected baseline; removed-task detail remains in Analysis. Snapshot variance must not be presented automatically as contractual delay.

**Success measure:** Fewer switches into Analysis during ordinary plan review.

### RM-06 — Weekly status pack with concise PDF output

**Priority:** 6. **Value:** 5/5. **Complexity:** 3/5. **Score:** 1.67. **Phase:** D, with an optional earlier basic release.

**Outcome:** A user can produce a concise sponsor/client update from the plan without rebuilding it manually.

**Dependencies:** Existing metrics and exports support the basic template. RM-03/RM-04 improve upcoming-work and milestone selection; RM-08 and RM-10 are needed for the complete blocker-aware, dated reporting scope.

**Competitor basis:** Microsoft Project Overview and customizable reporting. Source S16.

**Implementation checklist**

- [ ] Define one report data object shared by preview and PDF.
- [ ] Include project identity, generation timestamp, comparison version, and reporting basis.
- [ ] Show forecast versus agreed completion and movement from the selected baseline/previous update.
- [ ] Summarize key milestone exceptions, critical/near-critical work, biggest changes, and the next two weeks.
- [ ] Add known blockers after RM-08.
- [ ] Use the captured status update/reporting date after RM-10.
- [ ] Provide a concise first page with readable overflow details and clear limits on top-item lists.
- [ ] Handle missing baselines, absent agreement dates, empty plans, long task names, and dense schedules.
- [ ] Reuse existing PDF pagination and export primitives.

**Acceptance checklist**

- [ ] Preview and PDF show matching figures and the same data basis.
- [ ] A project without saved versions or agreed dates still yields a useful report with explicit missing-reference labels.
- [ ] Dense output paginates without clipping names or losing required context.
- [ ] Known blockers and dated progress match their source records.
- [ ] Early versions label generation date/current reported progress accurately rather than implying historical status data.

**Implementation areas:** `versiondiff.metrics()`, `compareViews()`, delay summaries, `analysisexport.js`, and PDF primitives.

**First-release boundary:** A fixed template with selected content. Custom report design, costing, and earned value are separate projects.

**Success measure:** Time from completing the plan update to producing the document used in the review meeting.

### RM-07 — Owner overlap warnings and weekly heatmap

**Priority:** 7. **Value:** 5/5. **Complexity:** 3/5. **Score:** 1.67. **Phase:** C.

**Outcome:** A user can review possible competing demands on the same owner before execution.

**Dependencies:** None for the active-project view. RM-04 project projections/navigation support optional local workbook analysis.

**Competitor basis:** Project workload views and Cloud resource/role usage views. Sources S5 and S14.

**Implementation checklist**

- [ ] Define a bounded upcoming analysis period so long task durations do not trigger unbounded day-by-day scans.
- [ ] Match owners by email when available and use conservative name matching with visible ambiguity.
- [ ] Detect shared working days between unfinished same-owner tasks using both tasks' effective calendars.
- [ ] Exclude summary rows and completed tasks; treat milestones as events rather than full-day workload.
- [ ] Display owner-by-week counts and the underlying overlapping tasks/dates.
- [ ] Label findings as possible owner conflicts and make each finding navigable.
- [ ] Start within the active project, then optionally include selected projects from the local workbook.
- [ ] Include the source project on cross-project results.

**Acceptance checklist**

- [ ] Different owners are not combined accidentally.
- [ ] Tasks with no common working days do not produce a conflict.
- [ ] Summaries, holidays, completed work, and milestones do not inflate the count.
- [ ] Each heatmap result can be traced to the underlying tasks and dates.
- [ ] Long schedules remain responsive within the bounded window.

**Implementation areas:** Task owners/emails, `people.js` identity conventions, task calendars, project projections, and a pure overlap calculator.

**First-release boundary:** Possible concurrency conflicts. No utilization percentages, proved overallocation, capacity availability, or automatic leveling without an effort/assignment/capacity model.

**Success measure:** Confirmed useful conflicts resolved before execution and the rate of dismissed findings.

### RM-08 — Task notes and forward-looking blockers

**Priority:** 8. **Value:** 5/5. **Complexity:** 3/5. **Score:** 1.67. **Phase:** C.

**Outcome:** A user can capture what is preventing upcoming work and who must resolve it before dates slip.

**Dependencies:** No functional prerequisite. Requires the shared metadata/portability decisions in section 5. Enhances RM-03 and RM-06.

**Competitor basis:** P6 notebooks, Project notes, and Cloud task constraints. Sources S1, S8, and S15.

**Implementation checklist**

- [ ] Define a bounded plain-text task note and one active blocker per task.
- [ ] Capture blocker reason, responsible person, needed-by date, and open/resolved state.
- [ ] Keep the blocker resolver distinct from the task's schedule owner.
- [ ] Add a task details drawer, a visible blocker badge, and an open-blocker list.
- [ ] Connect blocker visibility to lookahead and status reporting as those features are available.
- [ ] Define resolved-blocker retention before implementation; retain enough context to avoid ambiguous reopening or replacement.
- [ ] Extend task normalization, serialization, undo/redo, snapshots, restore, copies/templates, and portable file validation.
- [ ] Include notes/blockers in intended exports and show unsupported spreadsheet round-trip limitations explicitly.
- [ ] Render notes and blocker text safely as text.

**Acceptance checklist**

- [ ] Data survives refresh, save/open, snapshots, copies, and undo/redo.
- [ ] Saved-version views remain read-only.
- [ ] Resolving a blocker does not silently mark work complete or change agreed/forecast dates.
- [ ] Open-blocker lists exclude resolved blockers by default.
- [ ] Script-like input is displayed safely.

**Implementation areas:** Task schema and `sanitize()`, details UI, `projectfiles.js`, snapshots/copies, and export mappings. Existing delay-log notes remain distinct.

**First-release boundary:** One active blocker and plain notes. Attachments, threaded comments, checklists, multiple shared constraints, and approvals are deferred.

**Success measure:** Blocked upcoming work identified before planned start and time to locate its resolver/action.

### RM-09 — Activity codes for discipline, area, or contractor

**Priority:** 9. **Value:** 4/5. **Complexity:** 3/5. **Score:** 1.33. **Phase:** C.

**Outcome:** A user can select work by a business category independently of its position in the WBS.

**Dependencies:** RM-01 for saved-view filtering. Requires shared metadata/portability decisions in section 5.

**Competitor basis:** P6 activity codes, Cloud code-based work grouping, and Project custom fields. Sources S1, S7, and S11.

**Implementation checklist**

- [ ] Define a small project-scoped set of categorical fields, initially Discipline, Area, and Contractor.
- [ ] Add controlled dropdown values with stable IDs, rename behavior, and safe retirement of in-use values.
- [ ] Add task editing and optional columns without changing hierarchy.
- [ ] Integrate code criteria into saved filters and list report columns.
- [ ] Preserve definitions/assignments across snapshots, restore, copies, templates, and `.plan` files.
- [ ] Define file-local mapping when opening projects and prevent accidental cross-project ID collisions.
- [ ] Extend supported spreadsheet import/export mappings for code round-trips.
- [ ] Include relevant code changes in version comparison.

**Acceptance checklist**

- [ ] Renaming a category value preserves existing assignments.
- [ ] Retired values remain intelligible on tasks and saved versions that use them.
- [ ] Saving/opening, snapshots, copies, and supported Excel round-trips preserve categories.
- [ ] Filtering by a code does not move WBS rows or alter scheduling calculations.
- [ ] Older files without code metadata receive safe empty defaults.

**Implementation areas:** Task/project schemas, normalization, details/grid UI, RM-01 predicates, project-file validation, imports/exports, and version facts. Delay-cause mapping offers a reusable pattern, but codes form a separate domain.

**First-release boundary:** Categorical fields and filtering. General field types, formulas, rollups, and arbitrary grouped Gantt layouts are deferred.

**Success measure:** Time to produce a discipline/area/contractor work list and reduced reliance on encoded task-name conventions.

### RM-10 — Reporting/status date and planned-versus-reported progress

**Priority:** 10. **Value:** 4/5. **Complexity:** 3/5. **Score:** 1.33. **Phase:** D.

**Outcome:** A user can reproduce a progress update with an explicit reporting cutoff even when it was prepared later.

**Dependencies:** Existing snapshots, calendars, and progress fields. The selected baseline is required for planned-progress comparison; absent baseline data must be explicit. Enables complete dated reporting in RM-06.

**Competitor basis:** Project status-date reporting and P6 planned/actual/remaining distinctions. Sources S4 and S17.

**Implementation checklist**

- [ ] Store a user-declared reporting date on a Status update snapshot, separately from its capture timestamp.
- [ ] Extend version normalization, snapshot creation, file validation/encoding, and historical view metadata.
- [ ] Add a reporting-date line to the Gantt with a visible label.
- [ ] Calculate baseline duration-based planned progress through close of the chosen reporting date using the baseline task calendar.
- [ ] Compare that reference with the saved status snapshot's reported percentage, using percentage-point differences.
- [ ] Handle milestones as a 0/100 step at the baseline date and missing tasks as No baseline.
- [ ] Add planned-to-have-started/finished versus reported-state lists.
- [ ] Make report preview/export use the saved update's progress rather than today's live task percentages.
- [ ] Explain the calculation basis and avoid presenting elapsed duration as measured physical productivity or earned value.

**Calculation example:** For a five-working-day Monday–Friday task, close of Wednesday is 60% of planned duration. Reported completion of 30% is 30 percentage points below that reference. Physical progress and effort may be nonuniform, so this is an indicative comparison with an explicit basis.

**Acceptance checklist**

- [ ] Historical reports remain reproducible after live progress changes.
- [ ] Weekends, holidays, independent task calendars, and milestones use the documented cutoff convention.
- [ ] Capture timestamp and reporting date remain distinct through save/open.
- [ ] Changing the reporting reference does not reschedule tasks or rewrite frozen historical dates.
- [ ] Picking a past date on the live plan does not imply that historical progress has been reconstructed.

**Implementation areas:** `cleanVersions()`, `snapshotVersion()`, `versionView()`, calendar helpers, project-file version metadata, Gantt overlays, and RM-06 report data.

**First-release boundary:** Dated reporting. Actual start/finish, remaining duration, split work, out-of-sequence progress policies, and automatic movement of unfinished work past the status date require a separate complexity 4–5 scheduling project.

**Success measure:** Reproducibility of weekly updates and fewer reporting-date corrections during review.

## 5. Shared engineering and release checklist

### Presentation and scheduling

- [ ] Keep view/filter state outside the full scheduling network.
- [ ] Use the same visible-row projection for the sheet, Gantt, navigation, and Fit.
- [ ] Keep leaf versus summary calculations explicit to prevent double-counting.
- [ ] Preserve existing auto/manual/date-anchor rules, all four relationship types, lags, critical-path methods, and task-calendar behavior.
- [ ] Use stable project/task/version IDs for references and recover gracefully when a referenced item is deleted.

### Persistence and portability

- [ ] Distinguish local view preferences from portable task/project metadata.
- [ ] Define new fields' bounds, defaults, validation, and compatibility behavior before building editors.
- [ ] Update normalization and serialization together so new fields are not silently discarded.
- [ ] Cover undo/redo, saved versions, restore, readonly views, duplicate/copy, and templates.
- [ ] Update `.plan` format handling and reject unsupported files clearly where necessary.
- [ ] Preserve old-file readability and document intentional export limitations.
- [ ] Update Excel/CSV mappings only where the format is intended to carry the new fields; verify those supported round-trips.
- [ ] Combine compatible metadata migrations when delivered together; otherwise version them separately.

### Verification and documentation

- [ ] Select relevant existing tests from [the testing guide](testing.md) and add focused checks for new semantics.
- [ ] Verify presentation-only features leave schedule results unchanged.
- [ ] Verify new durable metadata through save/open, snapshots, copying, and undo/redo.
- [ ] Cover different workweeks, holidays, task overrides, milestones, completed tasks, empty projects, and selected milestone targets where relevant.
- [ ] Verify keyboard operation, readable labels, empty states, readonly behavior, and dense schedules.
- [ ] Use isolated app state for browser checks and leave user databases intact.
- [ ] Keep any file-dialog validation consistent with the repository's actual OS-chooser requirements.
- [ ] Check report preview/export consistency and PDF overflow.
- [ ] Update usage documentation and relevant format/testing documentation before release.
- [ ] Record validation evidence and known limits before marking a feature Verified.

## 6. Deferred discovery backlog

These items remain candidates rather than commitments. Revisit them when customer requirements justify their broader scope.

| ID | Candidate | Value / 5 | Complexity / 5 | Score | Revisit trigger |
| --- | --- | ---: | ---: | ---: | --- |
| FUT-01 | Full actuals and remaining-duration forecasting | 5 | 4–5 | 1.25 at complexity 4 | Reliable time-now forecasting becomes a central requirement. |
| FUT-02 | Project XML / P6 XER or XML interchange | 4 | 4 | 1.00 | Client/contractor native schedule exchange is required for adoption. |
| FUT-03 | General what-if scenario workspace | 3 | 3 | 1.00 | Copies, snapshots, comparisons, and existing previews cannot support recovery planning. |
| FUT-04 | Qualitative risk register | 3 | 3 | 1.00 | Formal probability/impact and response reviews are requested. |
| FUT-05 | Kanban or sprint planning | 3 | 3 | 1.00 | Target users need a distinct board/backlog execution workflow. |
| FUT-06 | Unified task-level change timeline | 3 | 3 | 1.00 | Existing history and comparison tools cannot answer recurring task-change questions. |
| FUT-07 | Costing and earned value | 4 | 5 | 0.80 | Budgets, rates, actual work/cost, and defensible progress rules are available. |
| FUT-08 | Automatic resource leveling | 4 | 5 | 0.80 | A real effort, assignment, availability, and capacity model exists. |
| FUT-09 | General custom fields and formulas | 3 | 4 | 0.75 | Bounded categorical codes cannot express repeated customer needs. |
| FUT-10 | Multiuser sync, permissions, comments, and cloud reminders | 3 | 5 | 0.60 | Product strategy explicitly expands beyond the local/offline model. |
| FUT-11 | Cross-project dependency scheduling | 3 | 5 | 0.60 | Visibility alone is insufficient and coordinated scheduling is required. |

Native `.mpp` support is a separate binary-format challenge within FUT-02. Microsoft Project Online retired on 30 September 2026; standalone Project desktop is separate. Do not base future integration work on retired Project Online/PWA services. See research source S19.

## 7. Prioritization review and success evidence

- [ ] Validate the assumed audience and weekly-review workflow with representative users.
- [ ] Capture current task-finding, review preparation, milestone review, and report-production effort before claiming improvements.
- [ ] Reassess low-complexity ratings after prototyping hierarchy/filter/connector interactions.
- [ ] Review false-positive rates for schedule health and possible owner conflicts.
- [ ] Reprioritize RM-04 if most users manage only one project.
- [ ] Reconsider FUT-01/FUT-02 despite their complexity if progress forecasting or native schedule exchange is an adoption requirement.
- [ ] Review the backlog after each delivered phase and record changed assumptions.

Sensitivity: increasing a value-5 item's complexity from 2 to 3 lowers its score from 2.50 to 1.67; a value-4 item moves from 2.00 to 1.33. If notes/blockers have value 4 for the chosen audience, RM-08 joins the final tied group. Treat these as prompts to review scope and demand rather than precise measurements.

## 8. Definition of done for a roadmap item

- [ ] The bounded user outcome is usable through the actual app workflow.
- [ ] The item's implementation and acceptance checklists are complete, or an explicit scope revision documents any removed work.
- [ ] Relevant compatibility, persistence, calendar, and regression checks pass.
- [ ] Documentation describes the shipped behavior and practical limits.
- [ ] Validation evidence is recorded and the item status is updated.
- [ ] Follow-up ideas are tracked separately rather than implied to be part of the completed release.
