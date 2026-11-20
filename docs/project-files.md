# Plan project file format

Plan's **Save** and **Save As…** commands write one project to a UTF-8 JSON file with the `.plan` extension. **Open…** reads that file into a new editable project tab. Files are snapshots: later edits are saved to the app's database automatically, and to the project file when you choose **Save** or **Save As…**. In browsers with native file access, Open or Save As connects a project tab to its file so Save can update it. The browser-local handle is separate from the portable document.

See [the README](../README.md#project-files-save-save-as-and-open) for browser support and keyboard shortcuts.

## Versions 1–6

The top-level `format` must be `"plan-project"`. This app accepts `version: 1` (everyday scheduling), `version: 2` (project working calendars), `version: 3` (explicit task scheduling modes), `version: 4` (saved project versions) `version: 5` (task calendar overrides) and `version: 6` (delay accounting: agreed dates, change log, version types and causes). It writes version 6 when the current plan or any saved version has agreed dates, a change log, a baseline flag or pending inclusions, or when any saved version has a type; otherwise it writes version 5 when the current plan or any saved version has task calendars, version 4 when the project has saved versions and otherwise version 3 for nonempty projects, storing each task’s scheduling mode explicitly. Empty projects use version 1 for an everyday calendar with no holidays or version 2 for a configured calendar. Versions 2–5 require a valid `project.data.calendar`. Older apps reject unsupported versions instead of dropping scheduling modes or saved versions, or interpreting working durations as elapsed days. Unsupported versions are rejected before the app changes any project. A UTF-8 byte-order mark is accepted when opening a file. The maximum file size is 64 MiB (67,108,864 bytes).

This is a complete version 3 file containing one automatic task:

```json
{
  "format": "plan-project",
  "version": 3,
  "project": {
    "name": "Example project",
    "data": {
      "calendar": {
        "workdays": [0, 1, 2, 3, 4, 5, 6],
        "holidays": []
      },
      "tasks": [
        {
          "id": 1,
          "name": "First task",
          "level": 0,
          "start": 20759,
          "dur": 5,
          "progress": 0,
          "owner": "",
          "email": "",
          "noRem": false,
          "ms": false,
          "scheduling": "auto"
        }
      ],
      "links": [],
      "collapsed": [],
      "nextId": 2,
      "nextLink": 1
    },
    "rem": {
      "on": false,
      "auto": false,
      "mode": "task",
      "offsets": [3, 1, 0],
      "overdue": true,
      "hour": 9,
      "subject": "Reminder: {{task}}",
      "body": "Hi {{person}}, please check {{task}}.",
      "muted": []
    }
  },
  "preferences": {
    "auto": true,
    "critical": true
  }
}
```

## Project data

`project.name` is a nonblank string of at most 60 characters. Names already used in the workbook receive a numbered suffix when opened.

| Field | Meaning and requirements |
|---|---|
| `tasks` | Ordered task rows; an empty array is valid. Each task ID must be a unique positive safe integer. |
| `tasks[].name` | Nonblank task name, at most 200 characters. |
| `tasks[].level` | Nonnegative integer hierarchy depth. The first task has level 0; a row can be at most one level deeper than the preceding row. A task followed by deeper rows is a summary. |
| `tasks[].start` | Integer calendar day counted from 1970-01-01. For example, 20759 means 2026-11-02. |
| `tasks[].dur` | Integer duration in the task’s effective working days (calendar days for version 1). A regular task lasts at least one working day. A milestone (`ms: true`) has duration 0. The computed finish is exclusive: one day after the last occupied workday. |
| `tasks[].calendar` | Optional complete calendar override (version 5), with the same validation as the global calendar. Absence or null means inherit global. Summary rows cannot have overrides. |
| `tasks[].scheduling` | Optional `"auto"`, `"manual"` or `"anchor"` (version 3). Auto uses the earliest linked date while live Auto-schedule is on; without incoming links it keeps its current date. Manual dates are not moved by dependencies. Anchors may be delayed but are not pulled earlier. An absent mode defaults to Auto, including in older files; enabling Auto-schedule can therefore remove existing gaps. Explicit Manual and Anchor modes are preserved. Summary dates still roll up from children. |
| `tasks[].progress` | Integer percentage from 0 through 100. |
| `tasks[].owner`, `tasks[].email` | Owner display name (at most 80 characters) and email address (at most 254 characters). Both can be empty strings; a nonempty email must pass the app's email validation. |
| `tasks[].noRem`, `tasks[].ms` | `noRem` is an inert legacy flag retained for compatibility. `ms` marks a milestone. |
| `links` | Relationships between existing, distinct tasks. Summary endpoints and dependency cycles are rejected. |
| `links[].id` | Unique ID such as `"l1"`: `l` followed by a positive safe integer without leading zeros. |
| `links[].from`, `links[].to` | IDs of the predecessor and successor tasks. |
| `links[].type`, `links[].lag` | Type: `FS`, `SS`, `FF` or `SF`. Lag is an integer number of working days in the receiving task’s effective calendar; negative lag is allowed. |
| `tasks[].agr` | Optional agreed dates (version 6): `{ "s": start, "f": finish, "o": original finish }`, integer days with the same range as `start`. `f` is the agreed finish (the agreed date for a milestone, where `s` equals `f`); `o` is the first agreed finish and never changes. Summary rows cannot carry agreed dates (they roll up from their tasks). Expected dates stay in `start` and `dur`. |
| `tasks[].inc` | `true` on a task added after the plan was agreed and not yet agreed itself (version 6). A task never has both `agr` and `inc`. |
| `log`, `nextLog`, `baselined` | Version 6. `log` is the project's change log, at most 20,000 entries, each with a unique positive `id`, a `type` (`delay`, `revision`, `inclusion` or `omission`), `taskId` (the task's ID at the time; omitted tasks stay in the log), `taskName`, `at` (milliseconds), signed whole-number `days`, and optional `op` (`start` or `finish`), `kind` (`Late start`, `Overrun` or `On hold`), `cause` (an ID from `project.causes`, or absent for an unclassified delay), `party`, `reason`, `approvedBy`, `note`, `source` (`baseline` or `deadline` for revisions that moved an agreed date without moving the schedule) and `from` / `to` agreed days. `eff` maps a milestone's task ID, or `end` for the project completion, to the signed working days the entry moved that date: the agreed date for revisions, inclusions and omissions, the expected date for delays (stored when the delay is recorded, so the analysis never has to replay the schedule). `slip` (revisions) is the part of an edit's effect on expected dates that its agreed-date change did not account for. `via` (`link`) marks a delay recorded from a link or lag edit, which counts as the task's own. A delay with negative `days` is a recovery (an agreed task finishing earlier) and one with `days` 0 and an `eff` is a move within the agreed date; both are recorded automatically without a cause. `nextLog` is greater than every entry `id`. `baselined` is `true` once an Agreed baseline has been taken; only then do summaries and the project have agreed dates. |
| `agreedOrig` | Present with `baselined`: `{ "end": day, "sums": { "<summary task ID>": day } }`, the original agreed completion and each summary's original agreed finish, frozen when the first baseline was agreed so later agreed changes never rewrite them. |
| `stars` | Optional (version 6): unique existing task IDs the user marked as key milestones for the delay analysis. Not part of a saved version's plan. |
| `collapsed` | Array of unique existing task IDs whose groups are collapsed. |
| `nextId`, `nextLink` | Positive safe integer counters greater than the existing task IDs and numeric relationship IDs, respectively. |

Start dates and lag are restricted to −99,999,999 through 99,999,999. Durations are at most 99,999,999, and the exclusive finish must also stay within those date bounds. Computed values such as critical-path flags, float, relationship slack and summary dates are recalculated when a file opens.

The editor allows one relationship per directed task pair. Files containing legacy multiple relationships for a pair retain them for explicit review through **Review relationships**; they are not silently merged or removed.

## Working calendars

Versions 2–5 store this object in `project.data.calendar`:

```json
{
  "workdays": [0, 1, 2, 3, 4],
  "holidays": [
    { "date": "2026-11-09", "name": "Office closure" }
  ]
}
```

`workdays` is a nonempty array of distinct weekday numbers, where 0 is Sunday and 6 is Saturday. `holidays` contains at most 10,000 distinct dates in `YYYY-MM-DD` format; each must be a real date. Holiday names are strings up to 100 characters and may be empty. Holidays exclude dates from work even if their weekday is normally working. A version 1 file may omit `calendar`, or supply all seven weekdays with no holidays. A nontrivial calendar in a version 1 file is rejected. Calendar data is validated before the model can normalize it. Calendar-aware exclusive finishes must fit inside the supported date range.

The **Calendar** dialog previews date changes before applying. It preserves durations, normalizes starts on days off forward, and applies dependency bounds when auto-scheduling is enabled. Calendar changes and affected dates form one undo step. Excel exports carry the same settings in a `Plan calendars` metadata sheet; native `.plan` files carry them directly in this object.

Version 5 also permits this object in `tasks[].calendar`, for regular tasks and milestones in both the live plan and saved versions. An override fully replaces global weekdays and holidays; it is not merged. Removing it restores global inheritance. Dependencies count lag using the receiving task’s calendar, while task duration, slack and date arithmetic use that task’s effective calendar. Summary spans and project-level metrics remain in global workdays. Global calendar edits leave override configurations intact, although linked tasks can still move through dependency propagation.

The master dialog has **Global** and **Task calendars** tabs; the latter lists overrides only. The task context menu opens the same editor scoped to that task. **Use global** previews a reset. Converting a leaf into a summary removes its override without passing it to children; undo restores the leaf’s calendar.

Excel metadata version 1 stores global calendars only. Version 2 adds a fifth column, **Task # (blank=global)**: blank identifies a project calendar; a number matches the task sheet’s **#** value, including milestones. Each holiday occupies a row with the same task number and weekdays; a calendar without holidays still has a row. Invalid calendars and unmatched or ambiguous task entries are rejected during import. Keep the metadata sheet and task identities when editing an export.

## Delay accounting (version 6)

Agreed dates, the change log and `baselined` appear inside `project.data` and inside each `versions[].plan`, so a saved version keeps the agreed dates it was taken with. The causes a file uses are listed once in `project.causes`:

```json
"causes": [{ "id": "c4", "name": "Supplier / subcontractor" }]
```

`causes` has at most 200 entries with unique, nonempty `id` (at most 20 characters) and `name` (at most 60 characters). Every `cause` in a log must appear in it. Opening a file maps its causes onto the app-wide list by name (ignoring case) and rewrites the log to the list's IDs; causes the list does not have are added as retired, so they appear on old delays but not in the cause picker. Version 6 also allows an optional `versions[].type` of `baseline`, `status` or `draft`; versions without a type were saved before delay accounting and are never treated as agreed. Version 5 and older files must not contain any of these fields and open with no agreed data.

## Saved project versions

Version 4 adds the project's saved versions (the snapshots listed in the version menu) beside the live plan. `project.data` is always the live, editable plan, even if a saved version was on screen when the file was saved.

```json
"versions": [
  {
    "n": 1,
    "name": "Baseline",
    "note": "Approved by the steering group",
    "at": "2026-11-16T09:30:00.000Z",
    "by": "Ada Lovelace",
    "auto": true,
    "target": null,
    "plan": {
      "calendar": { "workdays": [1, 2, 3, 4, 5], "holidays": [] },
      "tasks": [ … ],
      "links": [ … ],
      "nextId": 23,
      "nextLink": 21
    }
  }
],
"nextVersion": 2
```

Both fields sit inside `project` and must appear together; version 1–3 files must not contain them.

| Field | Meaning and requirements |
|---|---|
| `versions` | At most 200 entries. |
| `versions[].n` | Version number shown as `v1`, `v2`, …: a unique positive safe integer. |
| `versions[].name`, `versions[].note` | Nonblank name of at most 80 characters; note of at most 1,000 characters (may be empty). |
| `versions[].at` | When the version was taken: a date-time string that JavaScript can parse. Plan writes ISO 8601 in UTC. |
| `versions[].by` | Name of the person who took the version, at most 120 characters. Plan writes it empty; the app ignores any recorded name. |
| `versions[].auto`, `versions[].target` | The Auto-schedule setting and critical-path milestone ID (or `null` for project completion) when the version was taken. A version is shown with the dates it was saved with. |
| `versions[].criticalPath` | Optional method and threshold, with the same rules as `preferences.criticalPath`; absent means total float ≤ 0. Preview, export, restore and copy use the saved version’s choice. |
| `versions[].type` | Optional `baseline`, `status` or `draft` (version 6 only): Agreed baseline, Status update or Draft. |
| `versions[].plan` | The saved plan. It follows the same task, relationship, calendar and ID-counter rules as `project.data` in the enclosing file’s version (4 or 5); collapsed groups are not saved with versions. |
| `nextVersion` | Positive safe integer greater than every `versions[].n`. Numbers of deleted versions are not reused. |

Every saved plan is validated with the same task, relationship and calendar rules before the project opens; one invalid version rejects the whole file. Opening a file adds the project with its versions; the current plan is shown first.

## Preferences and legacy metadata

`preferences.auto` and `preferences.critical` are booleans controlling auto-scheduling and critical-path display. The optional `preferences.criticalPath` object contains `method` (`"float"` or `"longest"`) and `threshold` (a whole number from 0 to 99,999,999 working days). Missing settings mean total float ≤ 0, preserving older files. The threshold is retained but ignored by Longest Path. These are display settings and do not change task dates or calculated slack; they are an optional extension supported in all existing file versions. Opening a project applies these settings to the editor. Saving a read-only shared project writes `auto: false` so its editable copy preserves the published dates.

A selected milestone critical-path target is an app view preference saved separately for each project tab. It is not included in `.plan` files; an opened project starts with **Project completion** as its target. Selecting a target changes float and highlights without moving dates or changing `tasks[].scheduling`. PDF and Excel exports use the selected analysis and identify the target, but importing those exports does not restore the target choice.

`project.rem` is retained solely for compatibility with older files. Email reminders are removed; these fields never schedule or send mail:

- `on` and `auto`: boolean switches. The saved values are recorded in the file, but both become **false** in the opened copy. There is no reminder-enable control.
- `mode`: `task`, `person` or `project`.
- `offsets`: up to eight integer lead times from 0 through 60 days. The app removes duplicates and sorts lead times on load.
- `overdue`: boolean controlling the notice after a missed deadline.
- `hour`: integer send hour from 0 through 23 in local time.
- `subject` and `body`: message strings of at most 200 and 4,000 characters, respectively. Empty or whitespace-only messages use the app's defaults on load.
- `muted`: up to 500 valid email addresses. The app normalizes their case and removes duplicates on load.

## Data kept outside project files

Project files include task owners, contact email addresses, saved project versions and inert legacy reminder metadata. They exclude browser-local file handles and file connection tokens, legacy cloud sharing links and permissions, queued-message records, credentials, undo/redo history, templates, other project tabs, milestone critical-path target choices and app layout settings. The app's `plan.db` backup remains the way to transfer the entire saved workspace and its history.

On the local Windows launcher, file connections and the operation journal live in `%LOCALAPPDATA%\Plan\file-access`, separately from `plan.db` and its backups. The registry includes paths and may temporarily contain staged snapshots; secure it as project data. Connections are scoped to the canonical workspace location and may survive browser changes or server restart on that machine. Moving the database, deleting the registry or changing workspace location requires Open or Save As to reconnect. Browser-local handles from earlier releases cannot be converted to paths. On macOS/Linux and static hosting, browser-local IndexedDB handles remain the fallback; their permissions and lifetime are controlled by the browser. Duplicating a project does not duplicate its connection.

A write is staged beside its destination and compared with the last confirmed bytes and identity before replacement. The journal supports recovery from an interrupted acknowledgement, including newly created files. Plan serializes its own file operations, but unrelated applications do not share that lock and can race the final replacement. The Windows chooser was verified on Windows 10 in Chrome and Edge (Firefox untested); see [testing](testing.md#verification-limits). Injected chooser tests prove orchestration only, not dialog behavior.

The chooser is shown by the Plan server, a background process. After a click in the browser, Windows' foreground lock usually refuses to give it keyboard focus and would leave it behind the browser. Plan briefly moves the chooser into the topmost band so it appears above the browser, asks for focus and flashes it when focus is refused. While a chooser is open, the page shows **Show file window** (raise it again) and **Cancel** (close it as cancelled). Only the operation that opened the chooser can raise or cancel it. Status responses and the diagnostic log report whether the chooser is shown and focused.

Validation and picker behavior are implemented in [projectfiles.js](../src/project_management_tool/web/js/projectfiles.js); regression tests are in [projectfiles.test.mjs](../tests/projectfiles.test.mjs).
