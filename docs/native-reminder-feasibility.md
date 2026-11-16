# Native Windows reminder feasibility runbook

This is the first milestone of [the implementation plan](windows-reminder-agent-plan.md). It is an opt-in maintainer harness, not the production reminder scheduler. Normal `start.bat`, browser reminders, people search and sharing retain their existing behavior. The native worker never reads or initializes `plan.db`, schedules project mail, cancels legacy mail or assumes ownership of a project.

The full feature is blocked on a maintainer-provisioned Microsoft application registration and the required Windows/corporate-account feasibility checks. The deployment's `clientId` is intentionally empty: there is no registered application to distribute yet. Do not invent an ID, reuse an unrelated application's ID or move secrets into this repository. The remaining planner, delivery/retry/catch-up engine, shared people/OneDrive operations, normal-launch setup and legacy migration are outstanding; do not enable production ownership until their gates pass.

## Maintainer application provisioning

Create an Entra **public desktop client** registration owned by the deployment maintainer. Add the **Mobile and desktop applications** redirect `http://localhost`. MSAL's system-browser authorization-code flow supplies PKCE and an ephemeral loopback listener. Do not configure or distribute a client secret. Do not use the existing browser-only SPA registration unless its owner explicitly configures and approves native desktop use.

Ship the non-secret deployment values in `src/project_management_tool/reminder_agent/deployment.json`:

- For one organization, use `audience: "single-tenant"` and that organization's tenant GUID in `tenant`.
- For organizational accounts across tenants, use `audience: "organizations"` and `tenant: "organizations"`. Configure the registration for organizational accounts in any directory, and complete publisher verification and organization-consent preparation as applicable.
- Put the actual public application GUID in `clientId`. Consumer accounts, arbitrary authority URLs, secrets and browser-supplied registration overrides are rejected by this implementation.

The harness requests delegated **User.Read** and **Mail.Send** together. MSAL supplies its protocol scopes for refresh. Neither application-wide Mail.Send nor Mail.ReadWrite is used. Future people/OneDrive and legacy-inspection features must request their additional delegated permissions interactively when needed.

Delegated Mail.Send does not inherently require administrator consent, but tenant consent policy, application assignment, publisher restrictions or Conditional Access can require organization approval. This checkout has not exercised an organization's approval path. Record the actual tenant restrictions and granted scopes during the live test. Windows application-control and Task Scheduler policy also apply. Never use elevation, another user's identity, stored Windows passwords, SYSTEM or S4U to work around a denied registration.

## Bundled dependencies and provenance

`runtime/native-auth/windows-x64/` contains the pinned MSAL Python distribution, its transitive dependencies, upstream distribution metadata and licenses. The binary wheels target ordinary CPython 3.14 x64, matching the bundled runtime. `tools/native-auth-wheels.json` records each exact PyPI URL and SHA-256. The bundle's `manifest.json` records every extracted file hash. Preserve license and NOTICE files alongside the packages, including the cryptography, requests and certifi license materials.

Git attributes preserve this bundle byte-for-byte, including upstream text line endings, so its checksums remain valid with Windows `core.autocrlf` settings.

The source bootstrap explicitly imports from that release directory. It does not enable `site`, alter the upstream `python314._pth`, invoke pip, download packages, create a virtual environment or depend on Node. Normal local project startup does not import MSAL. Using a different Python version for native Windows operations produces an explicit runtime incompatibility status.

Maintainer-only reproduction with an existing development Python:

```sh
python3 -B tools/vendor_native_auth.py
python3 -B -m unittest discover -s tests -p 'test_reminder_*.py' -v
```

The first command downloads only the locked artifacts, verifies each archive hash before extraction, and rebuilds the separate native-auth bundle. It is never called by the launcher. To intentionally update dependencies, edit `tools/native-auth-requirements.in`, resolve for Windows with `uv pip compile tools/native-auth-requirements.in --python-version 3.14 --python-platform x86_64-pc-windows-msvc --only-binary :all: --no-header --no-annotate -o tools/native-auth-requirements.txt`, then run `python3 -B tools/vendor_native_auth.py --refresh-lock`. Review changed versions, PyPI provenance, dependency metadata, hashes and licenses before distributing the rebuilt bundle. Run its actual Windows import test offline.

## Isolated Windows test

Use a separate folder copy/checkout, a dedicated corporate test mailbox and an explicit, new data directory. Do not use Documents/Plan, a working database, a production Microsoft account or an existing deferred-message queue. Run as an ordinary standard Windows user without an elevated shell.

From PowerShell in that isolated checkout:

```powershell
$probeData = Join-Path $env:TEMP 'Plan native feasibility Ω & (test)'
.\start.bat --reminder-feasibility --data-dir "$probeData" --port 5187
```

After updating this milestone, stop and restart the local server with the flag below, then refresh the test page so both the Python backend and browser script use the updated version. Stop/remove any old test task before updating its source, then install/repair it from the updated page.

The explicit flag opens `/reminder-feasibility.html`. Without it, the native control endpoints return 404. The flag requires an explicit data directory; the worker has a separate task-name namespace and private profile. These commands are test preparation for maintainers, not the intended end-user setup flow.

1. With networking disabled, open the page and choose **Install / repair test task**. Confirm that the task starts without a console or password prompt, and the heartbeat appears. An actual access-denied HRESULT must show device-policy blocking. Other registration errors must remain distinct; do not label them installed or try elevation.
2. Inspect the task in Windows Task Scheduler: current user's SID, InteractiveToken, LeastPrivilege, one user-logon trigger, no boot trigger, IgnoreNew instances, no execution time limit, restart interval one minute/count ten, battery execution allowed, no network prerequisite and WakeToRun disabled. Record the actual task XML/result and OS/account policy observations.
3. Restore connectivity. Choose **Connect / reconnect Microsoft 365**. Complete Microsoft's sign-in/MFA/consent page. Record any organization approval requirement without copying credentials, tokens or raw OAuth responses into the test report. Confirm that the account shows both the login UPN and the primary mailbox address where these differ.
4. Choose **Queue one test email to my mailbox**. Close the browser and stop the local server immediately. Leave Windows awake, signed in and online. The separate task checks at startup and approximately every minute. It sends the fixed feasibility message only to Graph's reported primary mailbox through `/me/sendMail`, with Sent Items enabled and no From override. No Outlook process is required.
5. Verify actual receipt, sender, timestamp and Sent Items. A 202 is recorded as **accepted**, never delivered. Restart the isolated server to inspect activity. Repeat with the session locked and on battery; repeat after terminating/restarting the worker and after sign-out/sign-in. Check silent authorization reuse and organization-required interaction accurately.
6. Test offline/online and sleep/resume around an explicitly queued test. These one-shot probes expire after one hour; they do not implement the future seven-calendar-day project catch-up policy. An uncertain, submitting or pending probe blocks another queued probe. No background retry opens a sign-in page.
7. Request a native disconnect and verify that queued work fails without sending and local authorization clears even offline. Attempt to reconnect as another account: the original source binding must prevent silent sender reassignment. Production project rebinding is not implemented in this milestone. The original browser connection remains a separate legacy connection until the later integration cutover.
8. Repeat task installation and verify no duplicate definition or process. Move the isolated repository while keeping the same data directory, restart the isolated server and choose install/repair. Verify the same task identity uses the new absolute paths and only one worker remains. Source changes stop the old worker before its next submission; stop/remove before pulling updates, then install/repair with the updated source.
9. Choose **Stop and remove test task** before ending the test or deleting the isolated checkout. Verify the task disappears, its process stops and a manually started instance exits on the pause marker. Removal retains test history and does not recall accepted/in-flight mail.

The CLI supports the same fixed operations if a maintainer needs to diagnose the page:

```powershell
.\runtime\windows-x64\python.exe -B .\reminder-agent.py status --data-dir "$probeData"
.\runtime\windows-x64\python.exe -B .\reminder-agent.py remove --data-dir "$probeData"
```

The task itself uses `pythonw.exe`, absolute paths and an encoded source version. Manual `run` requires the expected source version; install through the harness instead of constructing task arguments yourself.

## Private state, recovery and boundaries

Private native state is scoped to the Windows user and the normalized absolute data-directory path at `%LOCALAPPDATA%\Plan\Reminders\<data-directory-id>\`. Directory permissions are replaced with a protected current-user DACL. The shared MSAL cache, selected profile and immutable account binding are atomically saved in `connection.dpapi` using current-user DPAPI with UI forbidden. Backend and worker load it only under a cross-process OS lock. There is no plaintext credential fallback. A native disconnect clears authorization while retaining the account binding.

`feasibility.sqlite3` holds one-shot test attempts and non-secret correlation IDs separately from project storage. Claims are transactional; a singleton OS lock excludes a second worker. A crash after claim or submission produces an uncertain record on restart. A timeout after sending begins and an ambiguous server response also remain uncertain. Nothing automatically replays these tests. Review the mailbox and retain the evidence before starting a new explicitly isolated test profile. This harness does not provide production uncertain-send resolution or legacy cancellation.

`feasibility-health.json` records the heartbeat/source status; `feasibility-error.json` records a bounded startup/runtime failure code and message when windowless execution cannot write to a console. The page shows paused/stopped/stale/source-changed states and directs the maintainer to local failure evidence. OAuth descriptions, tokens, Graph response bodies and exception details are excluded from these status files. Corrupt/unreadable protected state is preserved and sending is blocked; do not delete it to guess away a binding or unknown submission outcome.

Copying `plan.db` does not copy native credentials or test delivery history. Moving the *repository* with the same data directory supports task repair. Moving the *data directory* selects a new identity and requires removing the old task first. Copying projects to another computer is outside one-laptop deduplication and must not create a second active sender. Updates/removal cannot recall a message after its final authorization/pause validation and submission to Exchange.

## Recorded verification and release gate

Linux automated tests cover protected-state coordination with a test-only protector, immutable account/tenant/Graph binding, alias differences, offline disconnect, silent-only authorization, consent/device policy classification, Graph accepted/throttled/uncertain outcomes, task XML and encoded arguments, idempotent repair, claims, interruption recovery, schema rejection, stale probes, source fencing, singleton execution, local-origin restrictions, request allowlisting, and bundle file hashes/licenses/PE architecture.

Windows-only tests exercise actual bundled-interpreter native imports and current-user DPAPI. They are skipped on Linux. No Windows Task Scheduler execution, corporate sign-in, live mailbox submission, actual receipt or organization approval path has been verified in this implementation environment. No production account, reminder queue or project database was used.

The phase-one live gate remains unresolved. Even after it passes, the full plan requires deterministic JavaScript/Python project-planner parity, production occurrence history/retries/catch-up, native people/OneDrive integration, automatic normal-launch setup and resumable legacy-message migration. The existing scheduler cannot be replaced or described as native background support until those checks pass.
