// Keep this entry point outside the module graph: dependency failures must reach the UI and Log.
(() => {
  const log = window.PlanDiagnostics;
  let operation;
  try { operation = log?.begin('app.load'); } catch { /* logging is optional */ }
  import('./main.js').then(() => {
    try { operation?.end(); } catch { /* logging is optional */ }
  }, (error) => {
    try { operation?.fail(error); } catch { /* logging is optional */ }
    const badge = document.querySelector('#save-status');
    if (badge) {
      badge.textContent = 'Startup failed · Open Log';
      badge.dataset.state = 'error';
      badge.disabled = false;
      badge.addEventListener('click', () => document.querySelector('#logbtn')?.click());
    }
    const banner = document.querySelector('#startup-error');
    if (banner) {
      banner.hidden = false;
      banner.querySelector('[data-startup-reload]').addEventListener('click', () => location.reload());
      banner.querySelector('[data-startup-log]').addEventListener('click', () => document.querySelector('#logbtn')?.click());
    }
  });
})();
