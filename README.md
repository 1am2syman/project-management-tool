# Plan: project sheet + Gantt

Spreadsheet-style task grid on the left, fully draggable Gantt on the right (FS/SS/FF/SF links, critical path,
milestones, quarter/month/week/day views), multi-project sheet tabs, templates, Excel and PDF export, and Microsoft 365
integration (people directory, deadline reminders, read-only sharing). Vanilla ES modules, no build step.

```bash
uv run project-management-tool          # http://127.0.0.1:8000  (or: python3 -m http.server -d src/project_management_tool/web)
```

## Microsoft 365 (optional)

Everything works offline with local storage. To enable the Microsoft 365 features, register the app once:

1. Entra admin centre › App registrations › **New registration** (this organisation only).
2. Authentication › **Single-page application** › redirect URI = the URL shown in *Microsoft 365 › Settings* (it ends in `redirect.html`).
3. API permissions › Microsoft Graph › **Delegated**: `User.Read`, `User.ReadBasic.All`, `People.Read`, `Mail.ReadWrite`, `Mail.Send`, `Files.ReadWrite`, `Files.Read.All`. None of these needs admin consent by default, but your tenant policy may require it.
4. Put the *Application (client) ID* into *Microsoft 365 › Settings*, or into `web/m365.config.json` to pre-fill it for everyone.

No client secret is used. Users sign in with their corporate account in a Microsoft popup; permissions are requested only when a feature first needs them (people search at sign-in; mail when reminders or sharing are first used; files when sharing).

| Feature | How it works |
|---|---|
| **People** | Owner cell type-ahead searches the directory (`/users?$search`, `/me/people`) and stores name + email on the task. |
| **Reminders** | Per project: on/off, **automatic**, granularity **per action item / per person / per project**, lead times, overdue notice, send hour and an editable **message template** (`{{person}} {{task}} {{project}} {{when}} {{deadline}} {{details}} …`, saved templates). Emails are queued in the signed-in user's own mailbox with a deferred-send time (`PidTagDeferredSendTime`), so Exchange Online sends them on schedule even when the app is closed. Sync previews and diffs: stale reminders are cancelled, new ones created. |
| **Read-only sharing** | *Share* publishes a snapshot to the owner's OneDrive (`Plan projects/`) and grants chosen colleagues the **read** role on that file, then emails each a confirmation with a link. Viewers open the link, sign in, and get a read-only sheet they can refresh; the owner can revoke at any time. The permission is real Microsoft 365 access control; the read-only UI is a convenience on top. |

Limits worth knowing: auto-reminders and auto-publish run only while the app is open and signed in (the *scheduled emails themselves* do not need the app); deferred messages sit in the sender's Outbox until due; `Files.Read.All` is needed to open files other people shared with you.

## Tests

Playwright scripts used during development live outside the repo (`/tmp/pwt`); the Microsoft 365 flows were verified against a mocked Graph, not a live tenant.
