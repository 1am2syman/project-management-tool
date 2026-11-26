// The storage boundary carries final JSON data, never replayable domain commands.
export function sameJSON(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((value, index) => sameJSON(value, b[index]));
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && sameJSON(a[key], b[key]));
}
export function changesBetween(before, after, path = [], changes = []) {
  if (before === after) return changes;
  const firstChange = changes.length;
  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length === after.length) {
      // A capped undo stack drops its oldest entry and appends one snapshot.
      // Preserve every retained blob/path hash instead of replacing all indices.
      if (before.length > 1 && !sameJSON(before[0], after[0]) && before.slice(1).every((value, index) => sameJSON(value, after[index]))) {
        changes.push({ op: 'splice', path, start: 0, deleteCount: 1, items: [] });
        changes.push({ op: 'splice', path, start: after.length - 1, deleteCount: 0, items: [after.at(-1)] });
      } else for (let i = 0; i < before.length; i++) changesBetween(before[i], after[i], [...path, i], changes);
    } else {
      let start = 0, end = 0;
      while (start < Math.min(before.length, after.length) && sameJSON(before[start], after[start])) start++;
      while (end < Math.min(before.length, after.length) - start && sameJSON(before[before.length - 1 - end], after[after.length - 1 - end])) end++;
      changes.push({ op: 'splice', path, start, deleteCount: before.length - start - end, items: after.slice(start, after.length - end) });
    }
  } else if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
    for (const key of Object.keys(before)) if (!Object.hasOwn(after, key)) changes.push({ op: 'remove', path: [...path, key] });
    for (const key of Object.keys(after)) {
      if (!Object.hasOwn(before, key)) changes.push({ op: 'set', path: [...path, key], value: after[key] });
      else changesBetween(before[key], after[key], [...path, key], changes);
    }
  } else if (!sameJSON(before, after)) changes.push({ op: 'set', path, value: after });
  // Large affected components can be replaced in one operation. Keep this below
  // the server's dialect limit without pulling in sibling projects/history.
  if (path.length >= 3 && changes.length - firstChange > 2000) changes.splice(firstChange, changes.length - firstChange, { op: 'set', path, value: after });
  return changes;
}
