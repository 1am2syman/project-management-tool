import test from 'node:test';
import assert from 'node:assert/strict';
import { createPeople } from '../src/project_management_tool/web/js/people.js';
import { Store } from '../src/project_management_tool/web/js/model.js';

test('owner resolution uses only workbook contacts, handles ambiguous names and reflects edits', () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Local owner lookup cannot use network'); };
  try {
    const store = { wb: { sheets: [{ data: { tasks: [{ owner: 'Alex', email: 'alex@example.com' }, { owner: 'No address', email: '' }] } }, { data: { tasks: [{ owner: 'Alex', email: 'other@example.com' }, { owner: 'Blair', email: 'blair@example.com' }] } }] } };
    const picker = createPeople({ store });
    assert.equal(picker.resolve('Alex'), null);
    assert.equal(picker.resolve('BLAIR').email, 'blair@example.com');
    assert.equal(picker.resolve('alex@example.com').name, 'Alex');
    assert.equal(picker.resolve('No address'), null);
    store.wb.sheets[1].data.tasks[1].owner = 'Renamed';
    assert.equal(picker.resolve('Blair'), null);
    assert.equal(picker.resolve('Renamed').email, 'blair@example.com');
    assert.equal(picker.known().length, 3);
  } finally { globalThis.fetch = original; }
});

test('legacy settings stay inert across a saved workspace and editable snapshot copy', () => {
  const store = new Store();
  store.setRem({ on: true, auto: true, timezone: 'UTC' });
  const before = store.savedState();
  const restored = new Store(before);
  assert.equal(restored.rem.on, true, 'metadata retained for compatibility');
  assert.equal(restored.rem.timezone, 'UTC');
  const id = restored.importShared(restored.data, 'Older snapshot', { driveId: 'old', itemId: 'old', by: 'Earlier version', fetchedAt: 0 });
  restored.switchSheet(id);
  assert(restored.readOnly);
  restored.duplicateSheet(id);
  assert(!restored.readOnly);
  assert.equal(restored.sheet().share, undefined);
});
