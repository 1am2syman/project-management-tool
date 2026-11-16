import { diagnostics } from './diagnosticlog.js';

// File handles are browser-local capabilities, separate from portable project files and SQLite.
// If IndexedDB is unavailable, normal Save still works for the current page session.
export function createFileBindings(browser) {
  const memory = new Map();
  let database;
  const db = () => database ||= diagnostics.trace('fileBindings.database.open', () => new Promise((resolve) => {
    if (!browser.indexedDB) { diagnostics.record('fileBindings.database.unavailable', {}, 'warn'); return resolve(null); }
    const request = browser.indexedDB.open('plan-project-file-handles', 1);
    request.onupgradeneeded = () => { diagnostics.record('fileBindings.database.upgrade'); request.result.createObjectStore('files'); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { diagnostics.record('fileBindings.database.error', { error: request.error }, 'error'); resolve(null); };
    request.onblocked = () => { diagnostics.record('fileBindings.database.blocked', {}, 'warn'); resolve(null); };
  }));
  async function read(token) {
    if (memory.has(token)) { diagnostics.record('fileBindings.read.memory'); return memory.get(token); }
    try {
      const database = await db(); if (!database) return null;
      const record = await diagnostics.trace('fileBindings.read', () => new Promise((resolve, reject) => {
        const request = database.transaction('files').objectStore('files').get(token);
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      }));
      if (record) memory.set(token, record);
      return record || null;
    } catch (error) { diagnostics.record('fileBindings.read.fallback', { error }, 'warn'); return null; }
  }
  async function write(token, record) {
    memory.set(token, record);
    try {
      const database = await db(); if (!database) return;
      await diagnostics.trace('fileBindings.write', () => new Promise((resolve, reject) => {
        const tx = database.transaction('files', 'readwrite'); tx.objectStore('files').put(record, token);
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
      }));
    } catch (error) { diagnostics.record('fileBindings.write.fallback', { error }, 'warn'); /* memory binding remains available */ }
  }
  return { read, write };
}
