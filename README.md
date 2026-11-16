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

Stop Plan, open a terminal in the cloned folder, and run `git pull --ff-only`. Then run `start.bat` again. uv updates the environment as needed. Saved work stays in Documents/Plan, separate from the repository.

## Project files: Save As and Open

- **Save As…** saves the active project to a dedicated **`.plan`** file. In Chrome and Edge on localhost or HTTPS, a native Save As dialog lets you choose its name and folder. The browser confirms before replacing an existing file. Other browsers download the same `.plan` file using their download settings.
- **Open…** opens a native file chooser for `.plan` files and adds the selected project as a new editable tab. Existing projects stay in place; duplicate names get a numbered suffix. Opening a file does not connect that tab to the original file: use **Save As…** again to write later edits.
- **Ctrl/⌘+O** opens a project; **Ctrl/⌘+Shift+S** or **Ctrl/⌘+S** saves it as a project file.

A project file preserves tasks, hierarchy, dates, durations, all four relationship types and lag, milestones, progress, owners and email addresses, collapsed groups, scheduling/critical-path preferences, and reminder configuration. Opening applies the file's scheduling/critical-path preferences to the editor. Reminders start **off** in the opened copy; enable them in **Remind** when ready. Live Microsoft 365 sharing links, permissions, scheduled-message records, sign-in credentials, undo/redo history, and app layout settings stay outside project files. Saving a shared read-only project creates a portable editable copy when opened, with auto-schedule off to preserve the published dates.

Files use versioned JSON with a `.plan` extension and a 64 MB size limit. Invalid, incomplete or unsupported files show an error before any project is added. Cancelling a file dialog leaves your work in place. Automatic saves and History continue to use the app's database; a `.plan` file contains the single project as it was when you chose **Save As…**. See the [project file format](docs/project-files.md) for the version 1 structure and validation rules.

## Automatic local saves

The launcher automatically creates **Plan/plan.db inside your Documents folder**. On Windows it asks Windows for the actual Documents location, including redirected or OneDrive Documents folders. You do not need to create the folder or choose a file. This one SQLite database contains the machine's saved Plan state:

- All projects, tasks, relationships, templates, scheduling preferences, reminder settings and sharing records.
- The active project, selected task, density, focus, hidden columns, column widths, pane width, and each project's Gantt zoom and scroll position.
- Each project's undo/redo stacks (up to 150 undo steps, as in the editor), Microsoft 365 app configuration, reminder templates, and local reminder activity records.
- Retained saved versions of the entire app state. **History** opens a read-only viewer of earlier projects; viewing history does not change current work. Saved versions are not automatically pruned. They record completed saves, which can combine rapid edits; they are not a record of every pointer movement.

SQLite transactions commit current state and history together. Repeated values are shared and larger values are compressed to reduce history size. There is one permanent database file; SQLite can briefly create a journal during a transaction. The header shows saving, saved, or a retry message if writing fails. Another window cannot silently overwrite newer state. The browser warns before closing while a save is pending. The database can grow as history accumulates; an individual save request is limited to 64 MB.

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

## Focus, import

- **Focus** (toolbar switch, on by default): select a task in the grid or on the Gantt and unrelated bars and sheet rows become muted while their labels stay readable; WBS parents/children, predecessor chains (teal) and successor chains (violet) retain emphasis, with counts in a legend.
- **Relationships**: one relationship per directed task pair. Dragging the same type selects the existing connector; dragging a different type opens a confirmation editor. Type and lag changes apply only after confirmation, preserving the existing link and lag unless edited. Older saved projects with multiple relationships for a pair show a review prompt and toolbar button: choose which relationship to retain, or cancel without losing data. Resolution supports undo/redo. Imports include identical repeated constraints once with a warning and block conflicting types or lags until the source file is corrected.
- **Import** (Excel `.xlsx` or `.csv`, or drop a file anywhere): *Download template* gives a documented workbook (Tasks + Instructions, dropdowns/validation). Headers are matched by name (Task/Name, Start, End/Finish, Days/Duration, Depends on/Predecessors, Owner/Resource Names, Email, % done, Level, #). Hierarchy comes from *Level* or Excel row grouping; dependencies like `4`, `6SS+2`, `9FF-1` refer to the `#` column (or Excel row numbers). Files exported by this app re-import unchanged. A preview lists warnings per row; each ticked sheet becomes a new project tab.

## Tests

Run storage and launcher tests with uv:

```bash
uv run --locked python -m unittest discover -s tests -p "test_*.py" -v
```

The JavaScript model, import and project-file regression tests require Node.js, which is only needed for development:

```bash
node --test tests/persistence.test.mjs tests/relationships.test.mjs tests/projectfiles.test.mjs
```

Browser validation covers relationship confirmation, Gantt layout and restoring SQLite state into a fresh browser profile after a server restart. Project-file checks cover the toolbar, keyboard save during an edit, file round-trips, cancellation and invalid files, a real download/file-input fallback, layout at several viewport widths, and restoring opened files in a fresh browser profile. Native picker results are mocked for automation; the OS Save As dialog itself is not driven by these tests. Microsoft 365 flows have been checked with a mocked Graph API, not a live tenant. The Windows batch launcher has been reviewed; automated launcher checks run on Linux with uv-managed Python.
