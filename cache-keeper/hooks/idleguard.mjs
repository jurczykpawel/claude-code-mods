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
  const s = { blocked: 0, passed: 0, overridden: 0, lastBlockedAt: 0 }
  for (const ev of events) {
    if (ev.kind !== 'idle-compact' || ev.at < since) continue
    if (ev.outcome === 'blocked') {
      s.blocked += 1
      s.lastBlockedAt = Math.max(s.lastBlockedAt, ev.at)
    } else if (ev.outcome === 'passed') s.passed += 1
    else if (ev.outcome === 'overridden') s.overridden += 1
  }
  return s
}

// What session.compact must return to veto: { skip } with a non-empty string
// reason. Anything else (true, an empty string) is rejected by Claude Code and
// the compaction runs anyway.
export function vetoResult(decision) {
  return { skip: `cache-keeper: ${decision.reason}, keep warm is on and nobody has written for a long time` }
}

// A veto that Claude Code ignored shows up as the context collapsing soon after
// it. `blocked` is { at, ctx } of the last veto; within 10 minutes a context
// under half of what it was means the compaction ran anyway.
export function blockOverridden(blocked, nowMs, ctxNow) {
  if (!blocked || !blocked.ctx) return false
  return nowMs - blocked.at <= 10 * MIN && ctxNow < blocked.ctx * 0.5
}
