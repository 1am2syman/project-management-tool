# Microsoft 365 retirement notes

Microsoft 365 integration and Windows email reminders are out of scope and removed. Plan is a local application with no Microsoft login, directory calls, mail submission, OneDrive operations or automatic background task setup. The [former reminder plan](windows-reminder-agent-plan.md) is retired; Entra access is no longer a release requirement.

Owner names and email addresses remain local task data. Existing databases and `.plan` files stay readable; old reminder/sharing settings are inert compatibility metadata. Older read-only snapshots can be viewed and copied locally, without cloud refresh. Use `.plan` files or Excel/PDF exports to exchange projects through your own tools.

## Earlier installations

This change removes repository code and dependencies. It does not delete user databases, browser profiles or private authentication/delivery history. No live Windows task or mailbox was configured during this development session.

If an earlier version was independently configured elsewhere:

- Close its old browser windows and stop its server/worker before using the updated app.
- Remove its Plan reminder task in Windows Task Scheduler. Previous task names used `Plan.Reminders.<user-SID>.<data-directory-id>` or `Plan.ReminderFeasibility.<user-SID>.<data-directory-id>`. Verify the specific task before removing it.
- Mail already submitted or queued in Exchange is outside the local app. Inspect it in Outlook or your organization's supported mailbox tools; updating Plan does not cancel or recall it.
- Existing OneDrive sharing permissions also remain outside Plan. Manage them through OneDrive if needed.
- Private native state from an earlier version may remain under `%LOCALAPPDATA%\Plan\Reminders\`. Preserve any uncertain submission evidence before choosing to remove that profile yourself. The updated app does not read or migrate its credentials.

These are retirement notes for previously configured installations, not setup requirements for current users. The original bundled interpreter at `runtime/windows-x64` remains included for offline local startup.
