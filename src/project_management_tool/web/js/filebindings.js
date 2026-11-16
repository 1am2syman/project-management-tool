// File handles are browser-local capabilities, separate from portable project files and SQLite.
// If IndexedDB is unavailable, normal Save still works for the current page session.
export function createFileBindings(browser) {
  const memory = new Map();
  let database;
  const db = () => database ||= new Promise((resolve) => {
    if (!browser.indexedDB) return resolve(null);
    const request = browser.indexedDB.open('plan-project-file-handles', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('files');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  async function read(token) {
    if (memory.has(token)) return memory.get(token);
    try {
      const database = await db(); if (!database) return null;
      const record = await new Promise((resolve, reject) => {
        const request = database.transaction('files').objectStore('files').get(token);
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      if (record) memory.set(token, record);
      return record || null;
    } catch { return null; }
  }
  async function write(token, record) {
    memory.set(token, record);
    try {
      const database = await db(); if (!database) return;
      await new Promise((resolve, reject) => {
        const tx = database.transaction('files', 'readwrite'); tx.objectStore('files').put(record, token);
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
      });
    } catch { /* memory binding remains available; a later reload may require Open again */ }
  }
  return { read, write };
}
