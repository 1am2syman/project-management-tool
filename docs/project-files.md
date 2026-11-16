# Plan project file format

Plan's **Save** and **Save As…** commands write one project to a UTF-8 JSON file with the `.plan` extension. **Open…** reads that file into a new editable project tab. Files are snapshots: later edits are saved to the app's database automatically, and to the project file when you choose **Save** or **Save As…**. In browsers with native file access, Open or Save As connects a project tab to its file so Save can update it. The browser-local handle is separate from the portable document.

See [the README](../README.md#project-files-save-save-as-and-open) for browser support and keyboard shortcuts.

## Versions 1, 2 and 3

The top-level `format` must be `"plan-project"`. This app accepts `version: 1` (everyday scheduling), `version: 2` (project working calendars), and `version: 3` (explicit task scheduling modes). It writes version 3 for nonempty projects, storing each task’s scheduling mode explicitly. Empty projects use version 1 for an everyday calendar with no holidays or version 2 for a configured calendar. Versions 2 and 3 require a valid `project.data.calendar`. Older apps reject unsupported versions instead of dropping scheduling modes or interpreting working durations as elapsed days. Unsupported versions are rejected before the app changes any project. A UTF-8 byte-order mark is accepted when opening a file. The maximum file size is 64 MiB (67,108,864 bytes).

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
| `tasks[].dur` | Integer duration in project working days (calendar days for version 1). A regular task lasts at least one working day. A milestone (`ms: true`) has duration 0. The computed finish is exclusive: one day after the last occupied workday. |
| `tasks[].scheduling` | Optional `"auto"`, `"manual"` or `"anchor"` (version 3). Auto uses the earliest linked date while live Auto-schedule is on; without incoming links it keeps its current date. Manual dates are not moved by dependencies. Anchors may be delayed but are not pulled earlier. An absent mode defaults to Auto, including in older files; enabling Auto-schedule can therefore remove existing gaps. Explicit Manual and Anchor modes are preserved. Summary dates still roll up from children. |
| `tasks[].progress` | Integer percentage from 0 through 100. |
| `tasks[].owner`, `tasks[].email` | Owner display name (at most 80 characters) and email address (at most 254 characters). Both can be empty strings; a nonempty email must pass the app's email validation. |
| `tasks[].noRem`, `tasks[].ms` | Boolean flags for skipping reminders and marking a milestone. |
| `links` | Relationships between existing, distinct tasks. Summary endpoints and dependency cycles are rejected. |
| `links[].id` | Unique ID such as `"l1"`: `l` followed by a positive safe integer without leading zeros. |
| `links[].from`, `links[].to` | IDs of the predecessor and successor tasks. |
| `links[].type`, `links[].lag` | Type: `FS`, `SS`, `FF` or `SF`. Lag is an integer number of working days in the project's calendar; negative lag is allowed. |
| `collapsed` | Array of unique existing task IDs whose groups are collapsed. |
| `nextId`, `nextLink` | Positive safe integer counters greater than the existing task IDs and numeric relationship IDs, respectively. |

Start dates and lag are restricted to −99,999,999 through 99,999,999. Durations are at most 99,999,999, and the exclusive finish must also stay within those date bounds. Computed values such as critical-path flags, float, relationship slack and summary dates are recalculated when a file opens.

The editor allows one relationship per directed task pair. Files containing legacy multiple relationships for a pair retain them for explicit review through **Review relationships**; they are not silently merged or removed.

## Working calendars

Versions 2 and 3 store this object in `project.data.calendar`:

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

## Preferences and reminders

`preferences.auto` and `preferences.critical` are booleans controlling auto-scheduling and critical-path display. Opening a project applies these settings to the editor. Saving a read-only shared project writes `auto: false` so its editable copy preserves the published dates.

`project.rem` contains these reminder settings:

- `on` and `auto`: boolean switches. The saved values are recorded in the file, but both become **false** in the opened copy. Enable reminders in **Remind** when ready.
- `mode`: `task`, `person` or `project`.
- `offsets`: up to eight integer lead times from 0 through 60 days. The app removes duplicates and sorts lead times on load.
- `overdue`: boolean controlling the notice after a missed deadline.
- `hour`: integer send hour from 0 through 23 in local time.
- `subject` and `body`: message strings of at most 200 and 4,000 characters, respectively. Empty or whitespace-only messages use the app's defaults on load.
- `muted`: up to 500 valid email addresses. The app normalizes their case and removes duplicates on load.

## Data kept outside project files

Project files include task owners, email addresses and reminder configuration. They exclude browser-local file handles and file connection tokens, Microsoft sign-in credentials, live OneDrive sharing links and permissions, queued-message records, undo/redo history, templates, other project tabs and app layout settings. The app's `plan.db` backup remains the way to transfer the entire saved workspace and its history.

Native file connections are stored in browser-local IndexedDB and associated with a project tab. They can survive a refresh in that browser, but do not transfer through a `.plan` file or a database backup to another browser/computer. The browser may request file permission again. Duplicating a project does not duplicate its file connection. A tab from an app version that did not retain handles needs Save As once to establish a connection for subsequent Save operations.

Validation and picker behavior are implemented in [projectfiles.js](../src/project_management_tool/web/js/projectfiles.js); regression tests are in [projectfiles.test.mjs](../tests/projectfiles.test.mjs).
