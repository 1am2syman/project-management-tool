# PM tool prototype (sheet + gantt) — current state

## Goal
Minimal modern project-management tool: spreadsheet-look grid (left, per user's screenshot /tmp/moshi-upload-3954638990/image.png) + Gantt (right) with FS/SS/FF/SF links, critical path, milestones, fluid drag/resize. User later asked: compact rows; quarter/month/week/day views; column selector; Excel-style sheet tabs (multi-project); templates save/load; Excel + PDF export; "get reviewed by Opus 5.5 via cliproxyapi high effort and iterate".

## Where
/home/syman/GitHub/project-management-tool/src/project_management_tool/web/  (vanilla ES modules, no build)
 index.html, styles.css, js/{model,grid,gantt,main,dom,dims,sheets,export,xlsx,pdf}.js
Serve: `python3 -m http.server 5173 -d <web dir>` (already running) or `uv run project-management-tool`.
Tests (playwright via /home/syman/.local/share/mise/installs/npm-playwright/latest, chromium /usr/bin/chromium): /tmp/pwt/{dbg,views,cols,sheets,export}.mjs. (agent_browser tool is unusable: version unsupported.)
Git: 4 commits on master; last = "Sheet tabs, templates, Excel + PDF export, data sanitising". Working tree clean at that point.

## Decisions
- Hand-rolled DOM bars (transform) + one SVG link layer + pointer events; no library (Frappe FS-only, SVAR free doesn't schedule, DHTMLX/Bryntum GPL/commercial).
- Calendar-day durations, end exclusive, milestone dur 0; push-only auto-schedule; CPM float vs current schedule (critical = float<=0 and not 100% done).
- Views derived from px/day: quarter<3.8, month<10, week<26, day. Default ppd 16. Density compact(24px rows)/roomy(34).
- Workbook in localStorage 'pm-workbook-v1', templates 'pm-templates-v1', hidden cols 'pm-hidden-cols', sanitize() on load.
- Exports are dependency-free: xlsx.js (hand zip, styled Tasks + cell-painted Gantt tabs), pdf.js (vector A4 landscape). Verified: LibreOffice opens xlsx, qpdf passes pdf.

## Opus 5.5 review (cliproxyapi/claude-opus-5-5, high) — DONE, full text in /tmp/review/out.md
Reviewed HEAD 8c2c153 (before sheets/export). CPM maths verified correct (0/2796 mismatches). 27 findings; to fix, in order:
 H1 frozen cols don't stick (g-body overflow:hidden) | H2 corrupt/blocked localStorage bricks app (partly fixed by sanitize(); still guard main.js pm-gridw access + try/catch load) | H3 narrow bars: resize handles swallow move in quarter/month (add .narrow class when w<24) | H4 origin fixed at first render -> tasks moved earlier vanish | H5 drag frame cost (grid.render rebuilds all HTML; need patch-in-place, keyed link paths, rAF batch, adjacency maps in model)
 M6 blur render eats click | M7 indent silently drops links | M8 unescaped data-id/lag + setHTML runs <script> (use innerHTML/template) | M9 Delete/Backspace deletes task; throws mid-drag | M10 undo mid-drag corrupts history | M11 Day/Month preset shows empty chart (anchor on selection/today) | M12 left-edge origin shift flash (render before scroll adjust) | M13 invisible dots/prog catch clicks | M14 scrollbar click starts pan | M15 no vertical autoscroll during link drag | M16 back-to-back FS links draw loops (enter bar top/bottom)
 L17 date parse accepts impossible dates | L18 formula bar discards on blur | L19 whole-day jumps/tooltip freeze | L20 critical link slack<=0 | L21 undo snapshot incl. collapsed/derived | L22 typed summary start | L23 totals Done unreadable | L24 a11y (global Tab, display:none inputs) | L25 polish (label placement, summary stripe, group label clip, "O" vs 0) | L26 resize/splitter cleanup | L27 second pointer during drag.
Review did NOT cover sheets.js/xlsx.js/pdf.js/export.js -> include in re-review.

## Known open items of mine
- PDF footer "page N of M" text is hard-coded/odd (page numbering per project); not checked on multi-page.
- Earlier "drag moves 5 days instead of 3" was test maths (ppd 16), not a bug.

## Next steps
1. Fix review items in priority order (H1-H5, then M, then L); rerun /tmp/pwt tests after each batch; commit per batch.
2. Re-run Opus review on the new HEAD (prompt at /tmp/review/prompt.md; add sheets/export files; use a separate copy/port so working-tree edits don't confuse it; run via `pi -p --provider cliproxyapi --model claude-opus-5-5 --thinking high --no-session --tools read,grep,find,ls,bash`, ~15-20 min, bg_start + bg_wait on out.md).
3. Final summary to user (concise; flag what's untested).

## UPDATE (after review triage)
Done+committed (batch1, batch2): H1 frozen cols (gx is sole scroller, sticky headers; gantt synced via ctx.syncGantt/syncV), H2/M8 sanitize + DOMParser setHTML + storage guards, H3 narrow bars (--hw), H4/M12 timeline grows left (pendShift), M6,M7(indent refuses),M9,M10,M11(preset anchor),M13,M14,M15,M16(top-entry links),L17,L18,L20,L26(partial),L27; engine adjacency maps. Test: /tmp/pwt/rev.mjs, frozen.mjs, lk.mjs.
STILL OPEN from review: H5 per-frame grid rebuild (patch cells in place / rAF batch), L19 smooth drag, L21, L22, L23 totals Done colour, L24 a11y, L25 polish, PDF page label.
## NEW USER REQUIREMENT (2026-11-15 ~21:50): Office 365 integration
Corporate-ID login (popup) -> fetch people/emails from Microsoft Graph -> owner picker; deadline-based reminder emails to those people.
Design decided: vendor @azure/msal-browser v3 (web/vendor, blank web/redirect.html for popup), config in Settings dialog + optional web/m365.config.json (clientId, tenant). Least-privilege incremental scopes: sign-in = User.Read, User.ReadBasic.All, People.Read; reminders = Mail.ReadWrite + Mail.Send requested at first sync. People: /me, /users?$search (ConsistencyLevel eventual), /me/people for empty query. Reminders: server-side deferred email via POST /me/messages with singleValueExtendedProperty 'SystemTime 0x3FEF' then /send (Prefer IdType=ImmutableId); ledger in localStorage diffed on explicit "Sync reminders" with confirm preview; stale -> DELETE msg; Send-test-to-me button. Task gets `email` field; Email column hidden by default. Test with mocked Graph via playwright route + window.__pmAuth backdoor. Cannot verify against a real tenant (needs Azure app registration) - tell the user clearly.
Files: js/m365.js (auth+graph), js/people.js (directory + picker), js/reminders.js (rules, plan, ledger, dialog).

## UPDATE 3 (M365 + reminders + sharing built, mock-tested)
User added requirements: (a) Office 365 login + people from Graph + deadline reminder emails; (b) per-project auto reminders, granularity per action item / per person / per project, editable message template; (c) read-only sharing to granted users with confirmation email.
Built (uncommitted at time of writing; commit next): js/m365.js (MSAL v3 vendored in web/vendor, redirect.html, m365.config.json, Graph client, deferred mail 'SystemTime 0x3FEF', OneDrive publish/invite(read, sendInvitation:false)/permissions/fetchShared, deep link #open=), js/people.js (picker), js/m365ui.js (button/menu/settings), js/reminders.js (plan/diff/ledger 'pm-rem-ledger-v1', modes, templates 'pm-rem-templates-v1', auto sync debounced 12s, silent), js/sharing.js (Share dialog, grant email, viewer read-only sheet via store.importShared, banner #robanner). model.js: email/noRem on tasks, sheet.rem/share/source/readOnly, tx() guard emits 'denied'. CSS appended to styles.css.
Mock harness: /tmp/pwt/mock.mjs (fake Graph) + /tmp/pwt/m365.mjs (end-to-end, 2 browser contexts). Run: `cd /tmp/pwt && node m365.mjs`. Last run all green except: mock bug in permission DELETE path parsing (use parts[4], parts[6]); picker empty-query list showed [] (timing? verify); 'denied' toast in viewer didn't show (check main.js store.on replace applied).
Cannot test against real tenant: requires Azure app registration (clientId) — tell user. Client-side read-only is UX; real enforcement = OneDrive read permission.
Next: fix the 3 items above, add tests for sheets tab lock icon (optional), rerun all /tmp/pwt suites, commit, update README with M365 setup, then re-run Opus review (include new files), then final summary.

## UPDATE 4 (committed a997da6)
All 3 mock-test items fixed (mock perm DELETE parse; click-count e.detail>=2 edit start in grid.js; people picker `touched` flag; sheet tab lock icon). README written with M365 setup. Committed a997da6. Opus review #2 of a997da6 running as bg job opus-review-2-e8a2, output /tmp/review2/out.md (copy of HEAD at /tmp/review2, server :5175). Next: triage findings, fix verified ones, rerun /tmp/pwt suites (dbg views cols sheets export frozen rev m365), commit, final summary (flag: not tested on real tenant; needs Azure app registration clientId; open items H5/L19/L21-25).

## UPDATE 5 (committed): two new features done
1. Focus mode: store.related(id) (anc/desc/up/down chains + link sets); ctx.rel/relClass in main.js; classes r-self/r-anc/r-desc/r-up/r-down/dim on rows, bars, links; #optFocus switch (pm-focus), #focusleg legend. Test /tmp/pwt/focus.mjs.
2. Import: js/xlsxread.js (zip+XML reader, csv), js/import.js (mapSheet header aliasing, preview dialog, drop anywhere, template download), xlsx.js buildTemplate (+dataValidations, pack()). Tests /tmp/pwt/imp.mjs (template + own-export round trip identical), imp2.mjs (messy CSV). #impbtn in toolbar. README updated.
Still pending: Opus review #2 (job opus-review-2-e8a2, /tmp/review2/out.md) of a997da6 — triage on wake; this commit is newer than what it reviews. Final summary after triage.
