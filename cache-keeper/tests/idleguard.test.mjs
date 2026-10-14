// Run: node --test cache-keeper/tests/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldBlockCompact, summarizeIdleBlocks, vetoResult, blockOverridden, IDLE_SILENCE_MS } from '../hooks/idleguard.mjs'

const MIN = 60000
const base = { trigger: 'auto', keepWarmOn: true, working: false, silentMs: 54 * MIN, enabled: true }

test('blocks an automatic compaction while keep warm is on and nobody has written for a long time', () => {
  const d = shouldBlockCompact(base)
  assert.equal(d.block, true)
  assert.equal(d.reason, 'idle-with-keep-warm')
})

test('lets it through when keep warm is off', () => {
  assert.equal(shouldBlockCompact({ ...base, keepWarmOn: false }).block, false)
})

test('lets through a compaction in the middle of work (short silence or a turn running)', () => {
  assert.equal(shouldBlockCompact({ ...base, silentMs: 2 * MIN }).block, false)
  assert.equal(shouldBlockCompact({ ...base, working: true }).block, false)
})

test('never touches a manual compaction', () => {
  assert.equal(shouldBlockCompact({ ...base, trigger: 'manual' }).block, false)
})

test('lets everything through when the guard is switched off', () => {
  assert.equal(shouldBlockCompact({ ...base, enabled: false }).block, false)
})

test('the silence threshold is under the built-in idle moment (~54 min) and over normal pauses', () => {
  assert.ok(IDLE_SILENCE_MS < 54 * MIN)
  assert.ok(IDLE_SILENCE_MS >= 15 * MIN)
  assert.equal(shouldBlockCompact({ ...base, silentMs: IDLE_SILENCE_MS }).block, true)
  assert.equal(shouldBlockCompact({ ...base, silentMs: IDLE_SILENCE_MS - 1 }).block, false)
})

test('summary counts blocked and passed compactions in the window, and the last one', () => {
  const ev = [
    { at: 1000, kind: 'idle-compact', outcome: 'blocked', silentMin: 54, ctx: 387000 },
    { at: 2000, kind: 'idle-compact', outcome: 'blocked', silentMin: 55, ctx: 390000 },
    { at: 3000, kind: 'idle-compact', outcome: 'passed', silentMin: 4, ctx: 200000 },
    { at: 3500, kind: 'cold' },
  ]
  const s = summarizeIdleBlocks(ev, 1500)
  assert.equal(s.blocked, 1)
  assert.equal(s.passed, 1)
  assert.equal(s.lastBlockedAt, 2000)
  assert.deepEqual(summarizeIdleBlocks([], 0), { blocked: 0, passed: 0, overridden: 0, lastBlockedAt: 0 })
})

// Claude Code rejects a session.compact result whose skip is not a non-empty
// string ("a skip that is not a reason") and then compacts anyway; found by
// reading the 2.1.296 binary after 9 of 9 blocks were followed by a compaction.
test('the veto carries its reason as a non-empty string, which Claude Code requires', () => {
  const d = shouldBlockCompact(base)
  const veto = vetoResult(d)
  assert.equal(typeof veto.skip, 'string')
  assert.ok(veto.skip.length > 0)
  assert.notEqual(veto.skip, 'true')
})

test('a block counts as overridden when the context collapsed shortly after it', () => {
  const blocked = { at: 1000, ctx: 260000 }
  assert.equal(blockOverridden(blocked, 1000 + 60000, 20000), true)
  assert.equal(blockOverridden(blocked, 1000 + 60000, 259000), false)
  assert.equal(blockOverridden(blocked, 1000 + 20 * MIN, 20000), false) // too late to blame the block
  assert.equal(blockOverridden(null, 5000, 20000), false)
})

test('summary also counts overridden blocks', () => {
  const ev = [
    { at: 1000, kind: 'idle-compact', outcome: 'blocked', ctx: 1 },
    { at: 2000, kind: 'idle-compact', outcome: 'overridden', ctx: 1 },
  ]
  assert.equal(summarizeIdleBlocks(ev, 0).overridden, 1)
})
