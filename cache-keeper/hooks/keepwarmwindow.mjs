// The keep-warm time limit slides: every real message restarts the window, so
// "24 h" means 24 h after the last time someone was here, not 24 h from the
// moment it was switched on. Pure function, tested on its own.
export function slideUntil({ keepWarmOn, spanHours, now, until }) {
  if (!keepWarmOn || !(spanHours > 0)) return until
  return Math.max(until, now + spanHours * 3600000)
}

import { pingMarginMs } from './ledger.mjs'

// A ping is due once the cache has gone ttl minus the margin without a request.
// A turn that is merely waiting (for an answer, a permission, a long command) sends
// no requests, so only a request actually out holds the ping back.
export function pingDue({ requestOut, lastActivity, now, ttlMin }) {
  if (requestOut || !lastActivity) return false
  return now - lastActivity >= ttlMin * 60000 - pingMarginMs(ttlMin)
}
