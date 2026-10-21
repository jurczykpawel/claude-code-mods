// Run: node --test cache-keeper/tests/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slideUntil } from '../hooks/keepwarmwindow.mjs'

const H = 3600000
const T0 = 1_000_000_000_000

test('coming back after 12 h of a 24 h window gives a fresh 24 h', () => {
  assert.equal(slideUntil({ keepWarmOn: true, spanHours: 24, now: T0 + 12 * H, until: T0 + 24 * H }), T0 + 36 * H)
})

test('never shortens the window', () => {
  assert.equal(slideUntil({ keepWarmOn: true, spanHours: 4, now: T0, until: T0 + 10 * H }), T0 + 10 * H)
})

test('keep warm off or no span: unchanged', () => {
  assert.equal(slideUntil({ keepWarmOn: false, spanHours: 24, now: T0, until: 5 }), 5)
  assert.equal(slideUntil({ keepWarmOn: true, spanHours: 0, now: T0, until: 5 }), 5)
})
