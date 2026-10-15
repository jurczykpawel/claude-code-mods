// Keep warm stops at its time limit and the cache then expires, so a big chat
// ends up rewritten at full price on the next message. Just before the last ping
// the cache is still warm, which is the cheapest moment to compact it: the
// compaction request reads the context at the cache price instead of rewriting
// it. Pure function, no `$`, tested on its own (node --test cache-keeper/tests/).

import { pingMarginMs } from './ledger.mjs'

const MIN = 60000
const AWAY_MS = 30 * MIN // same silence the idle guard uses

export function endCompactDue({ keepWarmOn, working, ttlMin, ctx, threshold, lastActivity, now, keepWarmUntil, silentMs }) {
  if (!keepWarmOn || working || !threshold || ctx < threshold || !lastActivity) return false
  if (silentMs < AWAY_MS) return false
  const ttlMs = ttlMin * MIN
  const interval = ttlMs - pingMarginMs(ttlMin) // ping to ping
  if (now >= lastActivity + ttlMs) return false // already expired: compacting would rewrite at full price
  if (now >= keepWarmUntil) return true // the limit hit while the cache was still warm
  if (now < lastActivity + interval) return false // cache is fresh, nothing to do yet
  return now + interval >= keepWarmUntil // the ping after this one would not happen
}
