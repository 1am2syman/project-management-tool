// Critical-path display is independent of the calendar-aware total/free float calculation.
export const DEFAULT_CRITICAL_PATH = { method: 'float', threshold: 0 };
export function validCriticalPath(value) {
  return !!value && ['float', 'longest'].includes(value.method) && Number.isSafeInteger(value.threshold) && value.threshold >= 0 && value.threshold <= 99999999;
}
export function cleanCriticalPath(value) {
  return validCriticalPath(value) ? { method: value.method, threshold: value.threshold } : { ...DEFAULT_CRITICAL_PATH };
}
export function criticalPathFields(value) {
  const options = cleanCriticalPath(value);
  return options.method !== 'float' || options.threshold !== 0 ? { criticalPath: options } : {};
}
export function criticalPathLabel(value) {
  const { method, threshold } = cleanCriticalPath(value);
  return method === 'longest' ? 'Longest Path' : `Total Float <= ${threshold} working days`;
}

// Trace the relationships that place each successor at its current earliest start.
// Each bound uses the RECEIVING calendar (including lag and finish-to-start conversion).
// Endpoint date equality alone misses ties separated by nonworking calendar periods.
export function drivingPaths(store, leaves, completion, target) {
  const tasks = new Set(), links = new Set();
  for (const link of store.links) {
    const predecessor = store.byId.get(link.from), successor = store.byId.get(link.to), work = store.workFor(successor);
    const source = link.type[0] === 'F' ? store.finish(predecessor) : predecessor.start;
    const bound = link.type[1] === 'S' ? work.shift(source, link.lag) : work.start(work.shiftEnd(source, link.lag), successor.dur);
    link.driving = !link.violated && successor.scheduling !== 'manual' && work.next(bound) === successor.start;
    link.longestPath = false;
  }
  const queue = target ? [target.id] : leaves.filter((task) => store.finish(task) === completion).map((task) => task.id);
  for (const id of queue) tasks.add(id);
  for (let i = 0; i < queue.length; i++) {
    for (const link of store.incoming(queue[i])) {
      if (!link.driving) continue;
      links.add(link.id); link.longestPath = true;
      if (!tasks.has(link.from)) { tasks.add(link.from); queue.push(link.from); }
    }
  }
  return { tasks, links };
}
