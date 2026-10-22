// Run: node --test cache-keeper/tests/
import { test } from 'node:test'
import assert from 'node:assert/strict'

const H = 3600000
let serial = 0
async function session(env = {}, saved = {}) {
  const { register } = await import(`../hooks/register.mjs?test=${serial++}`)
  const handlers = []
  register((event, filter, fn) => handlers.push({ event, filter: fn ? filter : {}, fn: fn || filter }))
  const store = new Map([['settings', { guard: true, ...saved }]])
  let now = 1_000_000_000_000
  let asks = 0
  const $ = {
    env: { get: async key => env[key] },
    clock: { now: async () => now, every() {} },
    session: { id: async () => 'test', cwd: async () => '/test', model: async () => 'claude-sonnet-4-6' },
    store: { get: async k => store.get(k), set: async (k, v) => store.set(k, structuredClone(v)), delete: async k => store.delete(k) },
    fs: { exists: async () => false }, command: { register: async () => {} },
    agent: { list: async () => [] },
    ui: { toast() {}, invalidate() {}, ask: async () => { asks++; return 'Cancel' } },
  }
  const run = (event, e = {}) => handlers.find(h => h.event === event && (event !== 'command.run' || h.filter.command?.includes(e.command))).fn($, e, async e => e)
  await run('session.start')
  return { $, run, store, advance: ms => { now += ms }, hb: () => store.get('hb:test'), asks: () => asks,
    async cold() {
      const handler = handlers.find(h => h.event === 'turn.step').fn
      async function* next() { return { usage: { input_tokens: 200000 } } }
      const gen = handler($, {}, next)
      while (!(await gen.next()).done) {}
      now += 2 * H
    },
  }
}

test('environment starts keep warm, slides on real messages, and manual off persists', async () => {
  const s = await session({ CACHE_KEEPER_KEEPWARM_HOURS: '72' })
  const initial = s.hb().keepWarmUntil
  assert.equal(s.hb().keepWarm, true)
  s.advance(H)
  await s.run('turn.start')
  assert.equal(s.hb().keepWarmUntil, initial + H)
  await s.run('command.run', { command: 'keepwarm', args: 'off' })
  await s.run('turn.start')
  assert.equal(s.hb().keepWarm, false)
  for (const source of ['resume', 'clear', 'fork']) {
    await s.run('classic.SessionStart', { source })
    await s.run('turn.start')
    assert.equal(s.hb().keepWarm, true)
    assert.equal(s.hb().keepWarmUntil, s.hb().updatedAt + 72 * H)
  }
})

test('valid hours include both boundaries and fractional windows', async () => {
  for (const value of ['1', '24', '1.5']) {
    const s = await session({ CACHE_KEEPER_KEEPWARM_HOURS: value })
    assert.equal(s.hb().keepWarmUntil, s.hb().updatedAt + Number(value) * H)
  }
})

test('missing and invalid hours leave keep warm disabled', async () => {
  for (const value of [undefined, '', '0', '-1', '73', 'Infinity', 'NaN', '24h', '0x18', '1e1', ' 24 ', '0.5']) {
    const s = await session({ CACHE_KEEPER_KEEPWARM_HOURS: value })
    assert.equal(s.hb().keepWarm, false, String(value))
  }
})

test('guard off bypasses a real cold-send dialog without persisting the override', async () => {
  const s = await session({ CACHE_KEEPER_GUARD: 'off' })
  await s.cold()
  const event = { origin: { kind: 'bridge' }, text: 'hello' }
  assert.deepEqual(await s.run('prompt.submit', event), event)
  assert.equal(s.asks(), 0)
  await s.run('command.run', { command: 'cache', args: 'alerts off' })
  assert.equal(s.store.get('settings').guard, true)
})

test('missing and invalid guard values preserve saved guard behavior', async () => {
  for (const value of [undefined, '', 'on', 'OFF', 'false', ' off ']) {
    const s = await session({ CACHE_KEEPER_GUARD: value })
    await s.cold()
    assert.ok((await s.run('prompt.submit', { origin: { kind: 'composer' } })).drop)
    assert.equal(s.asks(), 1)
  }
  const s = await session({ CACHE_KEEPER_GUARD: 'on' }, { guard: false })
  await s.cold()
  await s.run('prompt.submit', { origin: { kind: 'bridge' } })
  assert.equal(s.asks(), 0)
})
