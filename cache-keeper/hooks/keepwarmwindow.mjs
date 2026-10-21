// The keep-warm time limit slides: every real message restarts the window, so
// "24 h" means 24 h after the last time someone was here, not 24 h from the
// moment it was switched on. Pure function, tested on its own.
export function slideUntil({ keepWarmOn, spanHours, now, until }) {
  if (!keepWarmOn || !(spanHours > 0)) return until
  return Math.max(until, now + spanHours * 3600000)
}
