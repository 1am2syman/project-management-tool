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
