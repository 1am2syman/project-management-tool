// Read-only sharing through OneDrive. "Share" publishes a snapshot of the project to the owner's OneDrive and grants
// chosen colleagues the *read* role on that file (a real Microsoft 365 permission, so nobody but the owner can change
// it), then emails each of them a confirmation with a link that opens the project in this app. Viewers get a read-only
// copy they can refresh; the owner can revoke access at any time.
import { esc, openModal, setHTML } from './dom.js';
import { isEmail } from './model.js';
import { avatar } from './people.js';
import * as m365 from './m365.js';

const fmt = (ts) => (ts ? new Date(ts).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never');

export function grantEmail({ owner, project, link, message, person }) {
  const subject = `${owner} gave you read-only access to “${project}”`.slice(0, 250);
  const msg = message ? `<div style="background:#f6f7fa;border-radius:10px;padding:12px 14px;margin:0 0 16px;font-size:14px;line-height:1.5;white-space:pre-wrap">${esc(message)}</div>` : '';
  const html = `<div style="font-family:Segoe UI,Helvetica,Arial,sans-serif;max-width:540px;margin:0 auto;color:#0f172a">` +
    `<div style="font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#2b59e6;font-weight:600;margin:8px 0 4px">Access granted · read-only</div>` +
    `<div style="font-size:20px;font-weight:600;margin-bottom:14px">${esc(project)}</div>` +
    `<p style="font-size:14px;line-height:1.55;margin:0 0 14px">Hi ${esc(String(person).split(/\s+/)[0])}, <b>${esc(owner)}</b> has given you <b>view-only</b> access to this project plan (schedule, Gantt chart, dependencies and critical path).</p>${msg}` +
    `<a href="${esc(link)}" style="display:inline-block;background:#2b59e6;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 18px;border-radius:9px">Open project</a>` +
    `<p style="font-size:12.5px;line-height:1.55;color:#64748b;margin:18px 0 0">Sign in with your work account when asked. You can view and refresh the plan but not change it. ${esc(owner)} can withdraw access at any time.</p></div>`;
  return { subject, html };
}

export function createSharing(ctx) {
  const { store } = ctx;
  const btn = document.querySelector('#sharebtn'), banner = document.querySelector('#robanner'), app = document.querySelector('#app');
  let dlg = null, pending = [], grants = null, busy = false, sid = null, stopPicker = null, quiet = false;
  const sh = () => store.sheet();                       // the sheet on screen (viewer banner)
  const ds = () => store.sheet(sid) || store.sheet();   // the sheet the open dialog is about: every async step is pinned to it
  const owner = () => (m365.currentAccount() || { name: 'Someone', email: '' });
  const status = (s, bad = false) => { const el = dlg && dlg.body.querySelector('#shStatus'); if (el) { el.textContent = s; el.classList.toggle('bad', bad); } };
  const reason = (e) => (e.status === 403 ? 'Not allowed: your organisation may restrict sharing or this app has not been granted file access' : e.status === 401 ? 'Sign-in expired; sign in again' : e.message || String(e));

  // ---------- publish + grant ----------
  const inflight = new Map(), lastSent = new Map(), timers = new Map();
  // Upload the project to OneDrive. Pinned to a sheet id (the user may switch tabs while it runs); concurrent calls share one upload;
  // unless forced, an unchanged project is not uploaded again.
  function publish(id, interactive = true, force = true) {
    if (inflight.has(id)) return inflight.get(id);
    const p = (async () => {
      const s = store.sheet(id); if (!s || s.readOnly) throw new Error('That project is no longer available');
      const json = JSON.stringify(store.snapshot(id)), where = s.share ? `${s.share.driveId}|${s.share.itemId}|` : '';
      if (!force && s.share && lastSent.get(id) === where + json) return s.share;
      const it = await m365.publishFile(s.name, json, s.share ? { driveId: s.share.driveId, itemId: s.share.itemId } : null, interactive);
      if (!it.driveId || !it.itemId) throw new Error('OneDrive did not return the file location');
      const cur = store.sheet(id); if (!cur) throw new Error('That project was deleted while publishing');
      store.setShare(id, { ...(cur.share || { people: {} }), driveId: it.driveId, itemId: it.itemId, webUrl: it.webUrl, publishedAt: Date.now() });
      lastSent.set(id, `${it.driveId}|${it.itemId}|${json}`);
      return store.sheet(id).share;
    })().finally(() => inflight.delete(id));
    inflight.set(id, p); return p;
  }
  async function grant() {
    if (busy || !pending.length) return; busy = true; lock(true);
    const id = sid, msg = dlg.body.querySelector('#shMsg').value.trim().slice(0, 1000), who = owner(), ok = [], fail = [], batch = pending.slice();
    try {
      status('Publishing to your OneDrive…'); const share = await publish(id);
      status('Granting read-only access…');
      const perms = await m365.createGrant(share, batch.map((p) => p.email));
      const people = { ...store.sheet(id).share.people }, done = [];
      batch.forEach((p, i) => {
        const hit = perms[i];
        if (!hit) { fail.push(`${p.email}: OneDrive did not confirm the permission`); return; }
        people[p.email.toLowerCase()] = { name: p.name, permId: hit.id || '', uid: hit.uid || '', at: Date.now() }; done.push(p);
      });
      store.setShare(id, { ...store.sheet(id).share, people });
      for (const p of done) {
        status(`Emailing ${p.email}…`);
        try { const { subject, html } = grantEmail({ owner: who.name, project: store.sheet(id).name, link: m365.shareLink(share), message: msg, person: p.name }); await m365.sendNow(p, subject, html); ok.push(p); }
        catch (e) { fail.push(`${p.email}: ${reason(e)}`); }
      }
      pending = pending.filter((p) => !batch.includes(p));
      ctx.toast(`Read-only access granted to ${done.length}${fail.length ? ` (${fail.length} problem${fail.length > 1 ? 's' : ''})` : '; confirmation emails sent'}`);
      grants = null; lock(false); render(); if (fail.length) status(fail.join(' · '), true); else status(`Done: ${ok.length} person${ok.length === 1 ? '' : 's'} can now view this project.`);
    } catch (e) { lock(false); render(); status(`Could not share: ${reason(e)}`, true); }
    finally { busy = false; }
  }
  async function revoke(email) {
    const id = sid, s = ds().share, p = s && s.people[email]; if (!s) return;
    if (!window.confirm(`Remove ${p ? p.name : email}'s access to this project?`)) return;
    try {
      let permId = p && p.permId;
      if (!permId) { const g = (await m365.listGrants(s)).filter((x) => !x.link && ((p && p.uid && x.uid === p.uid) || x.email === email)); permId = g[0] && g[0].id; }
      if (!permId) { status(`Could not find ${email}'s permission in OneDrive, so nothing was removed. Use “refresh from OneDrive” to see who has access.`, true); return; }
      await m365.revokeGrant(s, permId);
      const cur = store.sheet(id); if (cur && cur.share) { const people = { ...cur.share.people }; delete people[email]; store.setShare(id, { ...cur.share, people }); }
      grants = null; render(); status(`Access removed for ${email}.`);
    } catch (e) { status(`Could not revoke: ${reason(e)}`, true); }
  }
  async function resend(email) {
    const s = ds().share, p = s && s.people[email]; if (!s) return;
    try { const { subject, html } = grantEmail({ owner: owner().name, project: ds().name, link: m365.shareLink(s), message: '', person: p.name }); await m365.sendNow({ name: p.name, email }, subject, html); status(`Confirmation re-sent to ${email}.`); }
    catch (e) { status(`Could not send: ${reason(e)}`, true); }
  }
  async function refreshGrants() {
    const s = ds().share; if (!s) return;
    try { grants = await m365.listGrants(s); render(); status('Access list refreshed from OneDrive.'); } catch (e) { status(`Could not refresh: ${reason(e)}`, true); }
  }

  // ---------- dialog ----------
  const lock = (on) => dlg?.body.querySelectorAll('button,input,textarea').forEach((e) => { e.disabled = on; });
  function render() {
    if (!dlg) return;
    stopPicker?.(); stopPicker = null;
    const s = ds(), share = s.share, signed = m365.isSignedIn();
    const people = share ? Object.entries(share.people) : [];
    const known = new Set(people.map(([e]) => e)), server = grants ? grants.filter((g) => g.email && !g.link && !known.has(g.email)) : [], links = grants ? grants.filter((g) => g.link).length : 0;
    const row = ([email, p]) => `<div class="g-row">${avatar(p.name)}<span class="gn"><b>${esc(p.name)}</b><i>${esc(email)} · since ${esc(fmt(p.at))}</i></span><span class="gr">View only</span><button class="lnk" data-resend="${esc(email)}">resend email</button><button class="lnk red" data-revoke="${esc(email)}">remove</button></div>`;
    const srow = (g) => `<div class="g-row">${avatar(g.name || g.email)}<span class="gn"><b>${esc(g.name || g.email)}</b><i>${esc(g.email)} · granted elsewhere</i></span><span class="gr">${esc(g.roles.includes('write') ? 'Can edit' : 'View only')}</span><button class="lnk red" data-revoke="${esc(g.email)}">remove</button></div>`;
    setHTML(dlg.body,
      `<div class="sh-sec"><b>Give read-only access</b><span class="sub">People you add can open “${esc(s.name)}” and see everything in it, but cannot change it. They get an email confirming the access.</span>` +
      `<div class="sh-add"><div class="chips pend">${pending.map((p, i) => `<span class="chip2 on" title="${esc(p.email)}">${avatar(p.name)}${esc(p.name)}<button class="x" data-rm="${i}" aria-label="Remove">×</button></span>`).join('')}<input id="shIn" placeholder="${signed ? 'Search colleagues by name or email…' : 'Sign in to Microsoft 365 first'}" autocomplete="off" spellcheck="false"${signed ? '' : ' disabled'}></div></div>` +
      `<label class="fld"><span>Message (optional)</span><textarea id="shMsg" rows="3" maxlength="1000" placeholder="Add a note for the people you are sharing with"></textarea></label>` +
      `<div class="rem-actions"><span id="shStatus" class="mut" role="status"></span><span style="flex:1"></span><button id="shGo" class="primary"${signed && pending.length ? '' : ' disabled'}>Grant access${pending.length ? ` (${pending.length})` : ''}</button></div></div>` +
      `<div class="sh-sec"><div class="sh-h"><b>People with access</b>${share ? '<button class="lnk" id="shRef">refresh from OneDrive</button>' : ''}</div>` +
      (people.length || server.length ? `<div class="g-list">${people.map(row).join('')}${server.map(srow).join('')}</div>` : '<div class="rem-empty">Nobody yet.</div>') +
      (links ? `<div class="rem-warn"><p><b>${links}</b> sharing link${links > 1 ? 's' : ''} on this file also give access. Manage them in OneDrive.</p></div>` : '') + `</div>` +
      (share ? `<div class="sh-sec"><div class="rem-row"><label class="sw"><input type="checkbox" id="shAuto"${share.auto ? ' checked' : ''}><i></i></label><div><b>Keep the shared copy up to date</b><span class="sub">Re-publish automatically a few seconds after you change this project (last published ${esc(fmt(share.publishedAt))})</span></div></div>` +
        `<div class="rem-actions"><button id="shPub">Publish now</button><button id="shCopy">Copy link</button></div></div>` : '') +
      `<div class="rem-foot">The project is stored as a file in <b>your</b> OneDrive (Plan projects folder). Access is a real Microsoft 365 permission: viewers sign in with their work account, and removing someone stops them opening or refreshing the plan. A copy they have already opened stays in their browser.</div>`);
    const inp = dlg.body.querySelector('#shIn');
    if (inp && signed && ctx.people) attachPicker(inp);
  }
  function attachPicker(inp) {
    let armed = false;
    const arm = () => { if (armed) return; armed = true; stopPicker = ctx.people.attach(inp, (p) => { add(p); }); };
    const add = (p) => {
      const em = p.email.toLowerCase();
      if (pending.some((x) => x.email.toLowerCase() === em)) { ctx.toast(`${p.email} is already in the list`); return; }
      if (ds().share && ds().share.people[em]) { ctx.toast(`${p.email} already has access`); return; }
      pending.push({ name: p.name, email: p.email }); render(); quiet = true; dlg.body.querySelector('#shIn')?.focus(); quiet = false; // re-focus without re-opening the list over the Grant button
    };
    inp.addEventListener('focus', () => { if (!quiet) arm(); });
    inp.addEventListener('pointerdown', arm);
    inp.addEventListener('keydown', (e) => {
      if (e.key.length === 1 || e.key === 'ArrowDown' || e.key === 'Backspace') arm(); // first key re-opens the suggestions
      if (e.key === 'Enter' && isEmail(inp.value.trim())) { e.preventDefault(); const em = inp.value.trim(); add({ name: em.split('@')[0], email: em }); } // paste a plain address
    });
  }
  function open() {
    if (sh().readOnly) { ctx.toast('This is a read-only copy: only its owner can share it'); return; }
    pending = []; grants = null; sid = store.wb.active;
    dlg = openModal('Share project', '', { wide: true, onClose: () => { stopPicker?.(); stopPicker = null; dlg = null; } });
    dlg.body.addEventListener('click', (e) => {
      const t = e.target, q = (s) => t.closest(s);
      if (t.id === 'shGo') grant();
      else if (q('[data-rm]')) { pending.splice(+q('[data-rm]').dataset.rm, 1); render(); }
      else if (q('[data-revoke]')) revoke(q('[data-revoke]').dataset.revoke);
      else if (q('[data-resend]')) resend(q('[data-resend]').dataset.resend);
      else if (t.id === 'shRef') refreshGrants();
      else if (t.id === 'shPub') publish(sid).then(() => { render(); status('Published.'); }).catch((er) => status(`Could not publish: ${reason(er)}`, true));
      else if (t.id === 'shCopy') navigator.clipboard?.writeText(m365.shareLink(ds().share)).then(() => status('Link copied. Only people with access can open it.'), () => status('Copy failed', true));
    });
    dlg.body.addEventListener('change', (e) => { if (e.target.id === 'shAuto') { store.setShare(sid, { ...ds().share, auto: e.target.checked }); queueAuto(sid); } });
    if (!m365.isSignedIn()) ctx.toast(m365.isConfigured() ? 'Sign in with Microsoft 365 to share' : 'Connect Microsoft 365 first (Microsoft 365 › Settings)');
    render();
  }
  btn.addEventListener('click', open);

  // keep the shared copy current (silent; never opens a popup). Reacts to edits only, never to its own bookkeeping.
  function queueAuto(id = store.wb.active) {
    clearTimeout(timers.get(id)); const s = store.sheet(id);
    if (!s || !s.share || !s.share.auto || s.readOnly || !m365.isSignedIn()) return;
    timers.set(id, setTimeout(async () => {
      timers.delete(id);
      try { await publish(id, false, false); } catch (e) { ctx.toast(`Auto-publish failed: ${reason(e)}`); }
    }, 8000));
  }

  // ---------- viewer side ----------
  function paintBanner() {
    const s = sh(), ro = !!s.readOnly; app.classList.toggle('ro', ro); banner.hidden = !ro;
    if (!ro) return;
    const src = s.source || {};
    setHTML(banner, `<span class="lock"><svg viewBox="0 0 16 16"><rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 015 0v2"/></svg>Read-only</span><span>Shared by <b>${esc(src.by || 'its owner')}</b> · updated ${esc(fmt(src.fetchedAt))}</span><span style="flex:1"></span><button id="roRef">Refresh</button><button id="roCopy">Make editable copy</button>`);
  }
  banner.addEventListener('click', (e) => {
    if (e.target.id === 'roRef') { const s = sh().source; if (s) load(s.driveId, s.itemId, true); }
    else if (e.target.id === 'roCopy') { store.duplicateSheet(store.wb.active); ctx.toast('Editable copy created. It is separate from the shared project.'); }
  });
  async function load(driveId, itemId, refresh = false) {
    try {
      ctx.toast(refresh ? 'Refreshing…' : 'Opening shared project…');
      const r = await m365.fetchShared(driveId, itemId), snap = r.snapshot;
      if (!snap || snap.v !== 1 || !snap.data || !Array.isArray(snap.data.tasks)) throw new Error('This file is not a project plan');
      store.importShared(snap.data, String(snap.name || 'Shared project').slice(0, 60), { driveId, itemId, by: r.by, byEmail: r.byEmail, fetchedAt: Date.now() });
      ctx.toast(refresh ? 'Up to date' : `Opened “${String(snap.name || 'project')}” (read-only)`);
    } catch (e) {
      ctx.toast(e.status === 403 || e.status === 404 ? `You don't have access to this project. Ask the owner to share it with ${(m365.currentAccount() || {}).email || 'you'}.` : `Could not open the project: ${reason(e)}`);
    }
  }
  function fromHash() {
    const m = location.hash.match(/^#open=([\w-]+)$/); if (!m) return;
    let ref; try { ref = m365.unb64(m[1]); } catch { ref = null; }
    history.replaceState(null, '', location.pathname + location.search);
    const okId = (v) => typeof v === 'string' && /^[A-Za-z0-9!_.-]{1,300}$/.test(v) && !/^\.+$/.test(v);
    if (!ref || !okId(ref.d) || !okId(ref.i)) { ctx.toast('That share link is not valid'); return; }
    // sign-in and the file-read consent are popups, which browsers only allow straight after a click
    const go = async () => { if (!m365.isSignedIn()) await ctx.m365ui.signIn(m365.SCOPES_FILES_READ); if (m365.isSignedIn()) { try { await m365.token(m365.SCOPES_FILES_READ); } catch (e) { ctx.toast(`Permission to open shared files was not granted: ${e.message || e}`); return; } await load(ref.d, ref.i); } };
    if (m365.isSignedIn()) { m365.token(m365.SCOPES_FILES_READ, false).then(() => load(ref.d, ref.i), () => ask()); return; }
    ask();
    function ask() {
      const d = openModal('Open shared project', `<p class="sub" style="margin:0 0 14px">Someone shared a project plan with you. Sign in with your work account to open it.</p><div class="rem-actions"><span style="flex:1"></span><button id="shOpen" class="primary">${!m365.isConfigured() ? 'Set up Microsoft 365' : m365.isSignedIn() ? 'Allow and open' : 'Sign in and open'}</button></div>`);
      d.body.querySelector('#shOpen').addEventListener('click', async () => { d.close(); if (!m365.isConfigured()) { ctx.m365ui.settings(); return; } await go(); });
    }
  }

  store.on((kind) => { if (kind === 'change') queueAuto(); });
  m365.onAuthChange(() => { render(); queueAuto(); });
  return { paintBanner, fromHash, open, load };
}
