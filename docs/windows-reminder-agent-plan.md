# Windows background reminder agent: retired plan

Status: **cancelled and out of scope** at the project owner's request. Microsoft 365 integration is removed from Plan because the solo developer does not have the Entra access needed to provision and support it. This is a scope decision, not an outstanding authentication or release blocker.

The former implementation proposed native Microsoft sign-in, delegated email sending, a Windows Task Scheduler worker, retries/catch-up and migration of deferred Outlook mail. Those components, browser integration, control APIs, dependency bundles and integration-only tests have been removed. The previous proposal remains available in Git history.

## Current product scope

- Local project planning, hierarchy, dependencies, working calendars, critical paths and slack.
- SQLite automatic saves and history, local project tabs and templates.
- `.plan` files, Excel/CSV import and Excel/PDF export for exchanging work through tools chosen by the user.
- Manually entered owners and optional contact email addresses, with suggestions from the current workbook only.
- No account, tenant configuration, Entra registration, directory access, email submission, OneDrive operations or background reminder task.

## Compatibility and retirement

Keep existing user databases, project files and the original bundled Windows runtime intact. Legacy reminder/sharing fields may be retained as inert metadata to preserve older formats. Older read-only snapshots remain inspectable and can be copied locally for editing. No legacy settings trigger sign-in, scheduling, cloud refresh or mail sending.

Removal does not recall mail already submitted to an external service, revoke existing cloud permissions or automatically remove a scheduled task installed by an older version. See [retirement notes](native-reminders.md). No live tenant or Windows-mail acceptance is required for the local-only application.

## Acceptance criteria for this scope change

- [x] No Microsoft sign-in, email reminder or cloud-sharing controls or network paths remain in the app.
- [x] Normal Windows launch performs local startup only; no native auth dependency or scheduled-task setup remains.
- [x] Existing local projects, owner/email data, file formats and read-only snapshot recovery continue to work.
- [x] Local persistence, planning, file and diagnostics checks pass with the bundled Windows runtime preserved.
- [x] Documentation consistently describes local-only behavior and treats the former integration as retired.

Verification commands and platform limits are maintained in [testing.md](testing.md).
