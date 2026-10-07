// Run: node --test cache-keeper/tests/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  pingMarginMs,
  pingsNeeded,
  pingCostUsd,
  classifyColdRestart,
  settleKeepWarm,
  summarize,
  pruneEvents,
} from '../hooks/ledger.mjs'
import { rewriteCost, readCost } from '../hooks/pricing.mjs'

const MIN = 60000
const H = 60 * MIN
const MODEL = 'claude-sonnet-5-5'
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`)

test('ping margin matches keep-warm timing: 8 min on 1h TTL, 90 s on 5 min', () => {
  assert.equal(pingMarginMs(60), 8 * MIN)
  assert.equal(pingMarginMs(5), 90000)
})

test('no pings are needed when the gap fits inside the TTL', () => {
  assert.equal(pingsNeeded(59 * MIN, 60), 0)
  assert.equal(pingsNeeded(60 * MIN, 60), 0)
})

test('pings needed = ceil((gap - T) / (T - margin))', () => {
  // 1h TTL, interval 52 min: 61 min needs 1, 112 min needs 1, 113 min needs 2
  assert.equal(pingsNeeded(61 * MIN, 60), 1)
  assert.equal(pingsNeeded(112 * MIN, 60), 1)
  assert.equal(pingsNeeded(113 * MIN, 60), 2)
  // 5 min TTL, interval 3.5 min: 20 min needs ceil(15/3.5) = 5
  assert.equal(pingsNeeded(20 * MIN, 5), 5)
})

test('ping cost uses the measured cost per cached token when there is one', () => {
  const measured = { usd: 0.02, readTokens: 100000 }
  close(pingCostUsd(200000, MODEL, 60, measured), 0.04)
})

test('ping cost without a measurement is a read of the context plus a small overhead', () => {
  const est = pingCostUsd(200000, MODEL, 60)
  assert.ok(est > readCost(200000, MODEL))
  assert.ok(est < readCost(200000, MODEL) * 1.1)
})

test('cold restart with keep warm on is keepwarm-failed, nothing avoidable claimed', () => {
  const r = classifyColdRestart({ gapMs: 3 * H, ttlMin: 60, tokens: 300000, model: MODEL, keepWarmOn: true })
  assert.equal(r.category, 'keepwarm-failed')
  assert.equal(r.avoidableUsd, 0)
  close(r.usd, rewriteCost(300000, MODEL, 60))
})

test('a gap longer than 24 h is too-long', () => {
  const r = classifyColdRestart({ gapMs: 25 * H, ttlMin: 60, tokens: 300000, model: MODEL })
  assert.equal(r.category, 'too-long')
  assert.equal(r.avoidableUsd, 0)
})

test('a sleep stretch as long as the ping margin makes it asleep', () => {
  const r = classifyColdRestart({ gapMs: 3 * H, ttlMin: 60, tokens: 300000, model: MODEL, longestSleepMs: 8 * MIN })
  assert.equal(r.category, 'asleep')
  assert.equal(r.avoidableUsd, 0)
})

test('a short sleep does not block keep warm', () => {
  const r = classifyColdRestart({ gapMs: 3 * H, ttlMin: 60, tokens: 300000, model: MODEL, longestSleepMs: 2 * MIN })
  assert.equal(r.category, 'avoidable')
})

test('avoidable: saving = rewrite cost - cost of the pings it would have taken', () => {
  const r = classifyColdRestart({ gapMs: 3 * H, ttlMin: 60, tokens: 300000, model: MODEL })
  assert.equal(r.category, 'avoidable')
  assert.equal(r.pingsNeeded, 3) // (180 - 60) / 52 -> 3
  close(r.keepWarmUsd, 3 * pingCostUsd(300000, MODEL, 60))
  close(r.avoidableUsd, r.usd - r.keepWarmUsd)
  assert.ok(r.avoidableUsd > 0)
})

test('not-worth: on a 5 min TTL a long gap costs more in pings than the rewrite', () => {
  // 5-min TTL write = 1.25x input, read = 0.1x: 13 pings (> 12.5) cost more than one rewrite
  const r = classifyColdRestart({ gapMs: 60 * MIN, ttlMin: 5, tokens: 300000, model: MODEL })
  assert.equal(r.category, 'not-worth')
  assert.equal(r.avoidableUsd, 0)
  assert.ok(r.keepWarmUsd >= r.usd)
})

test('settle: a hit after more than T since the last real message is saved', () => {
  const usage = { cache_read_input_tokens: 300000, input_tokens: 500, cache_creation_input_tokens: 1000 }
  const r = settleKeepWarm({ episode: { lastRealAt: 0, pings: 2, usd: 0.12 }, startedAt: 2 * H, ttlMin: 60, usage, model: MODEL })
  assert.equal(r.outcome, 'saved')
  close(r.savedUsd, rewriteCost(300000, MODEL, 60) - readCost(300000, MODEL))
  close(r.pingUsd, 0.12)
})

test('settle: a hit within T would have hit anyway, the pings were unneeded', () => {
  const usage = { cache_read_input_tokens: 300000, input_tokens: 500 }
  const r = settleKeepWarm({ episode: { lastRealAt: 0, pings: 1, usd: 0.06 }, startedAt: 58 * MIN, ttlMin: 60, usage, model: MODEL })
  assert.equal(r.outcome, 'unneeded')
  assert.equal(r.savedUsd, 0)
})

test('settle: a miss despite pings is failed', () => {
  const usage = { cache_read_input_tokens: 0, input_tokens: 500, cache_creation_input_tokens: 300000 }
  const r = settleKeepWarm({ episode: { lastRealAt: 0, pings: 2, usd: 0.12 }, startedAt: 3 * H, ttlMin: 60, usage, model: MODEL })
  assert.equal(r.outcome, 'failed')
  assert.equal(r.savedUsd, 0)
})

test('summarize splits keep warm and cold restarts and respects the time window', () => {
  const events = [
    { at: 10 * H, kind: 'keepwarm', outcome: 'saved', pings: 2, pingUsd: 0.1, savedUsd: 1.0 },
    { at: 11 * H, kind: 'keepwarm', outcome: 'unneeded', pings: 1, pingUsd: 0.05, savedUsd: 0 },
    { at: 12 * H, kind: 'keepwarm', outcome: 'abandoned', pings: 3, pingUsd: 0.15, savedUsd: 0 },
    { at: 13 * H, kind: 'cold', category: 'avoidable', tokens: 300000, usd: 2.4, avoidableUsd: 2.0 },
    { at: 14 * H, kind: 'cold', category: 'too-long', tokens: 300000, usd: 2.4, avoidableUsd: 0 },
    { at: 15 * H, kind: 'resume', tokens: 200000, usd: 1.6 },
    { at: 1 * H, kind: 'cold', category: 'avoidable', tokens: 1, usd: 99, avoidableUsd: 99 },
  ]
  const s = summarize(events, 5 * H)
  assert.equal(s.keepWarm.pings, 6)
  close(s.keepWarm.pingUsd, 0.3)
  close(s.keepWarm.savedUsd, 1.0)
  close(s.keepWarm.wastedUsd, 0.2) // unneeded + abandoned
  close(s.keepWarm.netUsd, 0.7)
  assert.equal(s.keepWarm.saved, 1)
  assert.equal(s.cold.count, 2)
  close(s.cold.usd, 4.8)
  close(s.cold.avoidableUsd, 2.0)
  assert.equal(s.cold.byCategory['too-long'].count, 1)
  assert.equal(s.resume.count, 1)
  close(s.resume.usd, 1.6)
})

test('prune drops events older than the cutoff', () => {
  const kept = pruneEvents([{ at: 1 }, { at: 100 }], 50)
  assert.deepEqual(kept, [{ at: 100 }])
})
