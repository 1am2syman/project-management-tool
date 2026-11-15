// Deadline reminders. Per project: switch on, choose the granularity (one email per action item, per person, or per
// project), the lead times, and the message template. Emails are scheduled in the signed-in user's own mailbox with a
// deferred-send time, so Exchange Online delivers them on time even when this browser is closed. A sync diffs what
// should exist against what was scheduled before: stale reminders are cancelled, new ones created. With "auto" on, a
// silent sync runs shortly after every change to that project.
import { DAY, REM_TPL, ymd } from './model.js';
import { esc, openModal, setHTML } from './dom.js';
import * as m365 from './m365.js';

const LEDGER = 'pm-rem-ledger-v1', TPLS = 'pm-rem-templates-v1';
const OFFSETS = [14, 7, 5, 3, 2, 1, 0];
const AUTO_CAP = 60, SYNC_CAP = 300;
const BUILTIN_TPL = [
  { id: 'default', name: 'Default', subject: REM_TPL.subject, body: REM_TPL.body },
  { id: 'short', name: 'Short & direct', subject: '{{task}} {{when}}', body: '{{person}}, {{task}} ({{project}}) is {{when}}.\n\n{{details}}' },
  { id: 'formal', name: 'Formal', subject: '{{prefix}} notice: {{task}} ({{project}})', body: 'Dear {{person}},\n\nThis is an automated notice from {{sender}} regarding the project "{{project}}".\n\n{{details}}\n\nPlease update the project plan or contact {{sender}} if the schedule needs to change.\n\nKind regards,\n{{sender}}' },
];
export const VARS = [['person', 'First name (or "team")'], ['task', 'Task name or "N tasks"'], ['project', 'Project name'], ['when', 'due tomorrow, due in 3 days…'], ['deadline', 'Deadline date'], ['prefix', 'Reminder / Overdue'], ['count', 'Number of tasks'], ['sender', 'Your name'], ['details', 'Table of task details']];

const jget = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } };
const jset = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } };
const readLedger = () => { const l = jget(LEDGER, {}); return l && typeof l === 'object' && !Array.isArray(l) ? l : {}; };
const dayName = (d) => new Date(d * DAY).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const atHour = (day, h) => { const [y, m, d] = ymd(day); return new Date(y, m, d, h, 0, 0, 0).getTime(); };
const when = (ts) => new Date(ts).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const first = (n) => String(n).split(/\s+/)[0];
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ---------- planning (pure; exported for tests) ----------
function relText(e) {
  if (e.kind === 'overdue') return `overdue since ${dayName(e.deadline)}`;
  return e.offset === 0 ? 'due today' : e.offset === 1 ? 'due tomorrow' : `due in ${e.offset} days`;
}
const tplHash = (r) => `${r.subject}\u0001${r.body}`;

export function buildPlan(store, now = Date.now(), only = null) {
  const out = { items: [], skipped: { noEmail: [], past: 0, muted: 0, noRem: 0 }, sheets: [] };
  for (const sh of store.wb.sheets) {
    const rem = sh.rem; if (!rem || !rem.on || sh.readOnly || (only && !only.includes(sh.id))) continue;
    const st = store.view(sh.id), muted = new Set(rem.muted); out.sheets.push(sh.id);
    const events = []; // one per (task, trigger)
    for (const t of st.tasks) {
      const f = st.info.get(t.id); if (f.summary || t.progress >= 100) continue;
      if (t.noRem) { out.skipped.noRem++; continue; }
      if (!t.email) { if (t.owner) out.skipped.noEmail.push({ sheet: sh.name, task: t.name, owner: t.owner }); continue; }
      if (muted.has(t.email.toLowerCase())) { out.skipped.muted++; continue; }
      const deadline = t.ms ? t.start : f.end - 1, base = { taskId: t.id, task: t.name, owner: t.owner || t.email, email: t.email.toLowerCase(), deadline, progress: t.progress };
      const trig = [...rem.offsets.map((o) => ({ kind: 'before', offset: o, day: deadline - o }))];
      if (rem.overdue) trig.push({ kind: 'overdue', offset: 0, day: deadline + 1 });
      for (const g of trig) { const sendAt = atHour(g.day, rem.hour); if (sendAt <= now) out.skipped.past++; else events.push({ ...base, kind: g.kind, offset: g.offset, sendAt }); }
    }
    // group into emails by the chosen granularity
    const groups = new Map();
    for (const e of events) {
      const k = rem.mode === 'task' ? `${e.taskId}:${e.email}:${e.kind}${e.offset}` : rem.mode === 'person' ? `${e.email}:${e.sendAt}` : `${e.sendAt}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(e);
    }
    for (const [k, es] of groups) {
      const to = [...new Map(es.map((e) => [e.email, { name: e.owner, email: e.email }])).values()];
      es.sort((a, b) => a.deadline - b.deadline || a.task.localeCompare(b.task));
      out.items.push({ key: `${sh.id}:${rem.mode}:${k}`, sheet: sh.id, sheetName: sh.name, mode: rem.mode, sendAt: es[0].sendAt, to, entries: es, tpl: { subject: rem.subject, body: rem.body } });
    }
  }
  out.items.sort((a, b) => a.sendAt - b.sendAt);
  return out;
}
export const hashOf = (i) => [i.sendAt, i.sheetName, i.mode, i.to.map((p) => p.email).join(','), i.entries.map((e) => `${e.taskId}/${e.task}/${e.deadline}/${Math.round(e.progress)}/${e.kind}${e.offset}`).join(';'), tplHash(i.tpl)].join('|');

export function diffPlan(plan, ledger, now = Date.now(), sheetIds = null) {
  const want = new Map(plan.items.map((i) => [i.key, i])), create = [], cancel = [], keep = [], forget = [];
  for (const [k, e] of Object.entries(ledger)) {
    if (sheetIds && !sheetIds.includes(e.sheet)) continue;
    if (e.sendAt <= now) { forget.push(k); continue; } // already delivered
    const w = want.get(k);
    if (w && hashOf(w) === e.hash) keep.push(w); else cancel.push({ key: k, ...e });
  }
  const kept = new Set(keep.map((i) => i.key));
  for (const i of plan.items) if (!kept.has(i.key)) create.push(i);
  return { create, cancel, keep, forget };
}

// ---------- rendering ----------
function detailsHtml(item) {
  const proj = item.mode === 'project', cell = 'padding:6px 14px 6px 0;font-size:13px;border-bottom:1px solid #eef1f6';
  const head = `<tr>${['Task', proj ? 'Owner' : '', 'Deadline', 'Progress'].filter(Boolean).map((h) => `<th align="left" style="padding:0 14px 6px 0;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#94a3b8;font-weight:600">${h}</th>`).join('')}</tr>`;
  const rows = item.entries.map((e) => `<tr><td style="${cell}"><b>${esc(e.task)}</b></td>${proj ? `<td style="${cell}">${esc(e.owner)}</td>` : ''}<td style="${cell};color:${e.kind === 'overdue' ? '#be123c' : '#0f172a'}">${esc(dayName(e.deadline))} <span style="color:#64748b">(${esc(relText(e))})</span></td><td style="${cell}">${Math.round(e.progress)}%</td></tr>`).join('');
  return `<table style="border-collapse:collapse;margin:6px 0 14px">${head}${rows}</table>`;
}
export function templateVars(item, sender) {
  const es = item.entries, e0 = es[0], overdueAll = es.every((e) => e.kind === 'overdue');
  const single = es.length === 1;
  return {
    person: item.mode === 'project' && item.to.length > 1 ? 'team' : first(item.to[0].name), task: single ? e0.task : plural(es.length, 'task'), project: item.sheetName,
    when: single ? relText(e0) : es.every((e) => relText(e) === relText(e0)) ? relText(e0) : `${plural(es.length, 'item')} need attention`, deadline: dayName(Math.min(...es.map((e) => e.deadline))),
    prefix: overdueAll ? 'Overdue' : 'Reminder', count: String(es.length), sender: sender || 'the project manager',
  };
}
const fill = (s, vars, enc) => String(s).replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? (enc ? esc(vars[k]) : vars[k]) : m));
export function renderEmail(item, sender) {
  const vars = templateVars(item, sender), overdue = vars.prefix === 'Overdue', accent = overdue ? '#be123c' : '#2b59e6';
  const subject = fill(item.tpl.subject, vars, false).replace(/\s+/g, ' ').trim().slice(0, 250) || 'Reminder';
  const text = (s) => esc(fill(s, vars, false)).replace(/\n/g, '<br>'); // escape the WHOLE expanded text once; never interpolate raw values
  const parts = String(item.tpl.body).split('{{details}}').map((p) => `<p style="font-size:14px;line-height:1.55;margin:0 0 12px">${text(p).replace(/^(<br>)+|(<br>)+$/g, '')}</p>`);
  const body = parts.join(detailsHtml(item));
  const html = `<div style="font-family:Segoe UI,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#0f172a"><div style="border-left:4px solid ${accent};padding:2px 0 2px 14px;margin:8px 0 18px"><div style="font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:${accent};font-weight:600">${overdue ? 'Deadline missed' : 'Deadline reminder'}</div><div style="font-size:19px;font-weight:600;margin-top:2px">${esc(vars.task)}</div></div>${body}</div>`;
  return { subject, html };
}

// ---------- UI + sync ----------
export function createReminders(ctx) {
  const { store } = ctx;
  const btn = document.querySelector('#rembtn'), dot = btn.querySelector('.dot');
  let me = null, dlg = null, tab = 'schedule', busy = false, autoTimer = 0, autoMsg = '';
  const userTpls = () => { const t = jget(TPLS, []); return Array.isArray(t) ? t.filter((x) => x && x.id && typeof x.subject === 'string' && typeof x.body === 'string') : []; };
  const status = (s) => { const el = dlg && dlg.body.querySelector('#remStatus'); if (el) el.textContent = s; };

  const scopeIds = () => store.wb.sheets.filter((s) => s.rem && s.rem.on && !s.readOnly).map((s) => s.id);
  const ledgerSheets = (led) => [...new Set(Object.values(led).map((e) => e.sheet))];
  function currentDiff() { const led = readLedger(), ids = [...new Set([...scopeIds(), ...ledgerSheets(led)])], plan = buildPlan(store); return { plan, d: diffPlan(plan, led, Date.now(), ids), ids }; }
  function badge() { const { d } = currentDiff(); const n = d.create.length + d.cancel.length; dot.hidden = !(m365.isSignedIn() && n > 0 && !store.wb.sheets.some((s) => s.rem && s.rem.on && s.rem.auto && !autoMsg)); dot.title = autoMsg || (n ? `${n} reminder change${n > 1 ? 's' : ''} not synced` : ''); if (autoMsg) dot.hidden = false; }
  async function senderName() { if (!me) { try { me = await m365.me(); } catch { me = { name: '', email: '' }; } } return me; }

  // Execute a diff against Graph. Shared by the dialog (interactive) and auto-sync (silent).
  async function execute(d, { interactive, progress, cap }) {
    const led = readLedger(), errs = []; let made = 0, cancelled = 0, n = 0;
    const who = await senderName(), sender = who.name || who.email, total = d.create.length + d.cancel.length;
    for (const k of d.forget) delete led[k];
    for (const c of d.cancel) {
      progress?.(++n, total);
      try { await m365.cancelMail(c.id, interactive); delete led[c.key]; cancelled++; } catch (e) { errs.push(`Could not cancel “${c.label || c.subject}”: ${e.message}`); if (e.status === 401 || e.status === 403) break; }
      jset(LEDGER, led);
    }
    for (const i of d.create.slice(0, cap)) {
      progress?.(++n, total);
      try {
        const { subject, html } = renderEmail(i, sender);
        const id = await m365.scheduleMail(i.to, subject, html, i.sendAt, interactive);
        led[i.key] = { id, sendAt: i.sendAt, hash: hashOf(i), sheet: i.sheet, subject, label: i.entries.length === 1 ? i.entries[0].task : plural(i.entries.length, 'task'), to: i.to.map((p) => p.email) }; made++;
      } catch (e) { errs.push(`${i.entries.length === 1 ? i.entries[0].task : plural(i.entries.length, 'task')} → ${i.to.map((p) => p.email).join(', ')}: ${e.message}`); if (e.status === 401 || e.status === 403) break; }
      jset(LEDGER, led);
    }
    return { made, cancelled, errs };
  }

  async function syncNow() {
    if (busy) return; busy = true;
    try {
      try { await m365.token(m365.SCOPES_MAIL); } catch (e) { status(`Mail permission was not granted: ${e.message || e}`); return; }
      const { d } = currentDiff(); lockUI(true);
      const r = await execute(d, { interactive: true, cap: SYNC_CAP, progress: (n, t) => status(`Working… ${n}/${t}`) });
      autoMsg = ''; lockUI(false); render(); badge();
      const msg = `Scheduled ${r.made}, cancelled ${r.cancelled}${r.errs.length ? `, ${r.errs.length} failed` : ''}.`;
      status(msg); ctx.toast(r.errs.length ? `Reminders partly synced: ${r.errs.length} failed` : msg);
      if (r.errs.length && dlg) { const box = document.createElement('div'); box.className = 'rem-warn'; setHTML(box, r.errs.slice(0, 5).map((x) => `<p>${esc(x)}</p>`).join('') + (r.errs.length > 5 ? `<p>+ ${r.errs.length - 5} more</p>` : '')); dlg.body.querySelector('.rem-actions')?.before(box); }
    } finally { busy = false; }
  }
  const lockUI = (on) => dlg?.body.querySelectorAll('button,input,select,textarea').forEach((e) => { e.disabled = on; });

  // auto-sync: silent, only for projects with auto on, never opens a popup, refuses large batches
  function queueAuto() {
    clearTimeout(autoTimer);
    if (!m365.isSignedIn() || !store.wb.sheets.some((s) => s.rem && s.rem.on && s.rem.auto && !s.readOnly)) return;
    autoTimer = setTimeout(runAuto, 12000);
  }
  async function runAuto() {
    if (busy || !m365.isSignedIn()) return; busy = true;
    try {
      const autoIds = store.wb.sheets.filter((s) => s.rem && s.rem.on && s.rem.auto && !s.readOnly).map((s) => s.id), led = readLedger();
      const ids = [...new Set([...autoIds, ...ledgerSheets(led).filter((id) => { const s = store.sheet(id); return !s || !s.rem || !s.rem.on; })])];
      const plan = buildPlan(store, Date.now(), autoIds), d = diffPlan(plan, led, Date.now(), ids);
      if (!d.create.length && !d.cancel.length) { jset(LEDGER, (() => { const l = readLedger(); for (const k of d.forget) delete l[k]; return l; })()); autoMsg = ''; badge(); return; }
      if (d.create.length > AUTO_CAP) { autoMsg = `Auto-reminders paused: ${d.create.length} changes need your review`; badge(); return; }
      const r = await execute(d, { interactive: false, cap: AUTO_CAP });
      autoMsg = r.errs.length ? `Auto-reminders: ${r.errs[0]}` : ''; if (r.made || r.cancelled) ctx.toast(`Auto-reminders updated (${r.made} scheduled, ${r.cancelled} cancelled)`);
      if (dlg) render(); badge();
    } catch (e) { autoMsg = /interaction|consent|login/i.test(`${e.errorCode} ${e.message}`) ? 'Auto-reminders need mail permission: open Reminders and sync once' : `Auto-reminders failed: ${e.message}`; badge(); }
    finally { busy = false; }
  }

  async function test() {
    try { await m365.token(m365.SCOPES_MAIL); } catch (e) { status(`Mail permission was not granted: ${e.message || e}`); return; }
    status('Sending…');
    try {
      const who = await senderName(), plan = buildPlan(store, Date.now() - 400 * DAY, [store.wb.active]);
      const sample = plan.items[0] || { mode: 'task', sheet: store.wb.active, sheetName: store.sheet().name, to: [{ name: who.name, email: who.email }], entries: [{ taskId: 0, task: 'Sample task', owner: who.name, email: who.email, deadline: Math.floor(Date.now() / DAY) + 3, progress: 40, kind: 'before', offset: 3 }], tpl: { subject: store.rem.subject, body: store.rem.body } };
      const item = { ...sample, to: [{ name: who.name, email: who.email }], tpl: { subject: store.rem.subject, body: store.rem.body } };
      const { subject, html } = renderEmail(item, who.name);
      await m365.sendNow(who, `[Test] ${subject}`, html); status(`Test sent to ${who.email}`);
    } catch (e) { status(`Test failed: ${e.message}`); }
  }

  // ----- dialog -----
  const sampleItem = () => {
    const plan = buildPlan(store, Date.now() - 400 * DAY, [store.wb.active]); const rem = store.rem;
    const it = plan.items[0] || { mode: rem.mode, sheet: store.wb.active, sheetName: store.sheet().name, to: [{ name: 'Alex Morgan', email: 'alex@example.com' }], entries: [{ taskId: 0, task: 'Sample task', owner: 'Alex Morgan', email: 'alex@example.com', deadline: Math.floor(Date.now() / DAY) + 3, progress: 40, kind: 'before', offset: 3 }] };
    return { ...it, tpl: { subject: rem.subject, body: rem.body } };
  };
  function renderMessage() {
    const rem = store.rem, tpls = [...BUILTIN_TPL, ...userTpls()], pv = renderEmail(sampleItem(), (me && me.name) || 'You');
    const cur = tpls.find((t) => t.subject === rem.subject && t.body === rem.body);
    setHTML(dlg.body.querySelector('#remPane'),
      `<div class="tpl-bar"><label>Template <select id="tplSel"><option value="">${cur ? '' : 'Custom (unsaved)'}</option>${tpls.map((t) => `<option value="${esc(t.id)}"${cur && cur.id === t.id ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label><button id="tplSave">Save as template…</button>${cur && userTpls().some((t) => t.id === cur.id) ? '<button id="tplDel">Delete</button>' : ''}</div>` +
      `<label class="fld"><span>Subject</span><input id="remSubj" value="${esc(rem.subject)}" maxlength="200" spellcheck="false"></label>` +
      `<label class="fld"><span>Message</span><textarea id="remBody" rows="9" maxlength="4000">${esc(rem.body)}</textarea></label>` +
      `<div class="vars">${VARS.map(([k, d]) => `<button class="var" data-v="${k}" title="${esc(d)}">{{${k}}}</button>`).join('')}</div>` +
      `<div class="pv-h">Preview <span class="mut">with ${plan0() ? 'your first upcoming reminder' : 'sample data'}</span></div><div class="pv"><div class="pv-sub"><b>Subject:</b> ${esc(pv.subject)}</div><div class="pv-body" id="pvBody"></div></div>`);
    setHTML(dlg.body.querySelector('#pvBody'), pv.html);
  }
  const plan0 = () => buildPlan(store, Date.now(), [store.wb.active]).items.length > 0;

  function renderSchedule() {
    const sh = store.sheet(), rem = store.rem, { plan, d } = currentDiff(), signed = m365.isSignedIn(), ro = !!sh.readOnly;
    const chips = OFFSETS.map((o) => `<label class="chip2"><input type="checkbox" data-o="${o}"${rem.offsets.includes(o) ? ' checked' : ''}><span>${o === 0 ? 'On the day' : `${o}d before`}</span></label>`).join('');
    const hours = Array.from({ length: 24 }, (_, h) => `<option value="${h}"${h === rem.hour ? ' selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('');
    const modes = [['task', 'Per action item', 'One email per task and recipient'], ['person', 'Per person', 'One digest per person per day'], ['project', 'Per project', 'One email per day to everyone involved']];
    const rows = d.create.slice(0, 60).map((i) => {
      const what = i.entries.length === 1 ? `${esc(i.entries[0].task)}<i>${i.entries[0].kind === 'overdue' ? 'overdue notice' : esc(dayName(i.entries[0].deadline))}</i>` : `${plural(i.entries.length, 'task')}<i title="${esc(i.entries.map((e) => e.task).join(', '))}">${esc(i.entries.slice(0, 2).map((e) => e.task).join(', '))}${i.entries.length > 2 ? '…' : ''}</i>`;
      const who = i.to.length === 1 ? `${esc(i.to[0].name)}<i>${esc(i.to[0].email)}</i>` : `${plural(i.to.length, 'person')}<i>${esc(i.to.slice(0, 2).map((p) => p.name).join(', '))}${i.to.length > 2 ? '…' : ''}</i>`;
      const acts = i.to.length === 1 ? `<button class="lnk" data-mute="${esc(i.to[0].email)}" title="Never remind this person in this project">mute</button>` : '';
      return `<tr><td>${esc(when(i.sendAt))}</td><td>${who}</td><td>${what}</td><td class="ra">${i.sheet !== sh.id ? `<i>${esc(i.sheetName)}</i>` : ''}${acts}${i.entries.length === 1 ? `<button class="lnk" data-skip="${i.sheet}:${i.entries[0].taskId}" title="Don't remind about this task">skip</button>` : ''}</td></tr>`;
    }).join('');
    const warn = [];
    if (plan.skipped.noEmail.length) warn.push(`<b>${plan.skipped.noEmail.length}</b> task${plan.skipped.noEmail.length > 1 ? 's have' : ' has'} an owner without an email (${esc(plan.skipped.noEmail.slice(0, 3).map((x) => x.owner).join(', '))}${plan.skipped.noEmail.length > 3 ? '…' : ''}). Pick them from the directory in the Owner column.`);
    if (!signed) warn.push(m365.isConfigured() ? 'Sign in with your Microsoft 365 account to schedule reminders.' : 'Microsoft 365 is not connected yet: open <b>Microsoft 365 › Settings</b>.');
    if (autoMsg) warn.push(esc(autoMsg));
    const muted = rem.muted.map((e) => `<button class="chip2 off" data-unmute="${esc(e)}" title="Un-mute">${esc(e)} ×</button>`).join('');
    setHTML(dlg.body.querySelector('#remPane'),
      `<div class="rem-sec"><div class="rem-row"><label class="sw"><input type="checkbox" id="remOn"${rem.on ? ' checked' : ''}${ro ? ' disabled' : ''}><i></i></label><div><b>Remind owners before deadlines</b><span class="sub">Project “${esc(sh.name)}” · deadline = task end date · finished tasks are skipped</span></div></div>` +
      `<div class="rem-opts"${rem.on ? '' : ' hidden'}>` +
      `<div class="modes" role="radiogroup" aria-label="Reminder granularity">${modes.map(([k, t, s]) => `<label class="mode${rem.mode === k ? ' on' : ''}"><input type="radio" name="remMode" value="${k}"${rem.mode === k ? ' checked' : ''}><b>${t}</b><span>${s}</span></label>`).join('')}</div>` +
      `<div class="chips">${chips}</div>` +
      `<div class="rem-row2"><label class="chk"><input type="checkbox" id="remOver"${rem.overdue ? ' checked' : ''}> Also notify the day after a missed deadline</label><label>Send at <select id="remHour">${hours}</select></label></div>` +
      `<div class="rem-row auto"><label class="sw"><input type="checkbox" id="remAuto"${rem.auto ? ' checked' : ''}><i></i></label><div><b>Automatic</b><span class="sub">Keep reminders in sync whenever this project changes (while the app is open, signed in)</span></div></div>` +
      (muted ? `<div class="mutedrow"><span class="mut">Muted:</span>${muted}</div>` : '') + `</div></div>` +
      `<div class="rem-sec"><div class="rem-sum"><span><b>${d.create.length}</b> to schedule</span><span><b>${d.cancel.length}</b> to cancel</span><span><b>${d.keep.length}</b> up to date</span>${plan.skipped.past ? `<span class="mut">${plan.skipped.past} already past</span>` : ''}${plan.skipped.noRem ? `<span class="mut">${plan.skipped.noRem} skipped · <button class="lnk" id="remUnskip">clear</button></span>` : ''}</div>` +
      (warn.length ? `<div class="rem-warn">${warn.map((w) => `<p>${w}</p>`).join('')}</div>` : '') +
      (rows ? `<div class="rem-tbl"><table><thead><tr><th>Sends</th><th>To</th><th>About</th><th></th></tr></thead><tbody>${rows}</tbody></table>${d.create.length > 60 ? `<div class="mut">+ ${d.create.length - 60} more</div>` : ''}</div>` : `<div class="rem-empty">${rem.on ? 'Nothing to schedule: all upcoming reminders are set up, or no unfinished task has an owner email.' : 'Switch reminders on to preview what will be sent.'}</div>`) +
      `<div class="rem-actions"><span id="remStatus" class="mut" role="status"></span><span style="flex:1"></span><button id="remTest"${signed ? '' : ' disabled'}>Send test to me</button><button id="remSync" class="primary"${signed && (d.create.length + d.cancel.length) ? '' : ' disabled'}>Sync${d.create.length + d.cancel.length ? ` (${d.create.length + d.cancel.length})` : ''}</button></div></div>` +
      `<div class="rem-foot">Reminders are queued in <b>your</b> Outlook mailbox with a delivery time and sent by Exchange Online, even when this page is closed. They go out from your address.</div>`);
  }
  function render() {
    if (!dlg) return;
    setHTML(dlg.body.querySelector('#remTabs'), `<button data-tab="schedule" class="${tab === 'schedule' ? 'on' : ''}">Schedule</button><button data-tab="message" class="${tab === 'message' ? 'on' : ''}">Message template</button>`);
    if (tab === 'schedule') renderSchedule(); else renderMessage();
  }
  const saveTpl = (name) => {
    const list = userTpls(), rem = store.rem, ex = list.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (ex) { ex.subject = rem.subject; ex.body = rem.body; } else list.push({ id: `u${Date.now().toString(36)}`, name, subject: rem.subject, body: rem.body });
    jset(TPLS, list.slice(0, 50)); ctx.toast(`Template “${name}” saved`);
  };

  function open() {
    dlg = openModal('Deadline reminders', '<div class="tabs" id="remTabs"></div><div id="remPane"></div>', { wide: true, onClose: () => { dlg = null; } });
    const B = dlg.body;
    B.addEventListener('change', (e) => {
      const t = e.target; if (store.sheet().readOnly) return;
      if (t.id === 'remOn') store.setRem({ on: t.checked });
      else if (t.id === 'remAuto') { store.setRem({ auto: t.checked }); if (t.checked) { queueAuto(); ctx.toast('Automatic reminders on for this project'); } }
      else if (t.id === 'remOver') store.setRem({ overdue: t.checked });
      else if (t.id === 'remHour') store.setRem({ hour: +t.value });
      else if (t.name === 'remMode') store.setRem({ mode: t.value });
      else if (t.dataset.o != null) store.setRem({ offsets: [...B.querySelectorAll('[data-o]:checked')].map((x) => +x.dataset.o) });
      else if (t.id === 'tplSel' && t.value) { const p = [...BUILTIN_TPL, ...userTpls()].find((x) => x.id === t.value); if (p) store.setRem({ subject: p.subject, body: p.body }); }
    });
    B.addEventListener('input', (e) => {
      if (e.target.id === 'remSubj' || e.target.id === 'remBody') {
        const subject = B.querySelector('#remSubj').value, body = B.querySelector('#remBody').value;
        if (subject.trim() && body.trim()) { store.sheet().rem = { ...store.rem, subject, body }; store.save(); const pv = renderEmail(sampleItem(), (me && me.name) || 'You'); B.querySelector('.pv-sub').replaceChildren(Object.assign(document.createElement('b'), { textContent: 'Subject: ' }), document.createTextNode(pv.subject)); setHTML(B.querySelector('#pvBody'), pv.html); }
      }
    });
    B.addEventListener('click', (e) => {
      const t = e.target, q = (s) => t.closest(s);
      if (q('[data-tab]')) { tab = q('[data-tab]').dataset.tab; render(); }
      else if (t.id === 'remSync') syncNow(); else if (t.id === 'remTest') test();
      else if (q('[data-mute]')) store.setRem({ muted: [...store.rem.muted, q('[data-mute]').dataset.mute] });
      else if (q('[data-unmute]')) store.setRem({ muted: store.rem.muted.filter((x) => x !== q('[data-unmute]').dataset.unmute) });
      else if (q('[data-skip]')) { const [sid, tid] = q('[data-skip]').dataset.skip.split(':'); if (sid === store.wb.active) store.setNoRem(+tid, true); else ctx.toast('Switch to that project to skip its tasks'); }
      else if (t.id === 'remUnskip') store.clearNoRem();
      else if (q('.var')) { const ta = B.querySelector('#remBody'), s = `{{${q('.var').dataset.v}}}`, a = ta.selectionStart ?? ta.value.length; ta.value = ta.value.slice(0, a) + s + ta.value.slice(ta.selectionEnd ?? a); ta.focus(); ta.setSelectionRange(a + s.length, a + s.length); ta.dispatchEvent(new Event('input', { bubbles: true })); }
      else if (t.id === 'tplSave') { const n = window.prompt('Template name'); if (n && n.trim()) { saveTpl(n.trim().slice(0, 40)); render(); } }
      else if (t.id === 'tplDel') { const cur = [...userTpls()].find((x) => x.subject === store.rem.subject && x.body === store.rem.body); if (cur) { jset(TPLS, userTpls().filter((x) => x.id !== cur.id)); render(); } }
    });
    render();
  }
  btn.addEventListener('click', open);
  store.on((kind) => { if (kind !== 'drag') { badge(); queueAuto(); } if (dlg && kind !== 'drag') render(); });
  m365.onAuthChange(() => { me = null; autoMsg = ''; render(); badge(); queueAuto(); });
  return { render, badge, open };
}
