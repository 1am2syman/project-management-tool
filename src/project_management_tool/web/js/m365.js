// Microsoft 365 connection: MSAL (popup, PKCE, tokens kept in localStorage by MSAL) + a small Microsoft Graph client.
// No secrets live here: this is a public-client SPA, the user signs in with their corporate account and every
// Graph call runs with that user's delegated permissions.
import { isEmail } from './model.js';

const CFG_KEY = 'pm-m365-cfg';
export const SCOPES_SIGNIN = ['User.Read', 'User.ReadBasic.All', 'People.Read']; // read-only: who is in the org
export const SCOPES_MAIL = ['Mail.ReadWrite', 'Mail.Send'];                       // only requested when reminders are synced
export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const redirectUri = () => new URL('redirect.html', location.href).href;

const listeners = new Set();
export const onAuthChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => { for (const f of listeners) f(); };

// Test hook: lets automated tests supply a fake sign-in. Only honoured on localhost so it can never replace real sign-in in production.
const hook = () => (['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname) ? window.__pmAuth : null);

let cfg = { clientId: '', tenant: 'organizations' }, app = null, account = null, loading = null;

export class GraphError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

// ---------- configuration ----------
export const getConfig = () => ({ ...cfg });
export const isConfigured = () => GUID.test(cfg.clientId);
export function validateConfig(c) {
  if (!GUID.test(String(c.clientId || '').trim())) return 'Application (client) ID must be a GUID, e.g. 00000000-0000-0000-0000-000000000000';
  const t = String(c.tenant || '').trim();
  if (!(GUID.test(t) || /^(organizations|common|consumers)$/i.test(t) || /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(t))) return 'Tenant must be a tenant ID, a domain such as contoso.com, or "organizations"';
  return null;
}
export async function loadConfig() {
  let c = null;
  try { c = JSON.parse(localStorage.getItem(CFG_KEY)); } catch { /* none */ }
  if (!c || !c.clientId) { // optional deployment default, so employees never have to type an ID
    try { const r = await fetch('m365.config.json', { cache: 'no-cache' }); if (r.ok) c = await r.json(); } catch { /* no file */ }
  }
  if (c && !validateConfig(c)) cfg = { clientId: c.clientId.trim(), tenant: String(c.tenant || 'organizations').trim() };
  if (hook()) account = hook().account || null; // test hook: lets automated tests supply a fake sign-in
  emit();
}
export function saveConfig(c) {
  const err = validateConfig(c); if (err) return err;
  const changed = c.clientId.trim() !== cfg.clientId || c.tenant.trim() !== cfg.tenant;
  cfg = { clientId: c.clientId.trim(), tenant: c.tenant.trim() };
  try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch { /* storage blocked */ }
  if (changed) { app = null; loading = null; account = null; }
  emit(); return null;
}

// ---------- auth ----------
function loadScript(src) {
  return new Promise((ok, fail) => {
    if (window.msal) return ok();
    const s = document.createElement('script'); s.src = src; s.onload = () => ok(); s.onerror = () => fail(new Error('Could not load the Microsoft sign-in library (vendor/msal-browser.min.js)'));
    document.head.appendChild(s);
  });
}
async function getApp() {
  if (app) return app;
  if (!isConfigured()) throw new Error('Microsoft 365 is not configured yet: open Microsoft 365 > Settings and enter the app (client) ID');
  loading ||= (async () => {
    await loadScript('vendor/msal-browser.min.js');
    const a = new window.msal.PublicClientApplication({
      auth: { clientId: cfg.clientId, authority: `https://login.microsoftonline.com/${cfg.tenant}`, redirectUri: redirectUri(), postLogoutRedirectUri: location.origin + location.pathname },
      cache: { cacheLocation: 'localStorage' },
    });
    await a.initialize();
    const accs = a.getAllAccounts(); if (accs.length) { account = accs[0]; a.setActiveAccount(account); }
    app = a; return a;
  })();
  try { return await loading; } catch (e) { loading = null; throw e; }
}
export async function init() { await loadConfig(); if (isConfigured() && !hook()) { try { await getApp(); emit(); } catch { /* shown on demand */ } } }

export const isSignedIn = () => !!account;
export const currentAccount = () => (account ? { name: account.name || account.username, email: account.username } : null);

export async function signIn(extraScopes = []) { // extraScopes are consented in the same popup (a second popup after an await would be blocked)
  if (hook()) { account = hook().account; emit(); return account; }
  const a = await getApp();
  const r = await a.loginPopup({ scopes: SCOPES_SIGNIN, ...(extraScopes.length ? { extraScopesToConsent: extraScopes } : {}), prompt: 'select_account' });
  account = r.account; a.setActiveAccount(account); emit(); return account;
}
export async function signOut() {
  const a = app, acc = account; account = null; emit();
  if (hook()) return;
  if (a && acc) { try { await a.logoutPopup({ account: acc, mainWindowRedirectUri: location.pathname }); } catch { /* user closed the popup; local state is already cleared */ } }
}
export async function token(scopes, interactive = true) {
  if (hook()) return hook().token(scopes);
  const a = await getApp(); if (!account) throw new Error('Not signed in');
  try { return (await a.acquireTokenSilent({ scopes, account })).accessToken; }
  catch (e) {
    if (!interactive) throw e; // background (auto) syncs must never open a popup
    if (e && (e.name === 'InteractionRequiredAuthError' || /interaction_required|consent_required|login_required/.test(e.errorCode || ''))) return (await a.acquireTokenPopup({ scopes, account })).accessToken;
    throw e;
  }
}

// ---------- Graph ----------
const GRAPH = 'https://graph.microsoft.com/v1.0';
export async function graph(path, { method = 'GET', body, raw, headers = {}, scopes = SCOPES_SIGNIN, interactive = true } = {}) {
  const url = path.startsWith('http') ? path : GRAPH + path;
  for (let attempt = 0; ; attempt++) {
    const t = await token(scopes, interactive);
    const res = await fetch(url, { method, headers: { Authorization: `Bearer ${t}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
    if ((res.status === 429 || res.status === 503) && attempt < 3) { await new Promise((r) => setTimeout(r, Math.min(8, Number(res.headers.get('Retry-After')) || 2 ** attempt) * 1000)); continue; }
    if (res.status === 204 || res.status === 202) return null;
    let data = null; try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) throw new GraphError(res.status, (data && data.error && data.error.message) || `Graph request failed (${res.status})`, data && data.error && data.error.code);
    return data;
  }
}

const SEL = 'id,displayName,mail,userPrincipalName,jobTitle,department';
export function person(u) {
  const email = [u.mail, u.userPrincipalName].find((x) => isEmail(x)) || '';
  return { id: u.id || email, name: u.displayName || email, email, title: u.jobTitle || '', dept: u.department || '' };
}
export async function me(interactive = true) { return person(await graph(`/me?$select=${SEL}`, { interactive })); }
export async function searchPeople(q) {
  q = String(q).replace(/["\\]/g, ' ').trim(); if (q.length < 2) return [];
  const d = await graph(`/users?$search=${encodeURIComponent(`"displayName:${q}" OR "mail:${q}" OR "userPrincipalName:${q}"`)}&$select=${SEL}&$top=15`, { headers: { ConsistencyLevel: 'eventual' } });
  return (d.value || []).map(person).filter((p) => p.email);
}
export async function relevantPeople() { // the people this user works with most (People.Read)
  const d = await graph('/me/people?$top=25&$select=id,displayName,scoredEmailAddresses,jobTitle,department');
  return (d.value || []).map((u) => ({ id: u.id, name: u.displayName, email: ((u.scoredEmailAddresses || []).map((e) => e.address).find(isEmail)) || '', title: u.jobTitle || '', dept: u.department || '' })).filter((p) => p.email);
}

// ---------- mail ----------
const DEFERRED = 'SystemTime 0x3FEF'; // PidTagDeferredSendTime: Exchange Online holds the message until this UTC time, even if the browser is closed
const msg = (to, subject, html) => ({ subject, body: { contentType: 'HTML', content: html }, toRecipients: [].concat(to).map((p) => ({ emailAddress: { address: p.email, name: p.name } })) });
export async function scheduleMail(to, subject, html, sendAt, interactive = true) {
  const draft = await graph('/me/messages', {
    method: 'POST', scopes: SCOPES_MAIL, interactive, headers: { Prefer: 'IdType="ImmutableId"' },
    body: { ...msg(to, subject, html), singleValueExtendedProperties: [{ id: DEFERRED, value: new Date(sendAt).toISOString() }] },
  });
  try { await graph(`/me/messages/${encodeURIComponent(draft.id)}/send`, { method: 'POST', scopes: SCOPES_MAIL, interactive }); }
  catch (e) { try { await graph(`/me/messages/${encodeURIComponent(draft.id)}`, { method: 'DELETE', scopes: SCOPES_MAIL, interactive }); } catch { /* leave draft */ } throw e; }
  return draft.id;
}
export async function cancelMail(id, interactive = true) {
  try { await graph(`/me/messages/${encodeURIComponent(id)}`, { method: 'DELETE', scopes: SCOPES_MAIL, interactive }); return true; }
  catch (e) { if (e.status === 404) return true; throw e; } // already gone (sent or deleted)
}
export const SCOPES_SEND = ['Mail.Send']; // confirmation emails only need to send, not to read or edit the mailbox
export const sendNow = (to, subject, html) => graph('/me/sendMail', { method: 'POST', scopes: SCOPES_SEND, body: { message: msg(to, subject, html), saveToSentItems: true } });

// ---------- OneDrive sharing (read-only grants are real OneDrive permissions, enforced by Microsoft 365) ----------
export const SCOPES_FILES = ['Files.ReadWrite'];       // publish my project file and grant access to it
export const SCOPES_FILES_READ = ['Files.Read.All'];   // open projects that others shared with me
const safeName = (s) => String(s).replace(/[\\/:*?"<>|#%~&{}]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Project';
const item = (it) => ({ driveId: it.parentReference && it.parentReference.driveId, itemId: it.id, webUrl: it.webUrl || '' });
export async function publishFile(name, json, existing, interactive = true) {
  const o = { method: 'PUT', scopes: SCOPES_FILES, interactive, headers: { 'Content-Type': 'application/json' }, raw: json };
  const path = existing ? `/drives/${encodeURIComponent(existing.driveId)}/items/${encodeURIComponent(existing.itemId)}/content` : `/me/drive/root:/Plan%20projects/${encodeURIComponent(safeName(name))}.plan.json:/content?@microsoft.graph.conflictBehavior=rename`;
  return item(await graph(path, o));
}
const grantee = (p) => {
  const u = (p.grantedToV2 && p.grantedToV2.user) || (p.grantedTo && p.grantedTo.user) || {};
  return { uid: u.id || '', email: String(u.email || (p.invitation && p.invitation.email) || '').toLowerCase(), name: u.displayName || '' };
};
export async function createGrant(it, emails) { // read-only, signed-in users only, no Microsoft invitation mail (we send our own confirmation)
  const r = await graph(`/drives/${encodeURIComponent(it.driveId)}/items/${encodeURIComponent(it.itemId)}/invite`, { method: 'POST', scopes: SCOPES_FILES, body: { recipients: emails.map((email) => ({ email })), roles: ['read'], requireSignIn: true, sendInvitation: false } });
  const v = r.value || [];
  // the response lists one permission per recipient, in request order: use position first, then the e-mail as a fallback
  return emails.map((e, i) => { const p = v.length === emails.length ? v[i] : v.find((x) => grantee(x).email === e.toLowerCase()); return p ? { id: p.id, ...grantee(p) } : null; });
}
export async function listGrants(it) {
  const out = []; let url = `/drives/${encodeURIComponent(it.driveId)}/items/${encodeURIComponent(it.itemId)}/permissions`;
  for (let page = 0; url && page < 10; page++) {
    const r = await graph(url, { scopes: SCOPES_FILES });
    for (const p of r.value || []) if (!(p.roles || []).includes('owner')) out.push({ id: p.id, roles: p.roles || [], link: !!p.link, ...grantee(p) });
    url = r['@odata.nextLink'] || '';
  }
  return out;
}
export const revokeGrant = (it, permId) => graph(`/drives/${encodeURIComponent(it.driveId)}/items/${encodeURIComponent(it.itemId)}/permissions/${encodeURIComponent(permId)}`, { method: 'DELETE', scopes: SCOPES_FILES });
export async function fetchShared(driveId, itemId) {
  const meta = await graph(`/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}?$select=id,name,lastModifiedDateTime,createdBy,lastModifiedBy,@microsoft.graph.downloadUrl`, { scopes: SCOPES_FILES_READ });
  const url = meta['@microsoft.graph.downloadUrl']; if (!url) throw new GraphError(404, 'This project has no downloadable content');
  const res = await fetch(url); if (!res.ok) throw new GraphError(res.status, `Could not download the project (${res.status})`);
  const by = (meta.createdBy && meta.createdBy.user) || {};
  return { snapshot: await res.json(), by: by.displayName || '', byEmail: by.email || '', modified: meta.lastModifiedDateTime };
}
// deep link that opens a shared project in this app
export const b64 = (o) => btoa(unescape(encodeURIComponent(JSON.stringify(o)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64 = (s) => JSON.parse(decodeURIComponent(escape(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')))));
export const shareLink = (it) => `${location.origin}${location.pathname}#open=${b64({ d: it.driveId, i: it.itemId })}`;
