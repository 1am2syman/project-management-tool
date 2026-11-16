// Optional bridge: diagnostics must not change app behavior when disabled or unavailable.
const noop = { end() {}, fail() {} };
export const diagnostics = {
  record(event, detail, level) { try { globalThis.PlanDiagnostics?.record(event, detail, level); } catch { /* optional */ } },
  begin(event, detail) { try { return globalThis.PlanDiagnostics?.begin(event, detail) || noop; } catch { return noop; } },
  async trace(event, fn, detail) {
    const span = this.begin(event, detail);
    try { const result = await fn(); span.end(); return result; }
    catch (error) { span.fail(error); throw error; }
  },
};
