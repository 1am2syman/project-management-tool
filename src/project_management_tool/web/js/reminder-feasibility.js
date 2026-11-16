// Separate maintainer-only harness. Never changes browser scheduler ownership.
const output = document.querySelector('#status');
const message = document.querySelector('#message');
const buttons = [...document.querySelectorAll('button')];
let busy = false;

async function request(operation, mutation = false) {
  const response = await fetch(`/api/reminder-feasibility/${operation}`, mutation
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
    : { cache: 'no-store' });
  const value = await response.json();
  if (!response.ok) throw new Error(value.message || value.error || 'Native feasibility operation failed');
  return value;
}
async function refresh() {
  try { output.textContent = JSON.stringify(await request('status'), null, 2); }
  catch (error) { output.textContent = error.message; }
}
for (const button of document.querySelectorAll('[data-action]')) {
  button.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    buttons.forEach((element) => { element.disabled = true; });
    message.textContent = button.dataset.action === 'connect' ? 'Complete sign-in in the Microsoft browser window…' : 'Working…';
    try {
      const result = await request(button.dataset.action, true);
      message.textContent = result.message || (result.state === 'pending' ? 'One self-test queued. You may close the browser and server now.' : 'Operation completed.');
    } catch (error) { message.textContent = error.message; }
    finally {
      await refresh();
      busy = false;
      buttons.forEach((element) => { element.disabled = false; });
    }
  });
}
document.querySelector('#refresh').addEventListener('click', refresh);
setInterval(() => { if (!busy && !document.hidden) refresh(); }, 15000);
refresh();
