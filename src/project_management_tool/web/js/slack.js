// Invert scheduling constraints on actual working-day starts. Finish dates are exclusive.
// This is shared by total slack (successors at their latest dates) and free slack
// (successors fixed at their scheduled dates); endpoint differences alone are not workdays.
export function meetsLink(work, task, start, link, successor, successorStart) {
  const source = link.type[0] === 'F' ? work.finish(start, task.dur) : start;
  const required = link.type[1] === 'S' ? work.shift(source, link.lag) : work.shiftEnd(source, link.lag);
  return required <= (link.type[1] === 'S' ? successorStart : work.finish(successorStart, successor.dur));
}

export function latestAllowedStart(work, task, outgoing, byId, starts, boundary, expand) {
  const fits = (day) => outgoing.every((link) => {
    const successor = byId.get(link.to);
    return meetsLink(work, task, work.next(day, -1), link, successor, starts?.get(link.to) ?? successor.start);
  });
  let latest = boundary;
  // A successor constraint always provides a finite upper bound, even for SS/SF
  // and negative lags which can allow a task to finish after the chosen target.
  if (expand && outgoing.length) {
    let step = 7;
    while (fits(latest)) { latest += step; step *= 2; }
  }
  if (!fits(latest)) {
    let lo = Math.min(task.start, latest), hi = latest, step = 7;
    while (!fits(lo)) { lo -= step; step *= 2; }
    while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (fits(mid)) lo = mid; else hi = mid - 1; }
    latest = lo;
  }
  latest = work.next(latest, -1);
  const next = work.next(latest + 1);
  const limiters = outgoing.filter((link) => {
    const successor = byId.get(link.to);
    return !meetsLink(work, task, next, link, successor, starts?.get(link.to) ?? successor.start);
  }).map((link) => link.id);
  return { start: latest, end: work.finish(latest, task.dur), limiters };
}
