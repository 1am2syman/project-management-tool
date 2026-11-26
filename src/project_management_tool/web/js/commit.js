import { appState } from './appstate.js';
// Commit ordering and immutable attempted states. Unchanged branches are shared, including
// unrelated projects and retained history; freezing and comparison stop at shared branches.
export function immutable(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
// Canonicalize only new branches. The exact attempted value must be representable
// over JSON; omitted optional members must never become invalid patch set values.
export function canonicalState(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = value[i] === undefined ? null : canonicalState(value[i]);
  } else {
    for (const key of Object.keys(value)) {
      if (value[key] === undefined) delete value[key]; else value[key] = canonicalState(value[key]);
    }
  }
  return value;
}
export function sameState(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameState(a[key], b[key]));
}
// Cosmetic fields can accompany a real action, but cannot turn a no-op into a write.
function substantiveChange(a, b, path = []) {
  if (a === b) return false;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return true;
  const include = key => !(path.length === 1 && path[0] === 'browser' && appState.isCosmetic(key)) &&
    !(path.length === 1 && path[0] === 'workbook' && key === 'active') &&
    !(path.length === 4 && path[0] === 'workbook' && path[1] === 'sheets' && path[3] === 'data' && key === 'collapsed');
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (include(key) && substantiveChange(a[key], b[key], [...path, key])) return true;
  return false;
}
export class CommitCancelled extends Error {
  constructor() { super('Action cancelled'); this.name = 'CommitCancelled'; }
}
export class CommitCoordinator {
  constructor(store, persist) { this.store = store; this.persist = persist; this.pending = false; this.suspended = false; this.candidate = null; this.error = null; this.operation = null; }
  run(command, prepared = null, errorStrings = false) {
    if (this.store.locked) return Promise.reject(new Error('This workspace is read-only in this tab'));
    if (this.suspended) return Promise.reject(this.error || new Error('Workspace is suspended; reload or verify retry first'));
    if (this.pending || (this.store.dragPreview && !prepared)) return Promise.reject(new Error('Finish the pending action first'));
    try { prepared ||= this.store.makeDraft(); } catch (error) { return Promise.reject(error); }
    this.pending = true;
    const operation = Promise.resolve().then(() => this.execute(command, prepared, errorStrings));
    this.operation = operation;
    this.store.emit('pending');
    // Rejection stays observable to the caller and barriers already waiting on this
    // action, without an unhandled rejection if a legacy handler ignores the result.
    operation.catch(() => {});
    return operation;
  }
  async execute(command, prepared, errorStrings) {
    let attempted = false;
    try {
      const draft = prepared || this.store.makeDraft();
      const result = await this.store.inDraft(draft, () => command(draft));
      await draft.finishHooks();
      if (result?.error || (errorStrings && typeof result === 'string')) return result;
      if (draft._cancelled) throw new CommitCancelled();
      const candidate = immutable(canonicalState(draft.candidateState()));
      const base = this.store._committedState;
      if (!substantiveChange(candidate, base)) return result;
      this.candidate = candidate;
      this.draft = draft;
      attempted = true;
      await this.persist(candidate, base);
      this.pending = false;
      this.store.decisionPreview = null; this.store.dragPreview = null;
      this.candidate = null; this.draft = null; this.error = null;
      this.store.adoptCandidate(candidate, draft);
      return result;
    } catch (error) {
      if (error instanceof CommitCancelled) return { cancelled: true };
      if (attempted && error?.status !== 400 && error?.status !== 422 && error?.validation !== true) {
        this.suspended = true; this.error = error;
      } else { this.candidate = null; this.draft = null; }
      throw error;
    } finally {
      this.pending = false;
      this.store.decisionPreview = null;
      this.store.dragPreview = null;
      // A definitive rejection leaves no pending candidate. Later idle barriers
      // must check current input/suspension instead of replaying the old error.
      if (!this.suspended) this.operation = null;
      this.store.emit(this.suspended ? 'suspended' : 'idle');
    }
  }
  async whenIdle() { if (this.operation) await this.operation; if (this.suspended) throw this.error; }
  adopt(state) {
    if (this.pending) throw new Error('The original action is still pending');
    if (!this.candidate || !sameState(state, this.candidate)) throw new Error('Retry did not verify the exact attempted state');
    const candidate = this.candidate, draft = this.draft;
    this.suspended = false; this.error = null; this.candidate = null; this.draft = null; this.operation = null;
    this.store.adoptCandidate(candidate, draft);
  }
}
