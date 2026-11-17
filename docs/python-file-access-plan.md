# Python-managed project file access: implementation plan

Status: implemented for Windows 10/11 x64. Real-chooser verification passed on Windows 10 in Chrome and Edge; Firefox and network-share destinations remain untested (see [testing](testing.md#verification-limits)). macOS/Linux native adapters are not implemented.

Implementation choices: a single registry-wide cross-process lock serializes all Plan file commits, including aliases and newly created destinations. Captured save snapshots are temporarily stored as bounded raw bytes in the local registry so a refreshed page can reconnect to a pending chooser; this is sensitive local project data. Terminal journal entries are retained for up to 30 days and 1,000 entries; provisional ready selections are retained for seven days, with at most 20 unfinished operations. Uncertain writes are not expired. Connection records are conservatively retained because workspace history and undo can reference them. An unresolvable legacy connection on a read-only or stale project is refused as a copy destination until reconnected because its original path cannot be compared safely.

## Goal and first-release scope

Make `.plan` Open, Save and Save As use the local Python process on Windows 10/11 x64. The browser remains the UI and project parser; Python owns the OS chooser, file reads/writes and persistent file connections. Chrome, Edge and Firefox use the same local API without File System Access API permissions or IndexedDB file handles.

Use the existing bundled Python standard library and Windows APIs through `ctypes`. Keep the bundled runtime unmodified; do not introduce Tkinter, Electron, pip installation or startup downloads. Implement Windows first. macOS/Linux adapters are a subsequent feature; those platforms and static hosting retain the existing browser implementation. Capability selection must describe this scope accurately.

The reported failure happened before Chrome returned a file handle. Moving that boundary into Python removes that browser API from the local Windows flow; it does not establish the original OS/browser rejection's exact cause or guarantee that every filesystem is writable.

## Existing integration points

- `src/project_management_tool/__init__.py`: loopback `ThreadingHTTPServer`, HTTP routing, startup/shutdown and runtime diagnostics. Existing POST origin checks need a stronger, explicit contract for the new file-access routes.
- `web/js/projectfiles.js`: file format versions 1–4, validation, Open/Save orchestration, stale/read-only restrictions, file conflict checks and uncertain-write handling.
- `web/js/filebindings.js`: current browser IndexedDB handle storage; retain for the browser adapter.
- `web/js/storage.js`: optimistic SQLite revisions and save reconciliation. It currently exposes no awaitable save barrier or revision accessor; add these for native operations.
- `web/js/model.js`: per-sheet `fileToken`, sanitization and duplication behavior. Keep connections outside portable `.plan` documents and ensure copies remain disconnected.
- `persistence.py`: workspace storage and revision checks. Existing `plan.db` schema/version can remain unchanged if connection records are kept in separate local storage.

All `web/js/` paths above are under `src/project_management_tool/`.

## Architecture

```text
Browser UI + existing project validation
             |
       same-origin local API
             |
Python operation coordinator + persistent connection registry
             |
Windows dialog adapter             bounded file reads / checked writes
```

Add `native_dialogs.py` for Windows interaction and `project_files.py` for operations, connections and file I/O. Add `web/js/localfiles.js` for the API client. Keep OS details out of project validation and HTTP routing.

Use Windows Common Item Dialogs (`IFileOpenDialog`, `IFileSaveDialog`) through `ctypes`, with `.plan` filters, a default extension, an initial folder and a suggested Save As name. Validate this minimal adapter using the bundled interpreter before building the rest of the integration.

Run dialogs on a dedicated COM STA worker with a managed owner window/message loop. Manage COM initialization, HRESULTs and resource release on that thread. Show one chooser at a time per server; a second request receives an explicit busy result. Dialogs must appear in front when allowed, remain reachable through normal desktop navigation and close cleanly on server shutdown. Do not attach to, restart or close the user's browser.

HTTP handlers return operation IDs promptly. Status polling lets the page remain responsive while the user browses folders; ordinary fetch timeouts must not cancel a native dialog or cause another to open. Use bounded polling with backoff while an operation is pending. Refresh can reconnect to an existing operation.

## Local API and operation contract

Proposed routes; names may be refined during implementation without changing these semantics:

| Route | Purpose |
|---|---|
| `GET /api/file-access` | Protocol version, availability and authenticated local-session bootstrap. Does not open a dialog or initialize project storage merely for diagnostics. |
| `POST /api/file-operations` | Start Open, choose a Save As destination, or prepare Save to an existing connection; require a client operation ID for deduplication. |
| `GET /api/file-operations/{id}` | Read stage/result; never start or repeat work. |
| `GET /api/file-operations/{id}/content` | Retrieve bounded UTF-8 contents from the selected Open operation. |
| `POST /api/file-operations/{id}/attach` | After successful validation/application and workspace persistence, associate an Open result with its new sheet. Idempotent. |
| `PUT /api/file-operations/{id}/content` | Submit an encoded project snapshot for the already-authorized Save destination; write once and record its outcome. |
| `POST /api/file-operations/{id}/release` | Release unused selection/staged resources after validation failure or abandonment; never undo a completed write. |

Use explicit stages such as `choosing`, `selected`, `reading`, `ready`, `writing`, `succeeded`, `cancelled`, `conflict`, `failed` and `outcome_unknown`. Cancellation is a successful operation result with no mutation, not a generic error exception. Return stable error codes and safe messages for permission denial, missing files, busy chooser, encoding errors and unsupported environments.

Keep file payloads as raw UTF-8 bodies, with small JSON control messages. Enforce 64 MiB on actual bytes, using bounded reads even when file metadata claims a smaller size. Avoid JSON-wrapping the full contents, which can exceed the existing request limit through escaping. Preserve current BOM handling and validate malformed UTF-8 explicitly.

Require the allowed loopback Host, exact app Origin for browser mutations and a server-issued session credential in a custom header. Protect content/status routes too; disable caching and CORS. Reject foreign origins, arbitrary Host headers, path parameters masquerading as file selections, unknown IDs and IDs from another workspace/session. Do not put session credentials or file paths into URLs, diagnostics or console logs. Read-only capability discovery must not grant another website usable file access.

Session credentials expire at server restart. Persistent connections are separate from session authorization; a refreshed/new browser obtains authorization only through the local app. An operation ID is not by itself authorization.

## Open behavior

1. Start a native Open operation immediately from the explicit action, with the app recording its stage. No browser picker is invoked.
2. Python returns the selected file's contents and a provisional connection ID after bounded reading. Selecting Cancel returns `cancelled` without changes.
3. The frontend runs the existing `parseProjectFile`/`openProjectFile` validation and applies the saved scheduling preferences exactly as today. Invalid files add no sheet and create no active connection.
4. Persist the new sheet and attach the provisional connection to that sheet using an acknowledged workspace revision. Distinguish an imported project from a successfully persisted file connection if storage fails at this stage; do not repeat the import on retry.
5. Opening still adds a project rather than replacing existing projects; reminders start off and saved versions survive.

Keep exact read bytes/fingerprints for conflict checks separately from any text normalization. Changing a BOM during decoding must not make an untouched file appear externally modified.

## Save and Save As behavior

- Capture and validate the intended sheet's encoded snapshot before awaiting any dialog. Switching sheets or entering a version preview while the dialog is open must not change which content is written. Later edits remain later edits; report completion for the captured snapshot.
- Save resolves a Python connection; an unconnected project follows Save As. Save As asks for a destination and performs Windows overwrite confirmation before any write.
- Before committing, verify the connection's sheet/workspace, the acknowledged workspace revision, current stale/read-only restrictions and the last-confirmed destination fingerprint. Add an awaitable `storage` barrier to flush pending app state and expose its acknowledged revision; recheck after the chooser returns. A failed/conflicted barrier prevents overwriting a connected file.
- Preserve the existing restriction on connected Save from read-only/stale projects. They may export a separate copy; explicitly close the current Save As gap by refusing their connected source as that destination too. Resolve path aliases sufficiently to enforce this rule; test junction/symlink and case aliases explicitly.
- Write to a sibling temporary file, flush, and commit using the appropriate Windows replacement operation. Fail safely if replacement is unavailable; never fall back to truncating the destination in place. Confirm the committed bytes before advancing the connection fingerprint. Test permissions/metadata and cloud/network filesystem behavior rather than assuming replacement is equivalent everywhere.
- Recheck an existing Save As target at commit against the file the user confirmed. If another program changes it after confirmation, stop and require renewed review. Serialize writes to the same destination across app tabs and processes. Coordinate the short revision-check/file-commit interval with workspace writes; never hold a workspace transaction while a chooser is open.
- External applications do not share Plan's locks. State the residual external-write race honestly and use Windows sharing/identity checks where supported; do not claim universal atomic compare-and-swap across every filesystem.
- Record the intended write durably before commit, including operation ID, destination identity, previous fingerprint and proposed fingerprint. After disconnect/restart, reconcile actual bytes before retrying: proposed bytes mean the write completed; previous bytes mean it did not; other bytes mean conflict. Include newly created destinations and Save As, not only connected Save.
- Never reopen a chooser or repeat a write merely because a response was lost. A failed connection update after a successful file write is a distinct recoverable result, not “nothing saved.”

## Persistent connections and migration

Store connection records and the bounded operation journal in a separate SQLite database under the user's local app-data directory, outside Documents/Plan and its normal workspace backups. Namespace records by the canonical workspace location. Store an opaque connection ID, sheet association, selected path, file identity, last-confirmed fingerprint and recovery metadata. Access paths only through these records, never from client-supplied filenames.

Use a distinguishable local-token namespace compatible with `model.js`'s existing 100-character limit. Store only that token in the sheet. A same-machine browser change or server restart resolves the connection; exporting a `.plan`, duplicating a sheet or moving `plan.db` to another machine does not grant file access. Missing local connection storage or a changed workspace location requires explicit reconnection.

Existing browser handles cannot be converted to filesystem paths. Preserve them for browser mode. In local Windows mode, explain once that an old connection needs Open or Save As to reconnect; never infer a path from the project name or silently overwrite a guessed file. Do not delete IndexedDB records as part of rollout.

Define bounded journal retention and cleanup of expired provisional selections, orphaned bindings and temporary files. Never expire an active dialog or remove evidence needed to reconcile an uncertain write. Garbage collection must account for sheet undo/history references and must never delete the user's `.plan` files.

## Frontend integration and diagnostics

Select the backend from an explicit, versioned capability response, not user-agent sniffing. Native available means Python is the primary path even when Chrome exposes `showOpenFilePicker`. Static hosting or a declared unsupported OS selects the existing browser implementation. A network error or native runtime failure is not “unsupported”; show the error and do not silently switch after work may have started.

Separate shared project encoding/validation from the transport adapters. Preserve shortcuts and edit-commit behavior. Lock only the relevant file actions; Log remains usable while a chooser is open. Report cancellation quietly, actual failures visibly, and connection recovery separately from import/write success. Availability and connection status should reflect resolvable connections rather than merely a truthy `fileToken`.

Extend the existing diagnostics with backend, operation stage, duration, cancellation, safe OS error code and reconciliation outcome. Keep capture before the main module graph. Export enough correlated backend events to distinguish dialog failure from read, validation, commit or connection failure. Continue excluding file paths/names, contents, fingerprints, credentials and typed input from exported logs.

## Implementation sequence and verification gates

1. **Windows adapter feasibility.** Implement the minimal isolated chooser interface and exercise real Open/Save As/Cancel with bundled Python. Prove Unicode paths, ownership/focus, overwrite prompts, repeated use and shutdown before treating the adapter as viable.
2. **Connection and I/O service.** Implement the local registry, operation journal, bounded reads, checked writes, serialization and restart reconciliation. Test with temporary directories and injected dialog results. Gate: failures preserve the original file and retries cannot duplicate writes.
3. **HTTP integration.** Add capability/session handling and operation routes; verify origin/Host/session rejection, payload limits, deduplication, concurrent requests and startup/shutdown. Gate: foreign requests cannot read files, trigger dialogs or write destinations.
4. **Frontend integration.** Add the local adapter and storage barrier, then route Open/Save/Save As through it. Gate: no browser file API or IndexedDB access is needed on the Python path; format validation, duplicate/copy rules, read-only behavior and version semantics remain intact.
5. **End-to-end and recovery.** Test lost start/status/write/attach responses, browser refresh/closure, server restart, two tabs, two processes, external edits, missing destinations, locked files, Save As to the source, disk/write failures and connection-store failures. Gate: each outcome is accurately reported and uncertain mutations are reconciled before retry.
6. **Real Windows browser matrix and documentation.** Run actual OS chooser tests in Chrome, Edge and Firefox with isolated profiles/database/files. Cover normal Open/Save/Save As, cancellation, Unicode/space paths, existing-target replacement, external conflicts, browser switching and server restart. Include the originally reported file/location when available. Update README, project-file docs, testing guide and local connection-store backup/privacy notes.

Add focused Python suites (`test_native_dialogs.py`, `test_project_files.py`, `test_file_api.py`) and extend `projectfiles.test.mjs`, persistence and diagnostics tests. Extend browser coverage with an isolated local-API suite; supplied chooser results prove orchestration only. Run the maintained Python and JavaScript regression commands from `docs/testing.md`, plus affected browser suites.

Manual Windows evidence is a release gate. Linux tests, mocked dialogs and browser-supplied handles cannot establish that this implementation fixes the affected Windows flow. If Windows is unavailable during implementation, finish everything verifiable and report that gate explicitly as pending; do not claim Windows support has been validated.

## Completion criteria

- Local Windows Open, Save and Save As work across the three target browsers without browser file-access APIs.
- Connections survive refresh, browser changes and server restart on the same workspace/machine.
- Cancellation, invalid documents and failed/uncertain writes have distinct, accurate outcomes without unintended project/file changes.
- Existing external-edit, read-only/stale, version and duplication protections remain covered.
- The offline bundled-runtime launch remains unchanged; browser/static fallbacks remain usable.
- Real Windows chooser evidence and automated regression results are recorded, and docs describe the shipped behavior and remaining platform limitations.
