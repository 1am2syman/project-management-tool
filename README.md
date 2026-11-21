# Plan: project sheet + Gantt

Spreadsheet-style task grid on the left, fully draggable Gantt on the right (FS/SS/FF/SF links, critical path,
milestones, quarter/month/week/day views), multi-project sheet tabs, templates, native `.plan` project files, and Excel/PDF export. Plan is a local, offline-capable app with no account or cloud setup. Vanilla ES modules, no build step.

## Run on Windows

On **64-bit Windows 10/11**, the repository includes Python; no Python or uv installation is needed. To get the app with Git for Windows:

1. Clone the repository:

   ```bash
   git clone https://github.com/1am2syman/project-management-tool.git
   ```

2. Double-click **start.bat** inside the `project-management-tool` folder.

The launcher uses the bundled interpreter at `runtime/windows-x64/python.exe` to run `start.py` directly. The app opens in your default browser at **http://127.0.0.1:5173/**. Startup works offline, including the first launch: it does not download Python, contact Astral, install packages, or create a virtual environment. Git is needed only to clone and update the repository. A complete repository ZIP or copied folder also works; keep the `runtime` and `src` folders beside the launcher. See [bundled runtime details](runtime/README.md) for its source, license and verification instructions.

If an older checkout stopped with an Astral download or `UnknownIssuer` certificate error, run **update.bat**, then launch **start.bat** again. The updated launcher uses the runtime delivered by Git. Existing `.venv` folders belong to the optional development setup and can be removed after stopping any app instance that uses them. Saved projects stay in Documents/Plan.

Keep the launcher window open while using Plan. Wait for **Saved to this computer** before closing the app, then stop the server with Ctrl+C or close its window. Run `start.bat` again to reopen your saved app state automatically. Double-clicking it while Plan is running opens that instance for the same database. If another program uses port 5173, run `start.bat --port 5174`.

On macOS/Linux with Python 3.10 or newer:

```bash
python3 start.py
```

If you already use uv for development, `uv run --locked project-management-tool` remains available. uv may download Python and build dependencies when setting up that environment; use `start.bat` on restricted Windows machines. With an existing Python 3.10+ installation, `python start.py` also works.

## Update the app

On Windows:

1. Wait for **Saved to this computer**, then stop Plan by closing its launcher window or pressing Ctrl+C there.
2. Double-click **update.bat** inside the cloned repository. It downloads the latest published version, makes the folder match it exactly and keeps the window open so you can read the result.
3. Run **start.bat** again. It uses the updated source and bundled runtime directly.

The page does not hot reload. For front-end-only JS/CSS/HTML updates, the running server reads the changed files directly with caching disabled: refresh the browser to load them. Python server or dependency updates require a server restart. The stop/update/start procedure above works for both kinds of update.

The updater requires Git and internet access. Every update repairs the app folder, including a copy left with missing or mixed files by an earlier interrupted update:

- It stops without changing anything if Plan is still running from this folder, Git cannot download the update, or the copy does not follow a published branch. It removes a lock left by an interrupted Git command when no Git command is running.
- It resets every tracked file to the current branch's published version and removes untracked and generated files under `src`. Anything in the folder that differed from that version is first set aside in Git stash: `git stash list` shows it, and `git stash show -p --include-untracked` shows its contents. Local commits that were not published remain recoverable through `git reflog`.
- It confirms that `git status` is clean before reporting **Plan is up to date** with the installed commit.

If another program keeps a file open, the update reports that it did not finish (Git may first ask whether to retry). Close that program and run **update.bat** again; a rerun completes the update. The bundled runtime is restored like any other tracked file, and saved projects in Documents/Plan are never touched.

On macOS/Linux, or from a terminal on Windows, stop Plan and run `git pull --ff-only` in the cloned folder, then start the app again. Saved work stays in Documents/Plan, separate from the repository.

## Project files: Save, Save As and Open

- **Save As…** writes the active project to a `.plan` file; **Open…** adds a project from a file without replacing existing tabs. **Save / Ctrl/⌘+S** writes the connected file, or asks for a destination. **Ctrl/⌘+Shift+S** chooses another destination and **Ctrl/⌘+O** opens a project.
- With the local launcher on Windows, Python displays the Windows chooser and handles file access. Chrome, Edge and Firefox use the same local service; browser file-picker permission and IndexedDB handles are not needed for this path. It has been verified on Windows 10 in Chrome and Edge; Firefox has not yet been tested. Browser pickers refuse files in folders they treat as system folders, such as `AppData` or `%TEMP%` (for example, an email attachment opened in place), and report that as an aborted request. The Windows launcher path is not subject to that browser restriction.
- Windows can keep focus on the browser after you click, so Plan brings its chooser above the browser. If you still cannot see it, use **Show file window** in the notice at the bottom of the page, or **Cancel** to stop waiting.
- Static hosting and macOS/Linux keep the browser-based picker or download fallback. Browser-local file handles stay in their original browser.

Windows local connections are stored separately under `%LOCALAPPDATA%\Plan\file-access`, associated with this workspace and project tab. They can survive a browser change or server restart on the same machine. The registry contains file paths and temporarily staged project snapshots; protect it like other local project data. It is separate from Documents/Plan and ordinary `plan.db` backups; moving a database or deleting the registry requires Open or Save As to reconnect. Existing browser handles cannot be migrated automatically. Duplicating a tab does not duplicate its connection.

Save checks the last confirmed file for outside changes and refuses a stale or read-only connected overwrite. Save As can write a separate copy; it refuses the connected source for a read-only or stale project, including known aliases. If a legacy connection cannot be resolved, reconnect it before exporting a read-only copy. The operation journal helps reconcile interrupted saves; other applications do not share Plan's file lock, so an external write can still race the final replacement on some filesystems.

A project file preserves tasks, hierarchy, dates, working calendars, per-task scheduling modes, durations, all four relationship types and lag, milestones, progress, owners and email addresses, collapsed groups, scheduling/critical-path preferences, the project's saved versions and, once agreed, its delay accounting (agreed dates, change log and key milestones). Opening applies the file's scheduling/critical-path preferences to the editor. Older reminder and sharing settings in the file remain inert compatibility metadata; they do not schedule or send mail. Saving an older read-only snapshot creates a portable editable copy when opened, with auto-schedule off to preserve its dates.

Files use versioned JSON with a `.plan` extension and a 64 MB size limit. Invalid, incomplete or unsupported files show an error before any project is added. Cancelling a file dialog leaves your work in place. Automatic saves and History continue to use the app's database; a `.plan` file contains the single project as it was when you last chose **Save** or **Save As…**. Changes do not automatically overwrite connected `.plan` files. See the [project file format](docs/project-files.md) for the version 1–6 structures and validation rules.

## Project versions and version analysis

**Snapshot** in the toolbar saves the active project's current plan as a numbered version (v1, v2, …) with a name and an optional note, such as *Baseline* or *Approved by the steering group*. Plan creates versions only when you press Snapshot or keep the current plan before a restore; edits never create them automatically. The dialog says when nothing has changed since the latest version. Each version keeps tasks, hierarchy, dates, durations, progress, owners, relationships, the working calendar, the Auto-schedule setting, critical-path method/threshold and target as they were, together with when it was taken. A project keeps up to 200 versions; version numbers are never reused after a deletion.

The version button beside the project name (**Current** by default) lists **Current plan** and every version with its date and forecast finish. Choosing a version shows it in the sheet and Gantt **read-only**: a banner names the version and its note, and editing, scheduling and calendar actions are disabled. A version keeps the dates it was saved with, even if Auto-schedule is on now. Export and Save as template use the version on screen; Save, Save As and Share always use the live plan. **Back to current** (or choosing Current plan) returns to editing; switching projects or reloading also returns to the current plan. From the banner you can also:

- **Restore…** replaces the current plan with the version in one undoable step. By default Plan first saves the current plan as a new version when it differs from the latest one. Task and relationship numbers are never reused. Shared read-only projects cannot be restored.
- **Copy as new project** opens the version as a separate, editable project tab without versions.
- **Compare to current** opens the version analysis with this version as the baseline.

Use the pencil in the list to rename a version or edit its note, and × to delete it after confirmation. Versions belong to their project: they are saved with it automatically, appear in History, and travel in `.plan` files (format 4). Duplicated tabs, copies and templates do not include them.

**Analysis** (chart icon in the toolbar, **Version analysis…** in the version list) opens a full-screen comparison. Choose a **Baseline** and a **Compared with** plan (any version or the current plan; ⇄ swaps them). It opens with the latest version against the current plan. Sections:

1. **Summary**: the compared finish and its movement from baseline lead, followed by duration, % complete, milestones and changes. **All metrics** expands the full before/after table, including start, task counts, critical tasks and violated relationships. Later finishes are red and earlier ones green.
2. **Trends**: forecast finish and each milestone's date across all versions and the current plan, with the two compared plans highlighted.
3. **Milestones**: baseline and compared dates with Slipped, Early, On time, New or Removed status.
4. **Gantt comparison**: a **Why the finish moved** waterfall bridges the baseline finish to the compared finish with named task revisions, additions, removals, dependency and calendar changes. Select a bar or use the step picker to see before/after values and its effect on completion; Left/Right or Home/End moves between chart steps. **Why this step?** expands the explanation and controlling chains, **All contributions** opens the full table, and **Calculation notes** explains attribution. Red steps delay completion, green steps recover time, and amber steps show unexplained differences. Dense comparisons use numbered bars and the named picker to keep both endpoints visible. Below it, each task's compared bar overlays a light ghost bar for the baseline, coloured by later/earlier/new, with the finish change at the right; **Changed only** filters rows and **Full names** expands labels. Ghost baseline bars appear only here, never on the main Gantt.
5. **Change log**: every added, removed and changed task, relationship and calendar entry, with filters (Dates, Duration, Progress, Owner, Structure, Scheduling, Relationships, Calendar, Added, Removed) and search.
6. **Biggest slips**: tasks that finish later, largest first, with the likely cause (own duration change, a predecessor's slip, changed lag or a new relationship).
7. **Critical path**: tasks that joined or left the critical path and changes in total slack.
8. **By owner**: per owner, tasks slipped, earlier, added and removed, the working days added or removed, and the worst slip.

The finish waterfall replays scheduling inputs on an isolated baseline: calendar first, task scope and connected dependency edits next, then task revisions in dependency order. Independent revisions share a joint contribution so competing parallel paths are not assigned arbitrary individual shares. Connected additions/removals and their dependency replacements also stay together, with each item labelled added or removed. Contributions depend on this fixed order; saved versions do not contain the edit history. Downstream Auto date movement is counted with its cause, and zero-effect changes stay visible. The waterfall always explains **project completion**, regardless of a selected milestone critical-path target, and includes completed activities when they still explain finish movement. It uses the compared plan's Auto setting; when Auto is paused, saved dates do not propagate through dependencies. Any baseline scheduling alignment or final finish difference the replay cannot reproduce is explicitly labelled instead of being presented as a proven task cause. Empty plans and circular dependency graphs show an explanation when attribution is unavailable.

Task slips count working days in the task’s compared calendar; project-level shifts use the compared global calendar; dates are shown as each plan calculated them. Summary rows roll up from their children and are not listed as edits themselves. **PDF** and **Excel** export the comparison: the PDF includes the finish waterfall and its contribution details, and Excel adds a **Finish waterfall** sheet with before/after values, cumulative finish dates, working/calendar-day contributions, explanations and controlling chains, plus a **Finish waterfall chart** sheet. Press Escape or × to close the analysis; it never changes the plan.

## Delay accounting

Delay accounting separates **delay** (the plan slipped) from approved **changes to the agreed dates**, so a client-approved revision is never reported as lateness.

- **Agreed dates.** Nothing is agreed until you agree it. Right-click a task for **Set agreed deadline…** (one click offers the expected date, or pick another), or save a version of type **Agreed baseline** (Snapshot → Type), which agrees every task's current dates at once and starts the undo history afresh. Agreed dates show beside Days: **Original agreed** (once something has been revised), **Agreed**, **± days** and **Own / Inherited**. A task can be late by its own delay or by delay inherited from earlier tasks; only the task where a delay started is shaded on the Gantt and chipped **Own**.
- **Recording a change.** Dragging or editing a task so it finishes after its agreed date opens a popover: **Delay** (keep the agreed date; choose a cause, party and note, then **Record**), **Revision** (agree the new finish with a reason and who approved it), **Skip reason** (record without a cause), or **Cancel**, which undoes only that edit. A task that starts late asks the same. A task that is already past its agreed date and unfinished shows an **Overdue** chip. New tasks wait as **Pending** until you **Agree inclusion…**; Deleting an agreed task asks whether to **Omit from scope** (an agreed reduction, kept as a record with its dependency chain) or delete it as a mistake. Every undo and redo covers agreed dates and the log.
- **Classify later.** A cause is never required: a delay recorded with **Skip reason** shows **Unclassified**, and any recorded delay can be given (or have changed) its cause, party, kind and note later, from the task's right-click menu (**Edit delay record…**, with a picker when the task has several delays), by double-clicking or pressing Enter/F2 on its **Cause** cell, or from a row of the Analysis **Delay log** (only when comparing with the current plan; saved versions are read-only). Each Save is one undo step. Saving an **Agreed baseline** lists the delays that still have no cause and lets you classify them right there, but never blocks the save.
- **Causes.** Settings → **Delay causes** lists the causes you can choose; you can add, rename and retire them (retired causes stay on old entries). A `.plan` file carries the causes it uses and maps them onto the list by name when opened.
- **Version types.** A saved version can be **Agreed baseline**, **Status update** or **Draft**; Analysis opens on the latest Agreed baseline against the current plan.
- **Analysis.** With an agreed plan the Analysis page adds a **Milestone table** (Agreed, Revisions, Current agreed, Delay, Expected, Status, Main causes), an **Impact grid** (each column adds up to its milestone's total; star milestones as key, or Show all), **Explain a milestone** (Original agreed → agreed changes → Current agreed → delays → Expected; agreed changes are neutral blue, delay red, recovery green), an **Agreed vs expected** trend across versions, **Own vs inherited, by owner** (Inherited is summed per task, so it is not additive with Own) and the **Delay log**. Changing a calendar or a task's scheduling mode behaves like a link edit: if it pushes an agreed task past its agreed date, the record dialog opens (Cancel undoes the change) and the move counts as that task's own. Edits that move an agreed task earlier (a shorter task, an earlier finish or predecessor) are logged automatically as a **Recovery** and shown green, and a move that stays inside the agreed date is logged as **Within agreed**; neither asks for a cause, so nothing ends up as Other / unexplained. These automatic rows net out per task: a task that returns to its agreed date leaves no row and no cause. The record dialog is keyboard-complete: Tab stays inside it, Enter in a text field records, and focus returns to the grid when it closes; the Explain stepper keeps focus on the button you used. Converting a task to a milestone is a recovery like a shorter task, converting a milestone to a task asks like a duration edit, and turning Auto-schedule back on attributes the catch-up to the delays recorded while it was off. A task that is late with no entry (for example edited where nothing could ask) reads **Not recorded**; **Record delay…** in the task menu or the Cause cell records it later. In a tab that has gone stale, Record and Save say so instead of reporting success, and causes added in another tab or by opening a file appear at once. A duplicate or a copy of an Agreed baseline has no versions, yet its delay sections are available under the snapshot hint. Key milestones are saved with the project. The analysis PDF and Excel include the milestone table, impact grid and Delay log; the sheet's Excel export adds the agreed columns and a **Delay log** sheet, and re-importing an export adds no log rows.
- **Files.** Agreed dates, the log and version types need `.plan` format 6; older files open with nothing agreed. See [the format](docs/project-files.md#delay-accounting-version-6).

Out of scope for this release: status date, actual start/finish, automatic rescheduling of unfinished work, and a register of delay notices and extension-of-time claims.

## Diagnostic log

The **Log** button in the bottom bar opens a live diagnostic report. Recording starts as soon as the page opens, including before the main app starts. To investigate a problem, reproduce it, select **Log → Download log**, and share the resulting `plan-diagnostics-….json` file. Log remains available while Open/Save are waiting. **Refresh setup** repeats the environment checks; **Clear log** removes the recorded events.

The report includes Chrome/Edge version information exposed by the browser, operating-system information, language/timezone, page security and file-picker support, cookie and browser-storage availability, IndexedDB checks, Python/SQLite versions, and a fingerprint of the installed app source. It records JavaScript errors and stacks, rejected promises, console messages, failed resources, request status/timing, page lifecycle and control actions, app startup/local saves, and individual Open/Save stages. Operations still waiting after 15 seconds produce a warning, and a downloaded report lists any unfinished operations. This helps distinguish waiting on the chooser, file access, reading, validation, rendering or file-connection storage.

Logs stay locally in the current tab, with recent entries retained through refresh using session storage when available. Recording is bounded to the latest 1,500 events and approximately 384 KB of event data; older entries are dropped. Nothing is uploaded automatically. Project contents, typed input, cookie values, request/response bodies, authentication headers and credential-storage values are excluded. Error text is redacted on a best-effort basis; review a downloaded log before sharing it. Browsers may withhold some version/setup information, and this report cannot inspect Windows event logs or installed browser extensions.

After updating to a version with Log, restart the launcher and refresh the app so the browser and Python server both use the updated code.

If the grid stays empty at **Loading saved projects…**, a JavaScript module may have failed before saved-state loading began. Newer builds show **Plan could not start** with **Reload** and **Open Log** controls, and retain the module-import error and final resource HTTP statuses. JavaScript support comes with the browser; all current app modules load from the local app server, with no CDN dependency.

Keep the installed app source from one complete version. An old `main.js` alongside a newer source tree can still import removed files and prevent the entire app from starting. For a copied/ZIP installation, use a fresh complete app folder. For a Git checkout on Windows, stop Plan and run **update.bat**, which repairs the folder. If the copy still has an older updater that stops with a Git error, first run `git fetch` and `git checkout origin/master -- update.bat` in the folder, then run **update.bat**. Then run `start.bat` and refresh the browser. This restores app code; saved projects in Documents/Plan and the bundled runtime are separate.

## Automatic local saves

The launcher automatically creates **Plan/plan.db inside your Documents folder**. On Windows it asks Windows for the actual Documents location, including redirected or OneDrive Documents folders. You do not need to create the folder or choose a file. This one SQLite database contains the machine's saved Plan state:

- All projects, tasks, relationships, templates, scheduling preferences, and any retained legacy metadata.
- The active project, selected task, density, focus, hidden columns, column widths, pane width, and each project's Gantt zoom and scroll position.
- Each project's undo/redo stacks (up to 150 undo steps, as in the editor) and app settings.
- Retained saved versions of the entire app state. **History** opens a read-only viewer of earlier projects; viewing history does not change current work. Saved versions are not automatically pruned. They record completed saves, which can combine rapid edits; they are not a record of every pointer movement.

Edits trigger automatic saves immediately; rapid edits made during an in-flight save are combined into the next save. There is no periodic-save timer to wait for. SQLite transactions commit current state and history together. Repeated values are shared and larger values are compressed to reduce history size. There is one permanent database file; SQLite can briefly create a journal during a transaction. The bottom bar shows saving, saved, or a retry message if writing fails. Another window cannot silently overwrite newer state. The browser warns before closing while a save is pending. The database can grow as history accumulates; an individual save request is limited to 64 MB.

To back up or move your work, **stop Plan**, then copy **Documents/Plan/plan.db**. On another machine, put it in that machine's Documents/Plan folder before launching. To restore a backup, stop Plan, keep a copy of the current database, and replace it with your backup. Computers do not sync automatically. Unreadable databases are preserved and reported in the save indicator; they are never silently replaced with an empty project.

On the first launch, an empty database adopts projects, templates and settings already saved in the same browser and URL. Later launches load the database, including in a fresh browser profile. Projects from another URL or computer can also be moved with `.plan` files or Excel export/import. No sign-in is required. Old integration settings may remain in existing saved state for compatibility, but no connection, mail or cloud operation uses them.

Serving only the `web` directory with a static server is still supported, but shows **Saved in this browser** and uses browser storage only. Use the launcher for integrated disk saves and history. `start.bat --data-dir "D:\My Plan Data"` (or `python start.py --data-dir "D:\My Plan Data"`) selects another folder for `plan.db`.

## Local-only scope

Microsoft 365 integration is out of scope. Plan does not offer Microsoft sign-in, organization directory lookup, email reminders, OneDrive publishing or cloud access management. No Entra registration, tenant approval, credentials or Task Scheduler setup is required. The [former Windows reminder plan](docs/windows-reminder-agent-plan.md) records the scope decision.

Owner names and optional email addresses are local task fields. Type a name directly or choose a suggestion from people already entered in the workbook. Email addresses are contact information; Plan sends no messages. Exchange projects by sending `.plan` files or Excel/PDF exports through your own tools.

Existing databases and files remain readable. Legacy reminder/sharing metadata is inactive. Older read-only snapshots can be inspected and turned into an editable local copy; they cannot refresh from a cloud source. Removing integration code does not recall mail previously submitted to an external service or remove tasks installed by an earlier version; see [retirement notes](docs/native-reminders.md).

## Task hierarchy and row actions

Tasks can contain cascades at multiple levels. Select **Sleeve**, indent it beneath **Commercial Procurement**, then indent **CFC** once to put both groups under that parent. Indenting again nests CFC beneath Sleeve. A cascade moves with all descendants, including collapsed rows. Outdenting moves the selected cascade after its parent, keeping its former siblings with that parent.

- Drag the **grip beside a row number** to move a task or cascade. Drop near the top/bottom of a target row to place it before/after that entire cascade, or in the middle to nest it under the target. The drop indicator names the destination; Escape cancels. The sheet scrolls when dragging near its edges.
- **Right-click a task row** for task/milestone insertion above or below, child insertion, indentation, and conversion. Right-click the empty task area to append an item. **Shift+F10** opens the menu for the selected row; use arrow keys and Enter to choose.
- **Ctrl/⌘+Enter** inserts a task below the selection; **Ctrl/⌘+Shift+Enter** inserts a milestone. From an inline or formula-bar edit, these shortcuts commit the current edit first. Both start editing the new item's name. Plain Enter and Tab keep their spreadsheet editing behavior.
- **Alt+→ / Alt+←** indent/outdent the selected cascade. **Tab / Shift+Tab** move between cells.
- **Convert to milestone** keeps the row's identity, owner, progress and relationships and sets its duration to zero. **Convert to task** creates a one-working-day task. Cascades with children cannot become milestones, and milestones cannot contain children. A task with relationships must have those relationships removed before it can become a parent summary.

Insertion, movement, conversion and calendar changes support undo/redo and automatic local saves. Read-only local snapshots cannot be changed until copied.

## Scheduling modes and viewport layout

Task names show **A** (green, automatic), **M** (orange, manual) or **D** (amber, date anchor). These badges appear only in the sheet; Gantt bars use critical-path and Focus styling. Hover a badge for its meaning.

**Auto is the default** for new tasks, milestones, imports and existing tasks without an explicit mode. **Auto-schedule** is the global switch: on recalculates automatic tasks from dependencies, moving them earlier or later; off pauses those updates. When an older project opens with Auto-schedule enabled, previously unmarked date anchors become Auto and gaps can close. Explicit Manual and Date anchor choices are retained.

- **Auto-calculate from connections** is available by right-clicking a task row or Gantt item. It selects Auto and calculates the earliest start satisfying all incoming FS/SS/FF/SF links, lags and the task’s effective calendar. Tasks without predecessors keep their chosen starting date until connected. With **Auto-schedule** on, predecessor changes move automatic tasks earlier or later. With the switch off, this action calculates once; the badge remains **A**, and its tooltip explains how to enable live updates.
- **Use manual dates** keeps the chosen dates even if a connection is violated. Violated links are marked. Moving/resizing an automatic task or editing its start/finish switches it to manual; progress and duration edits retain its scheduling mode.
- **Use date anchor** keeps a chosen date but allows Auto-schedule to delay it when a dependency requires it. This is an explicit choice, retained when saving and reopening the project. Summary dates always roll up from their children.

**Critical path** offers the same two display methods as Primavera P6. Click the **Critical path** text beside its switch to choose **Define critical activities as**:

- **Longest Path** traces the driving dependency chain backward from the finish, including tied paths. It handles different task calendars: an activity may be red while still having positive total/free slack, because a successor’s nonworking days absorb some delay. The slack numbers remain valid. Manual dates, dependency violations and gaps beyond dependency requirements stop the trace.
- **Total Float less than or equal to** highlights unfinished activities at or below a chosen threshold in each activity’s working days. The default remains **0 working days** for existing projects. Different calendars may leave gaps in this highlighted chain.

The method and threshold are saved per project, included in `.plan` files and saved versions, and identified in PDF/Excel exports. Changing them does not move tasks, change scheduling modes or add an undo step.

The target defaults to **Project completion**, using the latest finish across the project. To analyze a specific goal, click the **Critical path** text beside its switch and choose a milestone, or right-click a milestone row/Gantt diamond and select **Use as critical-path target**. The control and status bar identify the selected target. Only that milestone and its transitive predecessors receive total float; the selected method determines which receive critical-path highlights; unrelated branches show no float. Shared predecessors are still included. Float uses working days, all four relationship types and lag; completed tasks are not highlighted as critical.

The target uses the milestone’s current date and does not change dates or scheduling modes. It is separate from **Use date anchor**, which controls scheduling. Your target choice is saved per project in the app and restored after refresh; it is a view setting outside undo/redo and portable `.plan` files. If the target is deleted, converted to a task or becomes a summary, the view falls back to Project completion; undoing that edit restores the choice. Use the chooser’s **Project completion** option to clear it. PDF and Excel exports use the selected analysis and label its target.

**Fit** measures task bars, labels, milestone diamonds, connector elbows and connection handles, leaving room for start-to-start links at the chart's left edge. The **Row density** dropdown selects **Compact** or **Adaptive**; adaptive sizing fills the available height and recalculates when the window, visible row count or collapsed groups change, with compact scrolling for large plans. Your density choice is saved with the app's layout settings.

Header actions stay on one row and use icons with tooltips when space is tight. The compact density dropdown and timeline spacing keep Auto-schedule alongside the other controls at normal desktop pane widths. Narrow panes wrap with full switch labels, keeping sheet and Gantt rows aligned; save status appears in the bottom bar.

Gantt bars and labels use sharper positioning without soft outer shadows or label text shadows. Grid lines have crisp edges, and dependency connectors use a stronger stroke while retaining rounded elbows. Hover and drag feedback still use shadows. Sheet and chart scrollbars use slim tracks; Chromium-based browsers show 6px scrollbars without arrow buttons.

## Per-task slack

The sheet shows **Total slack** (formerly Float) and **Free slack**, both calculated in each task’s working calendar. Click either value, select a slack cell and press Enter, use **Slack** beside Columns, or right-click a task and choose **Inspect task slack**. The dialog explains the values, latest start/finish dates, limiting successors and the current analysis target. Both values are read-only.

- **Total slack** is the delay allowed before project completion or the selected critical-path milestone moves, allowing downstream tasks to move within their slack.
- **Free slack** holds immediate successors at their currently scheduled dates. Tasks without successors use project completion; the selected milestone itself stays fixed. Free slack is local, so it remains available outside the selected milestone’s total-slack scope.

For example, 5 working days of total slack and 2 working days of free slack means a three-day delay requires downstream schedule changes but can still meet the target. Where both limits apply, neither may be negative; use the smaller allowance to protect both; free slack can exceed total slack when the completion boundary is tighter. Slack along a chain is shared, not an independent allowance for every task. Manual and date-anchor scheduling choices still apply.

Zero means no allowance remains. Negative values indicate how much earlier a task must move to meet that limit. A dot means no total-slack analysis for an unrelated branch, or no calculation for a summary row; the tooltip and details distinguish these cases. The dialog warns when the schedule contains violated dependencies, since positive slack does not establish that an inconsistent schedule is safe. Completed tasks retain calculated values but are not highlighted as critical.

In **Slack → Show slack on Gantt**, choose **Off**, **Selected task** (the initial setting), or **All tasks**. Positive slack appears as a thin tail continuing from the task’s finish (or milestone): the thick part reaches the latest finish allowed by free slack, the thin dashed part continues to the latest finish allowed by total slack, and caps mark the limits. Tails are thin, square-ended and 50% black so they stay visible without competing with task bars. Tails show room to slip, not extra duration. Only the selected task’s tail is labelled (for example **5d total · 2d free**); in **All tasks** mode other tails are unlabelled, and with **Focus** on, unrelated tasks’ tails fade with their bars. **Fit** includes visible tails and the label. Overlay controls remain separate from task editing and work in read-only projects.

Excel task tables include both slack values and the total-slack target. The Export menu’s **Include slack columns in PDF** option adds Total/Free columns with working-day units. Display and PDF preferences survive refresh and local database restoration. Calculated slack and latest dates are recomputed from existing project data, so portable `.plan` files retain their current format; the critical-path target remains a local view choice.

## Global and task calendars

**Calendar** opens settings for the active project. The **Global** tab sets the default working weekdays and holidays. Choose the Mon–Fri / Sun–Thu / Every day presets or individual weekdays, and add holidays by date with an optional name. At least one weekday must remain a workday; holiday dates cannot repeat.

Right-click a task row or Gantt item and choose **Task calendar…** to configure an independent calendar for that task or milestone. It starts as a copy of the current global calendar, then replaces both global weekdays and holidays. Future global changes do not alter it. A small amber corner triangle in the task-name cell marks an active override; its tooltip explains the marker. Parent summary rows roll up child dates and do not have or pass down calendars. If a task becomes a summary, its own override is removed; undo restores it.

The **Task calendars** tab lists only tasks and milestones with overrides, with their working weekdays, holiday details, **Edit**, and **Use global** actions. **Use global** previews removing the override; applying makes the task follow the current global calendar and subsequent global changes. **Back to custom calendar** returns directly to your unsaved custom draft.

Calendar changes stay in a draft until applied. The preview lists all affected rows, including downstream tasks, and the resulting project finish. Long holiday lists and changed-row tables scroll within the overlay; actions stay visible. Applying keeps working-day durations, moves starts on days off forward, and recalculates finishes in each task’s effective calendar. With **Auto-schedule** on, automatic successors recalculate and date anchors can move later; manual tasks are not moved by dependencies. With it off, dependencies do not move tasks and violations are marked. The directly edited calendar still recalculates that task’s dates, including manual tasks. Calendar changes and affected dates form one undo step.

Dependency lag uses the receiving task’s effective calendar. For example, if A finishes Friday and B works Sunday–Thursday, an FS link with two working days of lag starts B on Tuesday (Sunday and Monday are the waiting days). Task durations, total/free slack, date edits and resizing use each task’s calendar. Summary spans and project-level metrics use the global calendar. The shared Gantt background continues to shade global days off; a custom task may work on those dates. Milestones remain zero-duration events.

Existing projects, new projects and imports without a calendar use **Every day** until configured. Calendars survive local saves, undo/redo, copies, templates, project versions and `.plan` files. Files with task calendars in the current plan or any saved version use format 5; older files still open. Older apps reject format 5 rather than dropping overrides. Version comparison includes task-calendar changes and their effects on completion. Excel exports preserve calendars in the **Plan calendars** metadata sheet; keep it and the task **#** values for a round-trip. PDF and Excel task tables show the calculated dates and working-day durations.

## Focus, import

- **Focus** (toolbar switch, on by default): select a task in the grid or on the Gantt and unrelated bars and sheet rows become muted while their labels stay readable; WBS parents/children, predecessor chains and successor chains retain emphasis in distinct ink tones, with counts in a legend.
- **Relationships**: one relationship per directed task pair. Dragging the same type selects the existing connector; dragging a different type opens a confirmation editor. Type and lag changes apply only after confirmation, preserving the existing link and lag unless edited. Older saved projects with multiple relationships for a pair show a review prompt and toolbar button: choose which relationship to retain, or cancel without losing data. Resolution supports undo/redo. Imports include identical repeated constraints once with a warning and block conflicting types or lags until the source file is corrected.
- **Import** (Excel `.xlsx` or `.csv`, or drop a file anywhere): *Download template* gives a documented workbook (Tasks + Instructions, dropdowns/validation). Headers are matched by name (Task/Name, Start, End/Finish, Days/Duration, Depends on/Predecessors, Owner/Resource Names, Email, % done, Level, #). Hierarchy comes from *Level* or Excel row grouping; dependencies like `4`, `6SS+2`, `9FF-1` refer to the `#` column (or Excel row numbers). Exported Excel task data and calendars can be re-imported; use `.plan` files to preserve explicit per-task scheduling modes. A preview lists warnings per row; each ticked sheet becomes a new project tab.

## Development and tests

The app runs directly from Python and browser ES modules; it has no front-end build step. Node.js and Playwright are optional development tools.

See [the testing guide](docs/testing.md) for regression commands, browser setup, optional screenshots and test limitations. Browser checks use temporary databases and browser profiles, clean their temporary files after each run, and leave the checkout free of generated validation output by default.
