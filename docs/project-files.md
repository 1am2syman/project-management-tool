# Plan project file format

Plan's **Save As…** command writes one project to a UTF-8 JSON file with the `.plan` extension. **Open…** reads that file into a new editable project tab. Files are snapshots: later edits are saved to the app's database automatically, and to the project file when you choose **Save As…** again.

See [the README](../README.md#project-files-save-as-and-open) for browser support and keyboard shortcuts.

## Version 1

The top-level `format` must be `"plan-project"` and `version` must be `1`. Unsupported versions are rejected before the app changes any project. A UTF-8 byte-order mark is accepted when opening a file. The maximum file size is 64 MiB (67,108,864 bytes).

This is a complete, valid file containing one task:

```json
{
  "format": "plan-project",
  "version": 1,
  "project": {
    "name": "Example project",
    "data": {
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
          "ms": false
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
| `tasks[].dur` | Integer duration in calendar days. A regular task lasts at least one day. A milestone (`ms: true`) has duration 0. The finish is exclusive: `start + dur`. |
| `tasks[].progress` | Integer percentage from 0 through 100. |
| `tasks[].owner`, `tasks[].email` | Owner display name (at most 80 characters) and email address (at most 254 characters). Both can be empty strings; a nonempty email must pass the app's email validation. |
| `tasks[].noRem`, `tasks[].ms` | Boolean flags for skipping reminders and marking a milestone. |
| `links` | Relationships between existing, distinct tasks. Summary endpoints and dependency cycles are rejected. |
| `links[].id` | Unique ID such as `"l1"`: `l` followed by a positive safe integer without leading zeros. |
| `links[].from`, `links[].to` | IDs of the predecessor and successor tasks. |
| `links[].type`, `links[].lag` | Type: `FS`, `SS`, `FF` or `SF`. Lag is an integer number of calendar days; negative lag is allowed. |
| `collapsed` | Array of unique existing task IDs whose groups are collapsed. |
| `nextId`, `nextLink` | Positive safe integer counters greater than the existing task IDs and numeric relationship IDs, respectively. |

Start dates and lag are restricted to −99,999,999 through 99,999,999. Durations are at most 99,999,999, and the exclusive finish must also stay within those date bounds. Computed values such as critical-path flags, float, relationship slack and summary dates are recalculated when a file opens.

The editor allows one relationship per directed task pair. Files containing legacy multiple relationships for a pair retain them for explicit review through **Review relationships**; they are not silently merged or removed.

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

Project files include task owners, email addresses and reminder configuration. They exclude Microsoft sign-in credentials, live OneDrive sharing links and permissions, queued-message records, undo/redo history, templates, other project tabs and app layout settings. The app's `plan.db` backup remains the way to transfer the entire saved workspace and its history.

Validation and picker behavior are implemented in [projectfiles.js](../src/project_management_tool/web/js/projectfiles.js); regression tests are in [projectfiles.test.mjs](../tests/projectfiles.test.mjs).
