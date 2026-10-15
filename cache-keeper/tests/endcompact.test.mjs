// Run: node --test cache-keeper/tests/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { endCompactDue } from '../hooks/endcompact.mjs'

const MIN = 60000
// 1 h TTL: a ping is due 52 min after the last request (8 min margin)
const T0 = 1_000_000_000_000
const base = {
  keepWarmOn: true,
  working: false,
  ttlMin: 60,
  ctx: 257000,
  threshold: 200000,
  lastActivity: T0,
  now: T0 + 52 * MIN, // the ping is due
  keepWarmUntil: T0 + 100 * MIN, // the next ping (at +104) would fall past the limit
  silentMs: 90 * MIN,
}

test('compacts instead of the last ping: big context, nobody there, cache still warm', () => {
  assert.equal(endCompactDue(base), true)
})

test('keeps pinging while later pings still fit before the limit', () => {
  assert.equal(endCompactDue({ ...base, keepWarmUntil: T0 + 4 * 60 * MIN }), false)
})

test('not before the ping is due (cache is fresh)', () => {
  assert.equal(endCompactDue({ ...base, now: T0 + 30 * MIN }), false)
})

test('not when the cache already expired (compacting would rewrite it at the full price)', () => {
  assert.equal(endCompactDue({ ...base, now: T0 + 61 * MIN }), false)
})

test('not under the threshold, and never when the threshold is 0 (off)', () => {
  assert.equal(endCompactDue({ ...base, ctx: 150000 }), false)
  assert.equal(endCompactDue({ ...base, threshold: 0 }), false)
})

test('not while a turn runs, or when someone wrote in the last 30 minutes', () => {
  assert.equal(endCompactDue({ ...base, working: true }), false)
  assert.equal(endCompactDue({ ...base, silentMs: 29 * MIN }), false)
  assert.equal(endCompactDue({ ...base, silentMs: 30 * MIN }), true)
})

test('not when keep warm is off', () => {
  assert.equal(endCompactDue({ ...base, keepWarmOn: false }), false)
})

test('works on the 5 minute TTL too (ping due at 3.5 min, margin 90 s)', () => {
  const a = { ...base, ttlMin: 5, now: T0 + 3.5 * MIN, keepWarmUntil: T0 + 6 * MIN }
  assert.equal(endCompactDue(a), true)
  assert.equal(endCompactDue({ ...a, keepWarmUntil: T0 + 60 * MIN }), false)
})

test('also when the time limit lands between pings and the cache is still warm', () => {
  // limit at +40 min, before the ping is due at +52; the cache lives until +60
  const a = { ...base, now: T0 + 41 * MIN, keepWarmUntil: T0 + 40 * MIN }
  assert.equal(endCompactDue(a), true)
  assert.equal(endCompactDue({ ...a, now: T0 + 61 * MIN }), false) // expired meanwhile
  assert.equal(endCompactDue({ ...a, now: T0 + 39 * MIN }), false) // limit not reached, ping not due
})
