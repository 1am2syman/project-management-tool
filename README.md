# Plan: project sheet + Gantt

Spreadsheet-style task grid on the left, fully draggable Gantt on the right (FS/SS/FF/SF links, critical path,
milestones, quarter/month/week/day views), multi-project sheet tabs, templates, native `.plan` project files, Excel and PDF export,
and Microsoft 365 integration (people directory, deadline reminders, read-only sharing). Vanilla ES modules, no build step.

## Run on Windows

With **Git and uv already installed**:

1. Clone the repository:

   ```bash
   git clone https://github.com/1am2syman/project-management-tool.git
   ```

2. Double-click **start.bat** inside the `project-management-tool` folder.

The launcher runs `uv run --locked project-management-tool`. uv automatically downloads Python if needed, creates the project's `.venv`, and installs the project using `uv.lock`. The app opens in your default browser at **http://127.0.0.1:5173/**. The first run needs internet access for setup; later launches reuse the environment. No manual Python installation, pip commands, Node.js, or ZIP is required.

Keep the launcher window open while using Plan. Wait for **Saved to this computer** before closing the app, then stop the server with Ctrl+C or close its window. Run `start.bat` again to reopen your saved app state automatically. Double-clicking it while Plan is running opens that instance for the same database. If another program uses port 5173, run `start.bat --port 5174`.

On macOS/Linux, or from a terminal on Windows:

```bash
uv run --locked project-management-tool
```

The standard-library source launcher, `python start.py`, is also available if you already have Python 3.10 or newer.

## Update the app

On Windows:

1. Wait for **Saved to this computer**, then stop Plan by closing its launcher window or pressing Ctrl+C there.
2. Double-click **update.bat** inside the cloned repository. It pulls the latest updates and keeps the window open so you can read the result.
3. Run **start.bat** again. uv updates the environment as needed.

The page does not hot reload. For front-end-only JS/CSS/HTML updates, the running server reads the changed files directly with caching disabled: refresh the browser to load them. Python server or dependency updates require a server restart. The stop/update/start procedure above works for both kinds of update.

The updater requires Git and internet access. It uses `git pull --ff-only` for the current branch's configured upstream, so it stops if the branches have diverged. If Git reports a conflict with local edits or another error, resolve that error before running the updater again. It does not reset your checkout or discard local changes.

On macOS/Linux, or from a terminal on Windows, stop Plan and run `git pull --ff-only` in the cloned folder, then start the app again. Saved work stays in Documents/Plan, separate from the repository.

## Project files: Save, Save As and Open

- **Save As…** saves the active project to a dedicated **`.plan`** file. In Chrome and Edge on localhost or HTTPS, a native Save As dialog lets you choose its name and folder. The browser confirms before replacing an existing file. Other browsers download the same `.plan` file using their download settings.
- **Open…** opens a native file chooser for `.plan` files and adds the selected project as a new editable tab. Existing projects stay in place; duplicate names get a numbered suffix. In Chrome/Edge with native file access, the tab connects to that file for subsequent **Save** operations.
- **Save / Ctrl/⌘+S** writes the active project to its connected file, without another Save As dialog. A project without a connection asks for a destination once. **Save As… / Ctrl/⌘+Shift+S** chooses a different file and reconnects the project after a successful save. **Ctrl/⌘+O** opens a project.

Tabs carried over from an older app version need **Save As… once** to connect their current contents to the intended file. After that, **Save** reuses the connection.

Native file connections are kept separately in this browser and survive a refresh; the browser may ask you to allow file access again. Clearing site data, moving to another browser/computer, or unavailable browser storage requires Open or Save As again. Duplicating a tab creates an independent project without a file connection. Save refuses to overwrite a connected file that changed outside Plan, or to write a connected file from a stale/read-only window; use Open to review it or Save As for a copy. Browsers without native file access download a snapshot on each Save.

A project file preserves tasks, hierarchy, dates, working calendars, per-task scheduling modes, durations, all four relationship types and lag, milestones, progress, owners and email addresses, collapsed groups, scheduling/critical-path preferences, and reminder configuration. Opening applies the file's scheduling/critical-path preferences to the editor. Reminders start **off** in the opened copy; enable them in **Remind** when ready. Live Microsoft 365 sharing links, permissions, scheduled-message records, sign-in credentials, undo/redo history, and app layout settings stay outside project files. Saving a shared read-only project creates a portable editable copy when opened, with auto-schedule off to preserve the published dates.

Files use versioned JSON with a `.plan` extension and a 64 MB size limit. Invalid, incomplete or unsupported files show an error before any project is added. Cancelling a file dialog leaves your work in place. Automatic saves and History continue to use the app's database; a `.plan` file contains the single project as it was when you last chose **Save** or **Save As…**. Changes do not automatically overwrite connected `.plan` files. See the [project file format](docs/project-files.md) for the version 1–3 structures and validation rules.

## Automatic local saves

The launcher automatically creates **Plan/plan.db inside your Documents folder**. On Windows it asks Windows for the actual Documents location, including redirected or OneDrive Documents folders. You do not need to create the folder or choose a file. This one SQLite database contains the machine's saved Plan state:

- All projects, tasks, relationships, templates, scheduling preferences, reminder settings and sharing records.
- The active project, selected task, density, focus, hidden columns, column widths, pane width, and each project's Gantt zoom and scroll position.
- Each project's undo/redo stacks (up to 150 undo steps, as in the editor), Microsoft 365 app configuration, reminder templates, and local reminder activity records.
- Retained saved versions of the entire app state. **History** opens a read-only viewer of earlier projects; viewing history does not change current work. Saved versions are not automatically pruned. They record completed saves, which can combine rapid edits; they are not a record of every pointer movement.

Edits trigger automatic saves immediately; rapid edits made during an in-flight save are combined into the next save. There is no periodic-save timer to wait for. SQLite transactions commit current state and history together. Repeated values are shared and larger values are compressed to reduce history size. There is one permanent database file; SQLite can briefly create a journal during a transaction. The bottom bar shows saving, saved, or a retry message if writing fails. Another window cannot silently overwrite newer state. The browser warns before closing while a save is pending. The database can grow as history accumulates; an individual save request is limited to 64 MB.

To back up or move your work, **stop Plan**, then copy **Documents/Plan/plan.db**. On another machine, put it in that machine's Documents/Plan folder before launching. To restore a backup, stop Plan, keep a copy of the current database, and replace it with your backup. Computers do not sync automatically. Unreadable databases are preserved and reported in the save indicator; they are never silently replaced with an empty project.

On the first launch, an empty database adopts projects, templates and settings already saved in the same browser and URL. Later launches load the database, including in a fresh browser profile. Projects from another URL or computer can also be moved with `.plan` files or Excel export/import. Microsoft sign-in credentials stay in Microsoft's browser cache, so a new browser profile or computer requires sign-in again; the database stores app configuration and activity, without passwords or sign-in tokens.

Serving only the `web` directory with a static server is still supported, but shows **Saved in this browser** and uses browser storage only. Use the launcher for integrated disk saves and history. `start.bat --data-dir "D:\My Plan Data"` (or `python start.py --data-dir "D:\My Plan Data"`) selects another folder for `plan.db`.

## Microsoft 365 (optional)

After the first uv setup, project planning and local saves work offline. To enable the Microsoft 365 features, register the app once:

1. Entra admin centre › App registrations › **New registration** (this organisation only).
2. Authentication › **Single-page application** › redirect URI = the URL shown in *Microsoft 365 › Settings* (it ends in `redirect.html`).
3. API permissions › Microsoft Graph › **Delegated**: `User.Read`, `User.ReadBasic.All`, `People.Read`, `Mail.ReadWrite`, `Mail.Send`, `Files.ReadWrite`, `Files.Read.All`. None of these needs admin consent by default, but your tenant policy may require it.
4. Put the *Application (client) ID* into *Microsoft 365 › Settings*, or into `src/project_management_tool/web/m365.config.json` to pre-fill it for everyone.

No client secret is used. Users sign in with their corporate account in a Microsoft popup; permissions are requested only when a feature first needs them (people search at sign-in; mail when reminders or sharing are first used; files when sharing).

| Feature | How it works |
|---|---|
| **People** | Owner cell type-ahead searches the directory (`/users?$search`, `/me/people`) and stores name + email on the task. |
| **Reminders** | Per project: on/off, **automatic**, granularity **per action item / per person / per project**, lead times, overdue notice, send hour and an editable **message template** (`{{person}} {{task}} {{project}} {{when}} {{deadline}} {{details}} …`, saved templates). Emails are queued in the signed-in user's own mailbox with a deferred-send time (`PidTagDeferredSendTime`), so Exchange Online sends them on schedule even when the app is closed. Sync previews and diffs: stale reminders are cancelled, new ones created. |
| **Read-only sharing** | *Share* publishes a snapshot to the owner's OneDrive (`Plan projects/`) and grants chosen colleagues the **read** role on that file, then emails each a confirmation with a link. Viewers open the link, sign in, and get a read-only sheet they can refresh; the owner can revoke at any time. The permission is real Microsoft 365 access control; the read-only UI is a convenience on top. |

Limits worth knowing: auto-reminders and auto-publish run only while the app is open and signed in (the *scheduled emails themselves* do not need the app); deferred messages sit in the sender's Outbox until due; `Files.Read.All` is needed to open files other people shared with you.

## Task hierarchy and row actions

Tasks can contain cascades at multiple levels. Select **Sleeve**, indent it beneath **Commercial Procurement**, then indent **CFC** once to put both groups under that parent. Indenting again nests CFC beneath Sleeve. A cascade moves with all descendants, including collapsed rows. Outdenting moves the selected cascade after its parent, keeping its former siblings with that parent.

- Drag the **grip beside a row number** to move a task or cascade. Drop near the top/bottom of a target row to place it before/after that entire cascade, or in the middle to nest it under the target. The drop indicator names the destination; Escape cancels. The sheet scrolls when dragging near its edges.
- **Right-click a task row** for task/milestone insertion above or below, child insertion, indentation, and conversion. Right-click the empty task area to append an item. **Shift+F10** opens the menu for the selected row; use arrow keys and Enter to choose.
- **Ctrl/⌘+Enter** inserts a task below the selection; **Ctrl/⌘+Shift+Enter** inserts a milestone. From an inline or formula-bar edit, these shortcuts commit the current edit first. Both start editing the new item's name. Plain Enter and Tab keep their spreadsheet editing behavior.
- **Alt+→ / Alt+←** indent/outdent the selected cascade. **Tab / Shift+Tab** move between cells.
- **Convert to milestone** keeps the row's identity, owner, progress and relationships and sets its duration to zero. **Convert to task** creates a one-working-day task. Cascades with children cannot become milestones, and milestones cannot contain children. A task with relationships must have those relationships removed before it can become a parent summary.

Insertion, movement, conversion and calendar changes support undo/redo and automatic local saves. Shared read-only projects cannot be changed.

## Scheduling modes and viewport layout

Task names show **A** (green, automatic), **M** (orange, manual) or **D** (amber, date anchor). These badges appear only in the sheet; Gantt bars use critical-path and Focus styling. Hover a badge for its meaning.

**Auto is the default** for new tasks, milestones, imports and existing tasks without an explicit mode. **Auto-schedule** is the global switch: on recalculates automatic tasks from dependencies, moving them earlier or later; off pauses those updates. When an older project opens with Auto-schedule enabled, previously unmarked date anchors become Auto and gaps can close. Explicit Manual and Date anchor choices are retained.

- **Auto-calculate from connections** is available by right-clicking a task row or Gantt item. It selects Auto and calculates the earliest start satisfying all incoming FS/SS/FF/SF links, lags and the project calendar. Tasks without predecessors keep their chosen starting date until connected. With **Auto-schedule** on, predecessor changes move automatic tasks earlier or later. With the switch off, this action calculates once; the badge remains **A**, and its tooltip explains how to enable live updates.
- **Use manual dates** keeps the chosen dates even if a connection is violated. Violated links are marked. Moving/resizing an automatic task or editing its start/finish switches it to manual; progress and duration edits retain its scheduling mode.
- **Use date anchor** keeps a chosen date but allows Auto-schedule to delay it when a dependency requires it. This is an explicit choice, retained when saving and reopening the project. Summary dates always roll up from their children.

**Fit** measures visible task, summary and milestone labels as well as bars. The **Row density** dropdown selects **Compact** or **Adaptive**; adaptive sizing fills the available height and recalculates when the window, visible row count or collapsed groups change, with compact scrolling for large plans. Your density choice is saved with the app's layout settings.

Header actions stay on one row and use icons with tooltips when space is tight. The compact density dropdown and timeline spacing keep Auto-schedule alongside the other controls at normal desktop pane widths. Narrow panes wrap with full switch labels, keeping sheet and Gantt rows aligned; save status appears in the bottom bar.

Gantt bars and labels use sharper positioning without soft outer shadows or label text shadows. Grid lines have crisp edges, and dependency connectors use a stronger stroke while retaining rounded elbows. Hover and drag feedback still use shadows.

## Project calendar

**Calendar** opens settings for the active project. Choose any working weekdays, use the Mon–Fri / Sun–Thu / Every day presets, and add or remove custom holidays by date with an optional name. At least one weekday must remain a workday. Holiday dates cannot repeat.

Calendar changes stay in a draft until **Apply calendar**. The preview lists affected rows and the resulting project finish. Applying keeps task durations, moves starts that fall on days off to the next workday, and recalculates finishes. With **Auto-schedule** on, automatic successors recalculate and date anchors can move later as needed; explicit manual tasks keep their dates. With it off, dependency changes do not move tasks and violated dependencies are marked. Task durations, summary spans, float and relationship lag count working days. The timeline still shows calendar dates, with nonworking weekdays shaded and holidays highlighted. Moving a task to a day off snaps its start forward; resizing counts only working days. Milestones remain zero-duration events.

Existing projects, new blank projects and imports without a calendar use **Every day** until configured. Calendars are separate for each project and are retained in local saves, undo/redo, templates, shared snapshots and `.plan` files. Nonempty projects save explicit task scheduling modes using format version 3. Older version 1 and 2 files still open. Excel exports include a **Plan calendars** metadata sheet when needed, which the importer uses to restore workdays and holidays. Keep that sheet for an Excel round-trip. PDF and Excel task tables display working-day durations and calculated finish dates. Reminder lead times remain calendar days.

## Focus, import

- **Focus** (toolbar switch, on by default): select a task in the grid or on the Gantt and unrelated bars and sheet rows become muted while their labels stay readable; WBS parents/children, predecessor chains (teal) and successor chains (violet) retain emphasis, with counts in a legend.
- **Relationships**: one relationship per directed task pair. Dragging the same type selects the existing connector; dragging a different type opens a confirmation editor. Type and lag changes apply only after confirmation, preserving the existing link and lag unless edited. Older saved projects with multiple relationships for a pair show a review prompt and toolbar button: choose which relationship to retain, or cancel without losing data. Resolution supports undo/redo. Imports include identical repeated constraints once with a warning and block conflicting types or lags until the source file is corrected.
- **Import** (Excel `.xlsx` or `.csv`, or drop a file anywhere): *Download template* gives a documented workbook (Tasks + Instructions, dropdowns/validation). Headers are matched by name (Task/Name, Start, End/Finish, Days/Duration, Depends on/Predecessors, Owner/Resource Names, Email, % done, Level, #). Hierarchy comes from *Level* or Excel row grouping; dependencies like `4`, `6SS+2`, `9FF-1` refer to the `#` column (or Excel row numbers). Exported Excel task data and calendars can be re-imported; use `.plan` files to preserve explicit per-task scheduling modes. A preview lists warnings per row; each ticked sheet becomes a new project tab.

## Development and tests

The app runs directly from Python and browser ES modules; it has no front-end build step. Node.js and Playwright are optional development tools.

See [the testing guide](docs/testing.md) for regression commands, browser setup, optional screenshots and test limitations. Browser checks use temporary databases and browser profiles, clean their temporary files after each run, and leave the checkout free of generated validation output by default.
