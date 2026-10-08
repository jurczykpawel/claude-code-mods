// Run: node --test cache-keeper/tests/
// Prices used (pricing.mjs, opus-5-5): input $4/M, read $0.2/M, output $20/M,
// write $8/M on the 1-hour TTL and $5/M on 5 minutes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_PARAMS,
  compactionCostUsd,
  savingPerTurnUsd,
  breakEvenTurns,
  breakEvenCtx,
  idleReturnThreshold,
  advise,
  calibrate,
  gapShare,
  stepsPerTurn,
  horizonFrom,
  adviceSummary,
} from '../hooks/compact.mjs'

const MODEL = 'claude-opus-5-5'
// one model request per message keeps the hand-worked numbers below simple
const P = { summaryTokens: 10000, newCtxTokens: 18000, rewriteShare: 1, gapShare: 0.1, horizonTurns: 15, stepsPerTurn: 1 }
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`)
const base = { model: MODEL, ttlMin: 60, params: P }

test('defaults are the values measured in the owner\'s transcripts, rest flagged as assumed', () => {
  // first request after 73 compactions: median 76k tokens in total, 80% of it written
  assert.equal(DEFAULT_PARAMS.newCtxTokens, 76000)
  assert.equal(DEFAULT_PARAMS.rewriteShare, 0.8)
  assert.equal(DEFAULT_PARAMS.horizonTurns, 15)
  assert.equal(DEFAULT_PARAMS.stepsPerTurn, 12) // median of 68 sessions: 12 requests per prompt
})

test('warm compaction = read the context + write the summary + rebuild the prefix', () => {
  const c = compactionCostUsd({ ...base, ctx: 686000, warm: true })
  close(c.requestUsd, 0.1372)
  close(c.outputUsd, 0.2)
  close(c.rebuildUsd, 0.144)
  close(c.totalUsd, 0.4812)
})

test('cold compaction pays the full rewrite on top', () => {
  const c = compactionCostUsd({ ...base, ctx: 686000, warm: false })
  close(c.requestUsd, 5.488)
  close(c.totalUsd, 5.832)
})

test('cold with a send coming anyway: the rewrite is paid either way, only the increment counts', () => {
  const c = compactionCostUsd({ ...base, ctx: 686000, warm: false, sendPending: true })
  close(c.requestUsd, 0)
  close(c.totalUsd, 0.344)
})

test('rebuild share below 1 means part of the prefix stayed cached', () => {
  const c = compactionCostUsd({ ...base, params: { ...P, rewriteShare: 0.5 }, ctx: 686000, warm: true })
  close(c.rebuildUsd, 0.072)
})

test('saving per message: reads only when the user never leaves, plus cold gaps otherwise', () => {
  close(savingPerTurnUsd({ ...base, params: { ...P, gapShare: 0 }, ctx: 686000 }), 0.1336)
  close(savingPerTurnUsd({ ...base, ctx: 686000 }), 0.668)
})

test('with keep warm on a gap costs pings (reads), not a rewrite', () => {
  close(savingPerTurnUsd({ ...base, ctx: 686000, keepWarmOn: true }), 0.16032)
})

test('nothing to save when the context is not bigger than the compacted one', () => {
  assert.equal(savingPerTurnUsd({ ...base, ctx: 18000 }), 0)
  assert.equal(breakEvenTurns({ ...base, ctx: 18000, warm: true }), Infinity)
})

test('break-even turns = cost / saving per message', () => {
  close(breakEvenTurns({ ...base, params: { ...P, gapShare: 0 }, ctx: 686000, warm: true }), 0.4812 / 0.1336, 1e-6)
  close(breakEvenTurns({ ...base, ctx: 686000, warm: true }), 0.4812 / 0.668, 1e-6)
})

test('break-even context for a horizon (closed form)', () => {
  close(breakEvenCtx({ ...base, horizon: 15 }), 41486.49, 1)
  close(breakEvenCtx({ ...base, params: { ...P, gapShare: 0 }, horizon: 15 }), 142142.86, 1)
})

test('at exactly the break-even context, break-even turns equal the horizon', () => {
  for (const q of [0, 0.1, 0.3]) {
    const params = { ...P, gapShare: q }
    const ctx = breakEvenCtx({ ...base, params, horizon: 15 })
    close(breakEvenTurns({ ...base, params, ctx, warm: true }), 15, 1e-6)
  }
})

test('a horizon too short for reads to ever pay back gives no break-even context', () => {
  assert.equal(breakEvenCtx({ ...base, params: { ...P, gapShare: 0 }, horizon: 1 }), Infinity)
})

test('idle rule: compacting just before expiry beats waiting if you come back with probability above this', () => {
  close(idleReturnThreshold({ ...base, ctx: 686000 }), 0.3372 / 5.344, 1e-6)
})

test('idle rule: a small context never pays (threshold above 100%)', () => {
  assert.ok(idleReturnThreshold({ ...base, ctx: 30000 }) > 1)
  assert.equal(idleReturnThreshold({ ...base, ctx: 18000 }), Infinity)
})

test('advise: a huge context says compact, with the numbers behind it', () => {
  const a = advise({ ...base, ctx: 686000, warm: true })
  assert.equal(a.verdict, 'compact')
  assert.ok(a.breakEvenTurns < 15)
  close(a.costUsd, 0.4812)
})

test('advise: just above the break-even context compacts, just below waits', () => {
  assert.equal(advise({ ...base, ctx: 60000, warm: true }).verdict, 'compact')
  assert.equal(advise({ ...base, ctx: 30000, warm: true }).verdict, 'wait')
})

test('advise: a context barely above the compacted size is too small to bother', () => {
  assert.equal(advise({ ...base, ctx: 20000, warm: true }).verdict, 'too-small') // under 1.2x the 18k
  assert.notEqual(advise({ ...base, ctx: 23000, warm: true }).verdict, 'too-small')
})

test('advise: with the cache cold and a send coming, compacting is cheaper so the bar is lower', () => {
  assert.equal(advise({ ...base, ctx: 30000, warm: false, sendPending: true }).verdict, 'wait') // 28.7 turns
  assert.equal(advise({ ...base, ctx: 60000, warm: false, sendPending: true }).verdict, 'compact') // 8.2 turns
  const warm = advise({ ...base, ctx: 40000, warm: true })
  const cold = advise({ ...base, ctx: 40000, warm: false, sendPending: true })
  assert.ok(cold.breakEvenTurns < warm.breakEvenTurns)
})

test('advise: a longer horizon lowers the bar', () => {
  assert.equal(advise({ ...base, params: { ...P, horizonTurns: 5 }, ctx: 45000, warm: true }).verdict, 'wait')
  assert.equal(advise({ ...base, params: { ...P, horizonTurns: 40 }, ctx: 45000, warm: true }).verdict, 'compact')
})

test('calibrate: fewer than 3 measured compactions keeps the defaults and says so', () => {
  const r = calibrate([{ kind: 'compact', outputTokens: 4000 }, { kind: 'compact-rebuild', written: 1, total: 9000 }], DEFAULT_PARAMS)
  assert.equal(r.params.newCtxTokens, DEFAULT_PARAMS.newCtxTokens)
  assert.equal(r.sources.newCtxTokens, 'default')
})

test('calibrate: medians of measured compactions replace the defaults', () => {
  const events = [
    { kind: 'compact', outputTokens: 4000 },
    { kind: 'compact', outputTokens: 6000 },
    { kind: 'compact', outputTokens: 8000 },
    { kind: 'compact-rebuild', written: 5000, total: 10000 },
    { kind: 'compact-rebuild', written: 40000, total: 40000 },
    { kind: 'compact-rebuild', written: 6000, total: 20000 },
    { kind: 'cold', usd: 1 },
  ]
  const r = calibrate(events, DEFAULT_PARAMS)
  // the size the next request really has: first request after compacting, not the transcript's own count
  assert.equal(r.params.newCtxTokens, 20000)
  assert.equal(r.params.summaryTokens, 6000)
  close(r.params.rewriteShare, 0.5) // shares 0.5, 1, 0.3
  assert.equal(r.sources.newCtxTokens, 'measured')
  assert.equal(r.sources.summaryTokens, 'measured')
  assert.equal(r.sources.rewriteShare, 'measured')
})

test('calibrate: ignores events without the figure it needs', () => {
  const events = [
    { kind: 'compact-rebuild', written: 1, total: 10000 },
    { kind: 'compact-rebuild', written: 1, total: 20000 },
    { kind: 'compact-rebuild', written: 1, total: 30000 },
    { kind: 'compact' },
    { kind: 'compact' },
    { kind: 'compact' },
  ]
  const r = calibrate(events, DEFAULT_PARAMS)
  assert.equal(r.params.newCtxTokens, 20000)
  assert.equal(r.params.summaryTokens, DEFAULT_PARAMS.summaryTokens)
  assert.equal(r.sources.summaryTokens, 'default')
})

test('gap share: no history gives the prior', () => {
  const g = gapShare({ turns: 0, longGaps: 0 }, 0.1)
  close(g.value, 0.1)
  assert.equal(g.source, 'default')
})

test('gap share: shrinks toward the prior, the more history the less it matters', () => {
  close(gapShare({ turns: 100, longGaps: 30 }, 0.1).value, (30 + 2) / 120)
  assert.equal(gapShare({ turns: 100, longGaps: 30 }, 0.1).source, 'measured')
  assert.equal(gapShare({ turns: 10, longGaps: 5 }, 0.1).source, 'default')
})

test('every request of a message reads the context, so reads scale with requests per message', () => {
  const k12 = { ...P, stepsPerTurn: 12, gapShare: 0 }
  close(savingPerTurnUsd({ ...base, params: k12, ctx: 686000 }), 668000 * 12 * 0.2e-6)
  // gaps happen once per message, not once per request
  const withGaps = { ...P, stepsPerTurn: 12, gapShare: 0.1 }
  close(savingPerTurnUsd({ ...base, params: withGaps, ctx: 686000 }), 668000 * (12 * 0.2e-6 + 0.1 * 8e-6))
})

test('break-even context with 12 requests per message and a 15 message horizon', () => {
  const params = { ...P, stepsPerTurn: 12 }
  // rho = 12*0.2e-6 + 0.1*8e-6 = 3.2e-6; C* = (18000*3.2e-6*15 + 0.2 + 0.144) / (15*3.2e-6 - 0.2e-6)
  close(breakEvenCtx({ ...base, params, horizon: 15 }), 1.208 / 47.8e-6, 1)
})

test('steps per message: no history gives the prior, history shrinks toward it', () => {
  assert.equal(stepsPerTurn({ turns: 0, steps: 0 }, 12), 12)
  close(stepsPerTurn({ turns: 40, steps: 800 }, 12), (800 + 10 * 12) / (40 + 10))
})

// A notice's outcome is written when the session ends (or is cleared): how many
// messages were still to come after the notice, and whether the owner compacted.
const adv = (remaining, compacted = false, compactedAfter = null) => ({ kind: 'advice', remaining, compacted, compactedAfter })

test('horizon: fewer than 3 notices seen keeps the prior and says so', () => {
  const h = horizonFrom([adv(30), adv(10)], 15)
  assert.equal(h.value, 15)
  assert.equal(h.source, 'default')
})

test('horizon: the median of messages that were left after each notice', () => {
  const h = horizonFrom([adv(30), adv(10), adv(50), adv(4)], 15)
  assert.equal(h.value, 20) // median of 4, 10, 30, 50
  assert.equal(h.source, 'measured')
})

test('horizon: ignores other events and notices without a count, never below 1', () => {
  const events = [{ kind: 'cold', usd: 1 }, adv(0), adv(0), adv(0), { kind: 'advice', compacted: true }]
  const h = horizonFrom(events, 15)
  assert.equal(h.value, 1)
  assert.equal(h.source, 'measured')
})

test('advice summary: how often notices led to a compaction, and how fast', () => {
  const events = [adv(40, true, 2), adv(25, true, 6), adv(12, false), adv(60, false), { kind: 'cold', usd: 1 }]
  const a = adviceSummary(events)
  assert.equal(a.shown, 4)
  assert.equal(a.acted, 2)
  assert.equal(a.actedShare, 0.5)
  assert.equal(a.medianRemaining, 32.5)
  assert.equal(a.medianMessagesToAct, 4)
})

test('advice summary: nothing shown yet', () => {
  const a = adviceSummary([{ kind: 'cold', usd: 1 }])
  assert.equal(a.shown, 0)
  assert.equal(a.actedShare, 0)
  assert.equal(a.medianRemaining, null)
  assert.equal(a.medianMessagesToAct, null)
})

test('advice summary respects the time window', () => {
  const events = [{ ...adv(10, true, 1), at: 100 }, { ...adv(10, false), at: 5 }]
  assert.equal(adviceSummary(events, 50).shown, 1)
})
