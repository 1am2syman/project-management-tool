// UTC day-number arithmetic. Legacy projects use all seven days until configured.
const DAY = 86400000;
export const DEFAULT_CALENDAR = { workdays: [0, 1, 2, 3, 4, 5, 6], holidays: [] };
export function dateDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const day = Date.parse(value + 'T00:00:00Z') / DAY;
  return Number.isInteger(day) && new Date(day * DAY).toISOString().slice(0, 10) === value ? day : null;
}
export function calendarError(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.workdays) || !value.workdays.length || value.workdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6) || new Set(value.workdays).size !== value.workdays.length) return 'Choose at least one working weekday';
  if (!Array.isArray(value.holidays) || value.holidays.length > 10000) return 'Use at most 10,000 holidays';
  const dates = new Set();
  for (const holiday of value.holidays) {
    if (!holiday || dateDay(holiday.date) == null || typeof holiday.name !== 'string' || holiday.name.length > 100) return 'Each holiday needs a valid date and a name of at most 100 characters';
    if (dates.has(holiday.date)) return `Holiday ${holiday.date} is listed twice`;
    dates.add(holiday.date);
  }
  return null;
}
export function cleanCalendar(value) {
  if (calendarError(value)) return { workdays: [...DEFAULT_CALENDAR.workdays], holidays: [] };
  return { workdays: [...value.workdays].sort(), holidays: value.holidays.map((h) => ({ date: h.date, name: h.name.trim() })).sort((a, b) => a.date.localeCompare(b.date)) };
}
const lower = (items, n) => { let a = 0, b = items.length; while (a < b) { const m = (a + b) >>> 1; if (items[m] < n) a = m + 1; else b = m; } return a; };
const weekday = (day) => ((day + 4) % 7 + 7) % 7;
export class WorkingCalendar {
  constructor(value) {
    this.value = cleanCalendar(value); this.week = new Set(this.value.workdays);
    this.holidays = this.value.holidays.map((h) => dateDay(h.date)).filter((d) => this.week.has(weekday(d))).sort((a, b) => a - b);
    this.off = new Set(this.holidays);
  }
  isWork(day) { return this.week.has(weekday(day)) && !this.off.has(day); }
  next(day, direction = 1) { if (!Number.isFinite(day)) return day; if (!Number.isSafeInteger(day)) return NaN; while (!this.isWork(day)) day += direction; return day; }
  // Working days in [a,b); full weeks and holiday binary searches keep long plans cheap.
  count(a, b) {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return b - a;
    if (b < a) return -this.count(b, a);
    if (b === a) return 0;
    const weeks = Math.floor((b - a) / 7); let n = weeks * this.week.size;
    for (let d = a + weeks * 7; d < b; d++) if (this.week.has(weekday(d))) n++;
    return n - (lower(this.holidays, b) - lower(this.holidays, a));
  }
  finish(start, duration) {
    if (!Number.isSafeInteger(duration) || duration < 0) return NaN;
    if (!duration || !Number.isFinite(start)) return start;
    let lo = start, hi = start + Math.ceil(duration / this.week.size) * 7 + this.holidays.length * 7 + 1;
    while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (this.count(start, mid + 1) >= duration) hi = mid; else lo = mid + 1; }
    return lo + 1;
  }
  start(end, duration) {
    if (!Number.isSafeInteger(duration) || duration < 0) return NaN;
    if (!duration || !Number.isFinite(end)) return end;
    let lo = end - Math.ceil(duration / this.week.size) * 7 - this.holidays.length * 7 - 1, hi = end;
    while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (this.count(mid, end) >= duration) lo = mid; else hi = mid - 1; }
    return lo === 0 ? 0 : lo;
  }
  shift(day, amount) {
    if (!Number.isFinite(day)) return day;
    const base = this.next(day);
    return amount >= 0 ? this.finish(base, amount + 1) - 1 : this.start(base + 1, 1 - amount);
  }
  shiftEnd(end, amount) { return Number.isFinite(end) ? this.shift(end - 1, amount) + 1 : end; }
}
