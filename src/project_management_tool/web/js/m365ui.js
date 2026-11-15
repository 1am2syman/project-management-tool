// Toolbar button + menu + settings dialog for the Microsoft 365 connection.
import { esc, openModal, setHTML } from './dom.js';
import { avatar } from './people.js';
import * as m365 from './m365.js';

export function createM365UI(ctx) {
  const btn = document.querySelector('#m365btn'), lbl = document.querySelector('#m365lbl'), menu = document.querySelector('#m365menu');

  function paint() {
    const a = m365.currentAccount();
    if (a) { setHTML(lbl, `${avatar(a.name)}<span class="who">${esc(String(a.name).split(/\s+/)[0])}</span>`); btn.title = `Signed in as ${a.email}`; btn.classList.add('on'); }
    else { setHTML(lbl, '<span>Microsoft 365</span>'); btn.title = m365.isConfigured() ? 'Sign in with your work account' : 'Connect Microsoft 365'; btn.classList.remove('on'); }
  }
  async function doSignIn() {
    if (!m365.isConfigured()) { settings(); return; }
    try { await m365.signIn(); ctx.toast(`Signed in as ${m365.currentAccount().email}`); }
    catch (e) { ctx.toast(/popup/i.test(e.message || e.errorCode || '') ? 'Sign-in popup was blocked or closed. Allow popups for this site and retry.' : `Sign-in failed: ${e.errorMessage || e.message || e}`); }
  }
  function openMenu() {
    const a = m365.currentAccount();
    setHTML(menu, a
      ? `<div class="ttl">Signed in</div><div class="acct">${avatar(a.name)}<span><b>${esc(a.name)}</b><i>${esc(a.email)}</i></span></div><button data-k="settings"><b>Settings…</b><span>App registration and permissions</span></button><button data-k="out"><b>Sign out</b><span>Disconnect this browser</span></button>`
      : `<div class="ttl">Microsoft 365</div><button data-k="in"><b>Sign in with Microsoft</b><span>${m365.isConfigured() ? 'Use your work account to find colleagues and send reminders' : 'Connect your organisation first'}</span></button><button data-k="settings"><b>Settings…</b><span>App registration and permissions</span></button>`);
    menu.hidden = false;
    const r = btn.getBoundingClientRect(); menu.style.left = `${Math.max(8, Math.min(r.right - 260, innerWidth - 268))}px`; menu.style.top = `${r.bottom + 6}px`;
  }
  const close = () => { menu.hidden = true; };
  btn.addEventListener('click', (e) => { e.stopPropagation(); if (!menu.hidden) close(); else if (!m365.isSignedIn() && m365.isConfigured()) doSignIn(); else if (!m365.isConfigured() && !m365.isSignedIn()) settings(); else openMenu(); });
  menu.addEventListener('click', (e) => { const b = e.target.closest('button[data-k]'); if (!b) return; close(); ({ in: doSignIn, out: () => m365.signOut(), settings })[b.dataset.k](); });
  document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !menu.contains(e.target) && !btn.contains(e.target)) close(); }, true);

  function settings() {
    const c = m365.getConfig(), ru = m365.redirectUri();
    const d = openModal('Microsoft 365 settings', `
      <div class="set-sec"><label class="fld"><span>Application (client) ID</span><input id="cfgId" spellcheck="false" autocomplete="off" placeholder="00000000-0000-0000-0000-000000000000" value="${esc(c.clientId)}"></label>
      <label class="fld"><span>Tenant</span><input id="cfgTenant" spellcheck="false" autocomplete="off" placeholder="organizations, contoso.com or a tenant ID" value="${esc(c.tenant)}"></label>
      <div class="set-err" id="cfgErr" role="alert"></div></div>
      <div class="set-sec help"><b>One-time setup by your Microsoft 365 admin (or you, if allowed to register apps)</b>
      <ol><li>Entra admin centre › App registrations › <b>New registration</b>, supported accounts: <i>this organisation only</i>.</li>
      <li>Authentication › Add platform › <b>Single-page application</b>, redirect URI:<br><code id="ruri">${esc(ru)}</code> <button class="lnk" id="cpRu">copy</button></li>
      <li>API permissions › Microsoft Graph › <b>Delegated</b>: <code>User.Read</code>, <code>User.ReadBasic.All</code>, <code>People.Read</code> (find colleagues); <code>Mail.ReadWrite</code>, <code>Mail.Send</code> (reminder and sharing emails, asked only when first used); <code>Files.ReadWrite</code> (publish a project to your OneDrive for read-only sharing), <code>Files.Read.All</code> (open projects shared with you).</li>
      <li>Copy the <b>Application (client) ID</b> here. To pre-fill it for everyone, put it in <code>m365.config.json</code> next to the app.</li></ol>
      <p class="mut">No client secret is used. Sign-in happens in a Microsoft popup with your corporate account; the app never sees your password.</p></div>
      <div class="rem-actions"><span style="flex:1"></span><button id="cfgSave" class="primary">Save</button></div>`, {});
    d.body.querySelector('#cpRu').addEventListener('click', () => { navigator.clipboard?.writeText(ru).then(() => ctx.toast('Redirect URI copied'), () => {}); });
    d.body.querySelector('#cfgSave').addEventListener('click', () => {
      const err = m365.saveConfig({ clientId: d.body.querySelector('#cfgId').value, tenant: d.body.querySelector('#cfgTenant').value || 'organizations' });
      if (err) { d.body.querySelector('#cfgErr').textContent = err; return; }
      d.close(); ctx.toast('Saved. Click Microsoft 365 to sign in.');
    });
    d.body.querySelector('#cfgId').focus();
  }

  m365.onAuthChange(paint); paint();
  return { settings, signIn: doSignIn };
}
