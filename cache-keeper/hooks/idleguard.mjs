// Claude Code compacts a long chat by itself once nobody has written for about 54
// minutes (built-in idle compaction, ~90% of the 1 h cache). With keep warm on
// that throws away a cache we are paying to hold, so this vetoes it. Pure
// functions, no `$`, tested on their own (node --test cache-keeper/tests/).

const MIN = 60000

// Over normal pauses, under the built-in moment, so a compaction after this much
// silence is the idle one and not auto-compact during work.
export const IDLE_SILENCE_MS = 30 * MIN

export function shouldBlockCompact({ trigger, keepWarmOn, working, silentMs, enabled }) {
  if (!enabled || trigger !== 'auto' || !keepWarmOn || working) return { block: false }
  if (silentMs < IDLE_SILENCE_MS) return { block: false }
  return { block: true, reason: 'idle-with-keep-warm' }
}

export function summarizeIdleBlocks(events, since = 0) {
  const s = { blocked: 0, passed: 0, lastBlockedAt: 0 }
  for (const ev of events) {
    if (ev.kind !== 'idle-compact' || ev.at < since) continue
    if (ev.outcome === 'blocked') {
      s.blocked += 1
      s.lastBlockedAt = Math.max(s.lastBlockedAt, ev.at)
    } else if (ev.outcome === 'passed') s.passed += 1
  }
  return s
}
