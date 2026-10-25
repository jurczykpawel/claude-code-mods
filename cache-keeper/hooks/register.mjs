// Cache Keeper: watches this session's prompt cache, keeps big caches warm on
// request, refuses a cold send without asking first, and shows every local
// session on one board (/board).
//
// Why: each request re-reads the whole context. From the cache that costs about
// a tenth of normal input. Once the cache expires (1 hour idle on a subscription,
// 5 minutes on the default API TTL), the next message writes the whole context
// again at 1.25x to 2x input. A cache read also restarts the timer, so a tiny
// ping before expiry costs a fraction of a rewrite.

import { rewriteCost, requestCost, totalInput, cachedShare, priceFor } from './pricing.mjs'
import { tokens, usd, minutes, clock, clip, basename, pad } from './fmt.mjs'
import { makeMasker } from './privacy.mjs'
import { classifyColdRestart, settleKeepWarm, summarize, pruneEvents } from './ledger.mjs'
import { VERSION } from './version.mjs'
import { endCompactDue } from './endcompact.mjs'
import { slideUntil, pingDue } from './keepwarmwindow.mjs'
import { shouldBlockCompact, summarizeIdleBlocks, vetoResult, blockOverridden } from './idleguard.mjs'
import { DEFAULT_PARAMS, advise, calibrate, gapShare, stepsPerTurn, horizonFrom, adviceSummary } from './compact.mjs'

const MIN = 60000
const HEARTBEAT_EVERY = 30000
const LEDGER_DAYS = 30
const PANE = 'cache-board'

// This session
const S = {
  id: '',
  cwd: '',
  label: '',
  model: '',
  lastActivity: 0, // last main-loop request or keep-warm ping that touched the cache
  ctx: 0,
  window: 0,
  costUsd: 0,
  ttlMin: 60,
  ttlSource: 'default',
  coldRestarts: [],
  // The ledger (ledger.mjs): what keep warm cost and saved, what cold restarts cost
  lastRealAt: 0, // last main-loop request; pings don't count
  episode: null, // pings since lastRealAt: { lastRealAt, pings, usd }, settled by the next request
  pingReadTokens: 0, // cached tokens the pings read, for the measured cost per token
  longestSleepMs: 0, // longest stall of the 30 s timer since lastRealAt (sleep, suspend)
  pendingResume: false,
  turns: 0, // messages this session: the base of the gap share and requests per message
  steps: 0, // model requests of the main loop
  longGaps: 0, // messages that arrived after a gap longer than the cache TTL
  advisedCtx: 0, // context size the 'worth compacting' notice was last shown for
  adviceTurns: null, // S.turns at this session's first notice; the outcome is written when the session ends
  adviceCtx: 0,
  adviceCompactedAfter: null, // messages between that notice and the first compaction after it
  events: [], // this session id's ledger events, also in $.store as ledger:<id>
  working: false,
  turnId: '', // the main loop's running (or last) turn
  waitingSince: 0,
  waitingFor: '',
  tool: '',
  lastTurnEnd: 0,
  keepWarm: false,
  keepWarmUntil: 0,
  keepWarmSpan: 0, // hours the limit is restarted to on each real message
  pings: 0,
  pingUsd: 0,
  lastPingAt: 0,
  warnedFor: 0,
  agentsRunning: 0,
  rateLimits: [],
}

const DEFAULTS = { bigTokens: 150000, guard: true, ttlMin: 0, alerts: true, keepWarmHours: 12, autoCompactTokens: 0, horizonTurns: 0, idleGuard: true, endCompactTokens: 200000 } // horizonTurns 0 = learn it from notices
const settings = { ...DEFAULTS }
const names = { cache: 'cache', keepwarm: 'keepwarm', board: 'board', handoff: 'handoff' }

let now = 0
let home = ''
let guardOff = false
let lastHeartbeat = 0
let rec = { on: false, strict: false }
let mask = (s) => s
let requestOut = false // a main-loop model request is in flight; a turn that only waits has none
let fleet = [] // heartbeats of every session, this one included
const alerted = new Map() // sessionId -> state or warning key already announced
let paneOpen = false
let justCompacted = false
let selfCompacting = false // our own compaction: the idle guard must let it through
let lastBlock = null // { at, ctx } of the last idle compaction we vetoed
let lastTickAt = 0
let compactCache = null // { at, params, sources }: what advise() runs on, refreshed every few minutes
const COMPACT_REFRESH = 10 * MIN
let autoAsked = 0 // lastActivity the auto-compact question was already asked for
let handoffPending = false

// The handoff flow. When /session-handoff runs (the band's button, /handoff, a
// typed command, or Claude calling the skill), the answer of the turn it starts
// is captured and saved to a file. "clear and continue" then runs /clear and
// sends the handoff as the fresh chat's first prompt.
const HANDOFF_SKILL = /(^|:)session-handoff$/
const H = {
  armed: false,
  notTurn: '', // a turn already running when the handoff was queued: not the handoff's
  askAfter: false, // /handoff asks "clear and continue?" once the handoff is in
  text: '',
  path: '',
  continuing: false,
}

function armHandoff(insideTurn) {
  H.armed = true
  H.notTurn = insideTurn ? '' : S.working ? S.turnId : ''
}

// The handoff without any preamble Claude put before its heading
function handoffBody(answer) {
  const text = String(answer || '').trim()
  const i = text.indexOf('# Session Handoff')
  return i > 0 ? text.slice(i) : text
}

function fileStamp(ms) {
  const d = new Date(ms)
  const two = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`
}

async function saveHandoff($, text) {
  const project = basename(S.cwd).replace(/[^A-Za-z0-9-]+/g, '-') || 'session'
  const path = `${home || '.'}/.claude/mods-data/cache-keeper/handoffs/${fileStamp(now)}-${project}-${S.id.slice(0, 8)}.md`.replace(/\\/g, '/')
  await $.fs.write(path, text + '\n')
  return path
}

async function captureHandoff($, e) {
  H.armed = false
  H.notTurn = ''
  const askAfter = H.askAfter
  H.askAfter = false
  const body = e.reason === 'answer' ? handoffBody(e.answer) : ''
  if (body.length < 200) {
    $.ui.toast('The handoff turn ended without a handoff, so nothing was saved.', { timeoutMs: 8000 })
    return
  }
  H.text = body
  try {
    H.path = await saveHandoff($, body)
  } catch {
    H.path = ''
  }
  const saved = H.path ? `Handoff saved to ${H.path}.` : 'Handoff captured (the backup file could not be written).'
  $.ui.toast(`${saved} Press c on the band or type /${names.handoff} continue to clear and continue.`, { timeoutMs: 15000 })
  // Off the hook: the turn is ending, and a dialog would hold it open
  if (askAfter) $.clock.after(300, () => offerContinue($).catch(() => {}))
}

async function offerContinue($) {
  if (!H.text) return
  let answer = ''
  try {
    answer = await $.ui.ask('Handoff saved. Clear this chat and continue with it in a fresh context?', ['Clear and continue', 'Keep this chat'])
  } catch {
    return // dismissed: the band button and /handoff continue still work
  }
  if (answer === 'Clear and continue') await clearAndContinue($)
}

function continuationPrompt() {
  const where = H.path ? ` (saved at ${H.path})` : ''
  return `Handoff from my previous session${where}:\n\n${H.text}`
}

async function clearAndContinue($) {
  if (H.continuing) return
  if (!H.text) {
    $.ui.toast(`No handoff ready. Press h on the band or type /${names.handoff} first.`, { timeoutMs: 8000 })
    return
  }
  if (S.working) {
    $.ui.toast('Claude is still working. Clear and continue once this turn ends.', { timeoutMs: 8000 })
    return
  }
  const text = continuationPrompt()
  const path = H.path
  H.continuing = true
  $.ui.invalidate('ui.render')
  try {
    await $.command.run({ command: 'clear', args: '' })
  } catch (err) {
    H.continuing = false
    $.ui.invalidate('ui.render')
    $.ui.toast('Could not run /clear: ' + clip(String((err && err.message) || err), 100) + (path ? ` The handoff is saved at ${path}.` : ''), { timeoutMs: 10000 })
    return
  }
  H.text = ''
  H.path = ''
  try {
    await $.prompt.submit({ text, asUser: true })
  } catch {
    // Not sent: leave it in the prompt box for one Enter
    let filled = false
    try {
      filled = !!(await $.prompt.fill({ text })).isFilled
    } catch {
      filled = false
    }
    $.ui.toast(filled ? 'Cleared. The handoff is in the prompt box: press Enter to send it.' : `Cleared, but the handoff could not be sent.${path ? ` It's saved at ${path}.` : ''}`, { timeoutMs: 10000 })
  } finally {
    H.continuing = false
    $.ui.invalidate('ui.render')
  }
}

// Runs the /session-handoff skill as if you typed it. The engine queues it
// until Claude finishes the current turn.
async function runHandoff($) {
  if (handoffPending) {
    $.ui.toast('Session handoff is already queued.')
    return
  }
  try {
    const commands = await $.command.list()
    const cmd = commands.find((c) => c.name === 'session-handoff') || commands.find((c) => HANDOFF_SKILL.test(c.name))
    if (!cmd) {
      H.askAfter = false
      $.ui.toast('No /session-handoff skill in this session.', { timeoutMs: 8000 })
      return
    }
    handoffPending = true
    armHandoff(false)
    $.ui.invalidate('ui.render')
    $.ui.toast(S.working ? 'Session handoff queued: it runs when Claude finishes this turn.' : 'Running /session-handoff.')
    await $.command.run({ command: cmd.name, args: '' })
  } catch (err) {
    H.armed = false
    H.askAfter = false
    $.ui.toast('Could not start /session-handoff: ' + clip(String((err && err.message) || err), 100), { timeoutMs: 8000 })
  } finally {
    handoffPending = false
    $.ui.invalidate('ui.render')
  }
}

function ttlMin() {
  return settings.ttlMin || S.ttlMin
}

// Plan limit windows as the API reports them: five_hour, seven_day, spend_limit
const LIMIT_LABEL = { five_hour: '5h', seven_day: 'week', spend_limit: 'spend' }

function limitsText(limits) {
  return limits.map((l) => `${LIMIT_LABEL[l.kind] || l.kind} ${Math.round(l.percentUsed)}%`).join(' · ')
}

function limitTone(limits, extra) {
  const top = Math.max(...limits.map((l) => l.percentUsed || 0))
  if (top >= 95) return { ...extra, color: 'red', bold: true }
  if (top >= 80) return { ...extra, color: 'yellow' }
  return { ...extra, dimColor: true }
}

function money(v) {
  return rec.strict ? '$•••' : usd(v)
}

function msLeft(lastActivity, ttl) {
  if (!lastActivity) return null
  return ttl * MIN - (now - lastActivity)
}

function cacheState(hb) {
  const left = msLeft(hb.lastActivity, hb.ttlMin)
  if (left === null) return { kind: 'unknown', left: 0 }
  if (hb.keepWarm) return { kind: 'kept', left }
  if (left <= 0) return { kind: 'cold', left }
  if (left <= 5 * MIN) return { kind: 'cooling', left }
  return { kind: 'warm', left }
}

function myHeartbeat() {
  const coldUsd = S.coldRestarts.reduce((a, c) => a + c.usd, 0)
  let state = 'idle'
  if (S.waitingSince && now - S.waitingSince > 5000) state = 'waiting'
  else if (S.working) state = 'working'
  return {
    id: S.id,
    label: S.label,
    cwd: S.cwd,
    model: S.model,
    state,
    waitingFor: S.waitingFor,
    tool: S.tool,
    ctx: S.ctx,
    window: S.window,
    ttlMin: ttlMin(),
    lastActivity: S.lastActivity,
    keepWarm: S.keepWarm,
    keepWarmUntil: S.keepWarmUntil,
    pings: S.pings,
    pingUsd: S.pingUsd,
    costUsd: S.costUsd,
    coldCount: S.coldRestarts.length,
    coldUsd,
    agentsRunning: S.agentsRunning,
    lastTurnEnd: S.lastTurnEnd,
    updatedAt: now,
  }
}

async function registerCommand($, name, description, argumentHint, immediate) {
  const spec = immediate ? { name, description, argumentHint, immediate: true } : { name, description, argumentHint }
  try {
    await $.command.register(spec)
    return name
  } catch {
    try {
      await $.command.register({ ...spec, name: 'ck-' + name })
      return 'ck-' + name
    } catch {
      return null
    }
  }
}

async function readRecording($) {
  try {
    const path = (home || '.') + '/.claude/mods-data/recording.json'
    if (!(await $.fs.exists(path))) {
      rec = { on: false, strict: false }
    } else {
      const flag = JSON.parse(await $.fs.read(path))
      rec = { on: !!flag.on, strict: !!flag.on && !!flag.strict }
    }
  } catch {
    rec = { on: false, strict: false }
  }
  mask = rec.on ? makeMasker({ strict: rec.strict }) : (s) => s
}

async function heartbeat($, force) {
  if (!S.id) return
  if (!force && now - lastHeartbeat < 5000) return
  lastHeartbeat = now
  try {
    const agents = await $.agent.list()
    S.agentsRunning = agents.filter((a) => a.status === 'running').length
  } catch {
    // agent list unavailable: keep the last count
  }
  await $.store.set('hb:' + S.id, myHeartbeat())
}

async function readFleet($) {
  const keys = (await $.store.keys()).filter((k) => k.startsWith('hb:'))
  const list = []
  for (const k of keys) {
    const hb = await $.store.get(k)
    if (!hb || typeof hb !== 'object') continue
    if (hb.id === S.id) continue
    // a session that stopped heartbeating an hour ago has ended or crashed
    if (now - (hb.updatedAt || 0) > 60 * MIN) {
      await $.store.delete(k)
      continue
    }
    list.push({ ...hb, stale: now - (hb.updatedAt || 0) > 3 * MIN })
  }
  list.push({ ...myHeartbeat(), self: true })
  fleet = list
}

// Commands another session's board sent this one, through the shared store
async function applyRemoteCommands($) {
  const c = await $.store.get('cmd:' + S.id)
  if (!c) return
  await $.store.delete('cmd:' + S.id)
  if (c.keepWarm === true) startKeepWarm($, settings.keepWarmHours)
  if (c.keepWarm === false) stopKeepWarm($, 'stopped from the board')
}

function startKeepWarm($, hours) {
  S.keepWarm = true
  S.keepWarmSpan = hours
  S.keepWarmUntil = now + hours * 60 * MIN
  $.ui.toast(`Keeping this cache warm until ${clock(S.keepWarmUntil)}. A ping reads the cache before it expires.`)
}

function stopKeepWarm($, why) {
  if (!S.keepWarm) return
  S.keepWarm = false
  $.ui.toast(`Keep warm off (${why}). ${S.pings} ping(s), ${money(S.pingUsd)}.`, { timeoutMs: 8000 })
}

// The last ping would be followed by an expired cache and a full-price rewrite of
// a big context: compact now, while the cache is warm, and stop pinging.
async function compactInsteadOfLastPing($) {
  const due = endCompactDue({
    keepWarmOn: S.keepWarm,
    working: S.working,
    ttlMin: ttlMin(),
    ctx: S.ctx,
    threshold: settings.endCompactTokens,
    lastActivity: S.lastActivity,
    now,
    keepWarmUntil: S.keepWarmUntil,
    silentMs: S.lastRealAt ? now - S.lastRealAt : 0,
  })
  if (!due) return false
  const ctx = S.ctx
  selfCompacting = true
  try {
    await $.session.compact()
  } catch (err) {
    await recordEvent($, { at: now, kind: 'end-compact', v: VERSION, outcome: 'failed', ctx, why: String((err && err.message) || err).slice(0, 120) })
    $.ui.toast('Keep warm could not compact before its time limit; pinging instead.', { timeoutMs: 8000 })
    return false
  } finally {
    selfCompacting = false
  }
  await recordEvent($, { at: now, kind: 'end-compact', v: VERSION, outcome: 'compacted', ctx })
  stopKeepWarm($, `compacted ${tokens(ctx)} tokens before the time limit`)
  return true
}

async function keepWarmStep($) {
  if (!S.keepWarm) return
  if (now >= S.keepWarmUntil) {
    if (await compactInsteadOfLastPing($)) return
    return stopKeepWarm($, 'time limit reached')
  }
  const ttl = ttlMin()
  if (!pingDue({ requestOut, lastActivity: S.lastActivity, now, ttlMin: ttl })) return
  if (await compactInsteadOfLastPing($)) return
  let reply = null
  try {
    reply = await $.model.fork({ prompt: 'cache-keeper keep-alive ping. Reply with only: ok' })
  } catch {
    reply = null
  }
  // Mid-turn the fork may have nothing to share yet: try again on the next tick
  if (S.working && (!reply || reply.reason === 'nothing-to-fork' || reply.reason === 'aborted')) return
  if (!reply || !reply.usage) {
    return stopKeepWarm($, 'the ping got no answer, so the cache may already be cold')
  }
  const u = reply.usage
  S.pings += 1
  S.lastPingAt = now
  const cost = requestCost(u, S.model, ttl)
  S.pingUsd += cost
  S.pingReadTokens += u.cache_read_input_tokens || 0
  if (!S.episode) S.episode = { lastRealAt: S.lastRealAt, pings: 0, usd: 0 }
  S.episode.pings += 1
  S.episode.usd += cost
  // A ping that writes instead of reading did not hit the cache: stop paying for it
  if ((u.cache_creation_input_tokens || 0) > 0.1 * Math.max(1, u.cache_read_input_tokens || 0)) {
    return stopKeepWarm($, `the ping wrote ${tokens(u.cache_creation_input_tokens)} tokens instead of reading the cache`)
  }
  S.lastActivity = now
}

function warnStep($) {
  if (!settings.alerts) return
  for (const hb of fleet) {
    if (hb.stale || hb.keepWarm || (hb.ctx || 0) < settings.bigTokens) continue
    const st = cacheState(hb)
    if (st.kind !== 'cooling') continue
    const key = 'cool:' + hb.lastActivity
    if (alerted.get(hb.id) === key) continue
    alerted.set(hb.id, key)
    const cost = money(rewriteCost(hb.ctx, hb.model, hb.ttlMin))
    const who = hb.self ? 'This session' : `"${mask(hb.label)}"`
    const how = hb.self ? `type /${names.keepwarm} or press 1` : `open /${names.board} to keep it warm`
    $.ui.toast(`${who}: ${tokens(hb.ctx)}-token cache goes cold in ${minutes(st.left)}. Rewriting it costs about ${cost}. ${how}.`, { timeoutMs: 15000 })
  }
  // Another session started waiting on a permission or a question
  for (const hb of fleet) {
    if (hb.self || hb.stale) continue
    const prev = alerted.get('state:' + hb.id)
    alerted.set('state:' + hb.id, hb.state)
    if (hb.state === 'waiting' && prev && prev !== 'waiting') {
      $.ui.toast(`"${mask(hb.label)}" is waiting on you${hb.waitingFor ? ': ' + hb.waitingFor : ''}`, { timeoutMs: 10000 })
    }
  }
}

// Auto-compact: while the cache is still warm a compaction reads the big context
// at the cheap cache-read price; after it expires the same compaction pays a full
// rewrite first. So near the end of the window, on a context over the threshold,
// ask once whether to compact now. Off by default (/cache autocompact 300k).
async function autoCompactStep($) {
  if (!settings.autoCompactTokens || S.keepWarm || S.working || !S.lastActivity) return
  if (S.ctx < settings.autoCompactTokens || autoAsked === S.lastActivity) return
  const ttl = ttlMin()
  const left = msLeft(S.lastActivity, ttl)
  const lead = ttl >= 60 ? 10 * MIN : 2 * MIN
  if (left === null || left <= 0 || left > lead) return
  autoAsked = S.lastActivity
  let answer = 'Not now'
  try {
    answer = await $.ui.ask(
      `Cache goes cold in ${minutes(left)}. Compacting ${tokens(S.ctx)} tokens now reads them at the cache price; after that it costs about ${money(rewriteCost(S.ctx, S.model, ttl))} to rewrite first. Compact now?`,
      ['Compact now', 'Not now'],
    )
  } catch {
    return
  }
  if (answer !== 'Compact now') return
  try {
    await $.session.compact()
  } catch {
    $.ui.toast('Auto-compact did not run (a turn was in progress or compaction was refused).', { timeoutMs: 8000 })
  }
}

// Ledger events go to this session's own store key, so sessions never overwrite
// each other; anything older than LEDGER_DAYS is dropped on the way.
async function recordEvent($, ev) {
  S.events = pruneEvents([...S.events, ev], now - LEDGER_DAYS * 24 * 60 * MIN)
  try {
    if (S.id) await $.store.set('ledger:' + S.id, S.events)
  } catch {
    // the store refused: keep the event in memory, never fail the request it rides on
  }
}

// Pings nobody came back for (the chat closed or cleared first) were spent for nothing
async function abandonEpisode($) {
  if (!S.episode) return
  const ep = S.episode
  S.episode = null
  await recordEvent($, { at: now, kind: 'keepwarm', outcome: 'abandoned', pings: ep.pings, pingUsd: ep.usd, savedUsd: 0 })
}

async function readLedger($) {
  const cutoff = now - LEDGER_DAYS * 24 * 60 * MIN
  const all = []
  for (const k of (await $.store.keys()).filter((key) => key.startsWith('ledger:'))) {
    const list = k === 'ledger:' + S.id ? S.events : await $.store.get(k)
    const kept = pruneEvents(Array.isArray(list) ? list : [], cutoff)
    if (!kept.length && k !== 'ledger:' + S.id) await $.store.delete(k)
    all.push(...kept)
  }
  return all
}

const COLD_LABELS = {
  avoidable: 'avoidable with keep warm',
  'not-worth': 'keep warm would have cost more',
  asleep: 'computer asleep or Claude Code suspended',
  'too-long': 'idle over 24 h',
  'keepwarm-failed': 'keep warm was on and missed',
}

function ledgerLines(title, s) {
  const k = s.keepWarm
  const c = s.cold
  const lines = [`${title}:`]
  lines.push(`  Keep warm: ${k.pings} ping(s), spent ${money(k.pingUsd)}; saved ${money(k.savedUsd)} on ${k.saved} return(s) that would have been cold; net ${money(k.netUsd)}.`)
  if (k.unneeded + k.failed + k.abandoned) lines.push(`    Pings spent for nothing ${money(k.wastedUsd)}: ${k.unneeded} unneeded (cache was still warm), ${k.failed} missed, ${k.abandoned} never came back.`)
  lines.push(`  Cold restarts: ${c.count}, spent ${money(c.usd)}; keep warm could have saved ${money(c.avoidableUsd)} of it.`)
  for (const [cat, v] of Object.entries(c.byCategory)) {
    lines.push(`    ${COLD_LABELS[cat] || cat}: ${v.count}, ${money(v.usd)}${v.avoidableUsd ? `, saving ${money(v.avoidableUsd)}` : ''}`)
  }
  if (s.resume.count) lines.push(`  Resumed chats: ${s.resume.count}, spent ${money(s.resume.usd)} rewriting the cache (the chat was closed, nothing could keep it warm).`)
  return lines
}

async function statsText($) {
  const all = await readLedger($)
  const day = 24 * 60 * MIN
  const lines = [
    `Cache Keeper ${VERSION} (the version this chat loaded; chats started before an update keep the old one).`,
    ...ledgerLines('This chat', summarize(S.events)),
    ...ledgerLines('Last 7 days, all chats', summarize(all, now - 7 * day)),
    ...ledgerLines('Last 30 days, all chats', summarize(all, now - 30 * day)),
  ]
  if (S.episode) lines.push(`Open keep-warm stretch: ${S.episode.pings} ping(s), ${money(S.episode.usd)}, settled by your next message.`)
  const adv = adviceSummary(all, now - 30 * day)
  if (adv.shown) lines.push(`Compaction notices, last 30 days: ${adv.shown} shown, you compacted after ${adv.acted} (${Math.round(adv.actedShare * 100)}%); about ${Math.round(adv.medianRemaining)} message(s) were left after a notice.`)
  const ig = summarizeIdleBlocks(all, now - 30 * day)
  if (ig.blocked || ig.passed || ig.overridden || ig.legacy) lines.push(`Idle-compaction guard, last 30 days: blocked ${ig.blocked} (compacted anyway: ${ig.overridden})${ig.lastBlockedAt ? ` (last ${minutes(now - ig.lastBlockedAt)} ago)` : ''}; automatic compactions let through with keep warm on: ${ig.passed}.${ig.legacy ? ` Not counted: ${ig.legacy} older record(s) from versions before 1.3.2, which did not block anything.` : ''}`)
  else lines.push('Idle-compaction guard, last 30 days: nothing to block yet (no automatic compaction while keep warm was on).')
  const ec = all.filter((ev) => ev.kind === 'end-compact' && ev.at >= now - 30 * day)
  if (ec.length) lines.push(`Compacted before keep warm ended, last 30 days: ${ec.filter((ev) => ev.outcome === 'compacted').length} of ${ec.length} attempt(s), contexts ${ec.map((ev) => tokens(ev.ctx)).join(', ')}.`)
  lines.push('Prices are API list prices; on a subscription they are usage against your plan limits. Contexts under 30k tokens are not counted.')
  return lines.join('\n')
}

// Per-session counters for the compaction advice: messages, requests, long gaps
async function saveUsage($) {
  try {
    if (S.id) await $.store.set('usage:' + S.id, { at: now, turns: S.turns, steps: S.steps, longGaps: S.longGaps })
  } catch {
    // the store refused: the counters stay in memory
  }
}

async function readUsageTotals($) {
  const cutoff = now - LEDGER_DAYS * 24 * 60 * MIN
  const total = { turns: S.turns, steps: S.steps, longGaps: S.longGaps }
  for (const k of (await $.store.keys()).filter((key) => key.startsWith('usage:'))) {
    if (k === 'usage:' + S.id) continue
    const u = await $.store.get(k)
    if (!u || typeof u !== 'object' || (u.at || 0) < cutoff) {
      await $.store.delete(k)
      continue
    }
    total.turns += u.turns || 0
    total.steps += u.steps || 0
    total.longGaps += u.longGaps || 0
  }
  return total
}

// A notice's outcome, written when its session ends or is cleared: how many
// messages were still to come, and whether (and how soon) the owner compacted.
async function flushAdvice($) {
  if (S.adviceTurns === null) return
  const compacted = S.adviceCompactedAfter !== null
  const ev = { at: now, kind: 'advice', ctx: S.adviceCtx, remaining: Math.max(0, S.turns - S.adviceTurns), compacted, compactedAfter: S.adviceCompactedAfter }
  S.adviceTurns = null
  S.adviceCompactedAfter = null
  await recordEvent($, ev)
}

// What advise() runs on: defaults, replaced by what this machine measured
async function refreshCompactParams($) {
  const usage = await readUsageTotals($)
  const ledger = await readLedger($)
  const cal = calibrate(ledger, DEFAULT_PARAMS)
  const horizon = horizonFrom(ledger, DEFAULT_PARAMS.horizonTurns)
  const gap = gapShare(usage, DEFAULT_PARAMS.gapShare)
  compactCache = {
    at: now,
    usage,
    ledger,
    params: { ...cal.params, gapShare: gap.value, stepsPerTurn: stepsPerTurn(usage, DEFAULT_PARAMS.stepsPerTurn), horizonTurns: settings.horizonTurns > 0 ? settings.horizonTurns : horizon.value },
    sources: { ...cal.sources, gapShare: gap.source, stepsPerTurn: usage.turns >= 30 ? 'measured' : 'default', horizonTurns: settings.horizonTurns > 0 ? 'set' : horizon.source },
  }
}

function compactAdvice(warm, sendPending = false) {
  if (!compactCache || !S.model) return null
  return advise({ ctx: S.ctx, model: S.model, ttlMin: ttlMin(), params: compactCache.params, warm, sendPending, keepWarmOn: S.keepWarm })
}

// One notice when compacting starts to pay, and again only after the context doubled. Not in the bar: the figures are on demand in /cache compact.
function compactNoticeStep($) {
  if (!settings.alerts || S.working || !S.lastActivity) return
  const st = cacheState(myHeartbeat())
  if (st.kind !== 'warm' && st.kind !== 'cooling' && st.kind !== 'kept') return
  if (S.advisedCtx && S.ctx < S.advisedCtx * 2) return
  const a = compactAdvice(true)
  if (!a || a.verdict !== 'compact') return
  S.advisedCtx = S.ctx
  if (S.adviceTurns === null) {
    S.adviceTurns = S.turns
    S.adviceCtx = S.ctx
    S.adviceCompactedAfter = null
  }
  $.ui.toast(`Worth compacting now: ${tokens(S.ctx)} tokens. It costs about ${money(a.costUsd)} and pays back in about ${Math.max(1, Math.round(a.breakEvenTurns))} message(s). Details: /${names.cache} compact.`, { timeoutMs: 15000 })
}

const SOURCE = { default: 'assumed', measured: 'measured' }
const HORIZON_SOURCE = { default: 'assumed', measured: 'median of the messages that were left after your earlier notices', set: 'set by you' }

function compactText() {
  if (!compactCache) return 'Not enough data yet: try again in a moment.'
  if (!S.ctx || !S.model) return 'No request yet in this chat, so there is nothing to compact.'
  const { params, sources, usage } = compactCache
  const ttl = ttlMin()
  const st = cacheState(myHeartbeat())
  const warm = st.kind === 'warm' || st.kind === 'cooling' || st.kind === 'kept'
  const a = compactAdvice(warm, !warm)
  const pct = (v) => Math.round(v * 100) + '%'
  const lines = []
  const verdict = {
    compact: `Worth compacting now.`,
    wait: `Not yet: it would not pay back within ${params.horizonTurns} messages.`,
    'too-small': `Not worth it: the chat is barely bigger than what a compaction leaves (${tokens(params.newCtxTokens)}).`,
  }[a.verdict]
  lines.push(`Compacting this chat (${tokens(S.ctx)} tokens): ${verdict}`)
  lines.push(`  Cost ${money(a.costUsd)} ${warm ? '(cache warm: it reads the chat at the cache price)' : '(cache cold and your next message rewrites it anyway: only the summary and the new prefix are extra)'}.`)
  lines.push(`  Saves about ${money(a.savingPerTurnUsd)} per message; pays back after about ${Number.isFinite(a.breakEvenTurns) ? Math.max(1, Math.round(a.breakEvenTurns)) : 'never'} message(s). Horizon: ${params.horizonTurns} message(s) still to come (${HORIZON_SOURCE[sources.horizonTurns]}; /${names.cache} horizon N|auto).`)
  if (Number.isFinite(a.breakEvenCtx)) lines.push(`  At ${params.horizonTurns} messages it pays from about ${tokens(Math.round(a.breakEvenCtx))} tokens up.`)
  if (warm && Number.isFinite(a.idleReturnThreshold) && a.idleReturnThreshold <= 1) {
    lines.push(`  If you step away, compacting before the cache expires beats letting it expire when you come back with probability above ${pct(a.idleReturnThreshold)}.`)
  }
  lines.push(`Behind the figures (${SOURCE[sources.newCtxTokens]} = from defaults, measured = from your own compactions here):`)
  lines.push(`  After a compaction the next request carries ${tokens(Math.round(params.newCtxTokens))} tokens (${SOURCE[sources.newCtxTokens]}), ${pct(params.rewriteShare)} of it written (${SOURCE[sources.rewriteShare]}), summary ${tokens(Math.round(params.summaryTokens))} tokens (${SOURCE[sources.summaryTokens]}).`)
  lines.push(`  ${params.stepsPerTurn.toFixed(1)} model requests per message (${SOURCE[sources.stepsPerTurn]}), ${pct(params.gapShare)} of messages after a gap over ${ttl} min (${SOURCE[sources.gapShare]}${usage.turns ? `, ${usage.turns} messages seen` : ''}).`)
  const adv = adviceSummary(compactCache.ledger || [])
  if (adv.shown) lines.push(`Earlier notices: ${adv.shown}, you compacted after ${adv.acted} of them${adv.medianMessagesToAct !== null ? ` (usually ${Math.round(adv.medianMessagesToAct)} message(s) later)` : ''}; about ${Math.round(adv.medianRemaining)} message(s) were left after a notice.`)
  lines.push('Money only: a summary loses detail, and this does not price that.')
  return lines.join('\n')
}

async function tick($) {
  now = await $.clock.now()
  if (!compactCache || now - compactCache.at > COMPACT_REFRESH) await refreshCompactParams($).catch(() => {})
  // The 30 s timer stalls while the machine sleeps or the process is suspended
  if (lastTickAt && now - lastTickAt > 3 * HEARTBEAT_EVERY) {
    S.longestSleepMs = Math.max(S.longestSleepMs, now - lastTickAt - HEARTBEAT_EVERY)
  }
  lastTickAt = now
  await readRecording($)
  await applyRemoteCommands($)
  await keepWarmStep($)
  autoCompactStep($).catch(() => {})
  await heartbeat($, true)
  await readFleet($)
  warnStep($)
  compactNoticeStep($)
  $.ui.invalidate('ui.render')
}

async function startFromEnvironment($) {
  guardOff = (await $.env.get('CACHE_KEEPER_GUARD')) === 'off'
  const value = await $.env.get('CACHE_KEEPER_KEEPWARM_HOURS')
  const hours = typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : 0
  if (hours >= 1 && hours <= 72) startKeepWarm($, hours)
}

async function loadSettings($) {
  const saved = await $.store.get('settings')
  if (saved && typeof saved === 'object') Object.assign(settings, saved)
}

function statusText() {
  const st = cacheState(myHeartbeat())
  const ttl = ttlMin()
  const lines = []
  lines.push(`Cache Keeper: ${tokens(S.ctx)} tokens in context on ${priceFor(S.model).id}, cache window ${ttl} min (${settings.ttlMin ? 'set by you' : S.ttlSource}).`)
  if (st.kind === 'unknown') lines.push('No request yet this session, so the cache state is unknown.')
  if (st.kind === 'warm' || st.kind === 'cooling') lines.push(`Cache is warm for about ${minutes(st.left)} more.`)
  if (st.kind === 'cold') lines.push(`Cache went cold ${minutes(-st.left)} ago. The next message rewrites it for about ${money(rewriteCost(S.ctx, S.model, ttl))}.`)
  if (S.keepWarm) lines.push(`Keep warm is on until ${clock(S.keepWarmUntil)}: ${S.pings} ping(s), ${money(S.pingUsd)} so far.`)
  if (S.rateLimits.length) lines.push(`Plan limits used: ${limitsText(S.rateLimits)}.`)
  lines.push(`Session cost so far: ${money(S.costUsd)}. Cold restarts this session: ${S.coldRestarts.length} (${money(S.coldRestarts.reduce((a, c) => a + c.usd, 0))}).`)
  const led = summarize(S.events)
  lines.push(`Ledger, this chat: keep warm net ${money(led.keepWarm.netUsd)} (spent ${money(led.keepWarm.pingUsd)}, saved ${money(led.keepWarm.savedUsd)}); cold restarts ${money(led.cold.usd)}, of which avoidable ${money(led.cold.avoidableUsd)}. Details: /${names.cache} stats.`)
  lines.push(`Cold-send guard: ${settings.guard && !guardOff ? 'on' : 'off'} for contexts over ${tokens(settings.bigTokens)} tokens. Alerts: ${settings.alerts ? 'on' : 'off'}.`)
  lines.push(`Idle-compaction guard: ${settings.idleGuard ? 'on (blocks Claude Code\'s own idle compaction while keep warm is on)' : 'off'}. /cache idleguard on|off.`)
  lines.push(`Compact before keep warm ends: ${settings.endCompactTokens ? `on for contexts over ${tokens(settings.endCompactTokens)} tokens, when nobody wrote for 30 min and the last ping is due` : 'off'}. /cache endcompact 200k|off.`)
  lines.push(`Auto-compact: ${settings.autoCompactTokens ? `asks near the end of the cache window on contexts over ${tokens(settings.autoCompactTokens)} tokens` : 'off'}.`)
  lines.push(`Settings: /${names.cache} ttl 5|60|auto, /${names.cache} guard on|off, /${names.cache} big 150k, /${names.cache} alerts on|off, /${names.cache} autocompact 300k|off, /${names.cache} reset (back to defaults), /${names.cache} stats (what keep warm and cold restarts cost), /${names.cache} compact (is compacting worth it now), /${names.cache} horizon 15 (messages you expect to send). Board: /${names.board}.`)
  return lines.join('\n')
}

function parseTokens(text) {
  const m = String(text || '').trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([km]?)$/)
  if (!m) return null
  return Math.round(Number(m[1]) * (m[2] === 'm' ? 1e6 : m[2] === 'k' ? 1e3 : 1))
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    now = await $.clock.now()
    home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''
    S.id = await $.session.id()
    S.cwd = await $.session.cwd()
    S.label = basename(S.cwd)
    S.model = await $.session.model()
    await loadSettings($)
    await startFromEnvironment($)
    await readRecording($)
    const saved = await $.store.get('ledger:' + S.id)
    S.events = Array.isArray(saved) ? saved : []
    names.cache = (await registerCommand($, 'cache', 'Cache Keeper status and settings', '[ttl 5|60|auto] [guard on|off] [big 150k] [alerts on|off] [autocompact 300k|off] [reset] [stats] [compact] [horizon 15]')) || names.cache
    names.keepwarm = (await registerCommand($, 'keepwarm', 'Keep the prompt cache warm while you are away. Stops after N hours (default 12, max 24) with no message from you; off to stop now', '[hours|off]', true)) || names.keepwarm
    names.board = (await registerCommand($, 'board', 'Every local Claude Code session: state, context, cache, cost', '', true)) || names.board
    names.handoff = (await registerCommand($, 'handoff', 'Session handoff, then clear this chat and continue with it (/handoff continue)', '[continue]')) || names.handoff
    $.clock.every(HEARTBEAT_EVERY, () => tick($).catch(() => {}))
    await heartbeat($, true)
    return next(e)
  })

  // /clear, /resume and /branch start from an unknown cache. The process goes
  // on under a new session id, and no session.start fires for it.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    now = await $.clock.now()
    await abandonEpisode($)
    await flushAdvice($)
    S.lastActivity = 0
    S.lastRealAt = 0
    S.longestSleepMs = 0
    S.pendingResume = e.source === 'resume'
    S.keepWarm = false
    await startFromEnvironment($)
    H.armed = false
    try {
      S.id = (await $.session.id()) || S.id
    } catch {
      // keep the old id
    }
    S.label = basename(S.cwd)
    const saved = await $.store.get('ledger:' + S.id)
    S.events = Array.isArray(saved) ? saved : []
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    now = await $.clock.now()
    await abandonEpisode($)
    await flushAdvice($)
    if (S.id) await $.store.delete('hb:' + S.id)
    return next(e)
  })

  // The first prompt names the session on the board
  on('prompt.submit', async ($, e, next) => {
    now = await $.clock.now()
    if (S.label === basename(S.cwd) && e.origin && e.origin.kind === 'composer' && e.text) {
      S.label = basename(S.cwd) + ' · ' + clip(e.text, 40)
    }
    // A new message in this chat makes a waiting handoff out of date (its file stays)
    if (H.text && !H.continuing && e.origin && e.origin.kind === 'composer' && !String(e.text || '').trim().startsWith('/')) {
      H.text = ''
      H.path = ''
      $.ui.invalidate('ui.render')
    }
    const ttl = ttlMin()
    const left = msLeft(S.lastActivity, ttl)
    const isCold = left !== null && left <= 0
    const fromUser = e.origin && (e.origin.kind === 'composer' || e.origin.kind === 'bridge')
    if (guardOff || !settings.guard || !fromUser || !isCold || S.ctx < settings.bigTokens || e.turnId) return next(e)
    const cost = money(rewriteCost(S.ctx, S.model, ttl))
    let answer = 'Send anyway'
    try {
      answer = await $.ui.ask(
        `Cache went cold ${minutes(-left)} ago. Sending now rewrites ${tokens(S.ctx)} tokens of context (about ${cost}). What should happen?`,
        ['Send anyway', 'Compact first, then send', 'Cancel'],
      )
    } catch {
      // nobody to ask (a -p run, or the dialog was dismissed): send as typed
      return next(e)
    }
    if (answer === 'Compact first, then send') {
      try {
        await $.session.compact()
      } catch {
        // compaction refused or failed: send anyway
      }
      return next(e)
    }
    if (answer === 'Send anyway') return next(e)
    $.ui.toast('Not sent. A fresh session with a short handoff avoids the rewrite entirely.', { timeoutMs: 8000 })
    return { drop: 'Cancelled by cache-keeper before a cold cache rewrite' }
  })

  on('turn.start', async ($, e, next) => {
    now = await $.clock.now()
    S.working = true
    if (!e.agentId) {
      S.turns += 1
      S.keepWarmUntil = slideUntil({ keepWarmOn: S.keepWarm, spanHours: S.keepWarmSpan, now, until: S.keepWarmUntil })
      if (S.lastRealAt && now - S.lastRealAt > ttlMin() * MIN) S.longGaps += 1
    }
    if (e.turnId) S.turnId = e.turnId
    await heartbeat($, true)
    return next(e)
  })

  // Each main-loop request: did it read the cache, or rewrite it?
  on('turn.step', async function* ($, e, next) {
    const startedAt = await $.clock.now()
    if (!e.agentId) requestOut = true
    let result
    try {
      result = yield* next(e)
    } finally {
      if (!e.agentId) requestOut = false
    }
    if (e.agentId || !result || !result.usage) return result
    now = await $.clock.now()
    S.steps += 1
    const u = result.usage
    const total = totalInput(u)
    const written = u.cache_creation_input_tokens || 0
    const gap = S.lastActivity ? startedAt - S.lastActivity : 0
    S.model = u.model || S.model
    const afterCompact = justCompacted
    justCompacted = false
    const realGap = S.lastRealAt ? startedAt - S.lastRealAt : 0
    // Settle the keep-warm stretch this request ends
    let keepWarmMissed = false
    if (S.episode && afterCompact) {
      await abandonEpisode($)
    } else if (S.episode) {
      const settled = settleKeepWarm({ episode: S.episode, startedAt, ttlMin: ttlMin(), usage: u, model: S.model })
      S.episode = null
      keepWarmMissed = settled.outcome === 'failed'
      await recordEvent($, { at: now, kind: 'keepwarm', ...settled })
    }
    // The first request of a resumed chat rewrites a cache nobody could keep warm
    if (S.pendingResume && !afterCompact && total > 30000 && written / total > 0.5) {
      await recordEvent($, { at: now, kind: 'resume', tokens: written, usd: rewriteCost(written, S.model, ttlMin()) })
    }
    S.pendingResume = false
    if (afterCompact) {
      // The first request after a compaction writes the new, shorter context: expected.
      // Its size and write share are what the next compaction's cost is calibrated on.
      if (total > 0) await recordEvent($, { at: now, kind: 'compact-rebuild', written, total })
      S.advisedCtx = 0
    } else if (S.lastActivity && total > 30000 && written / total > 0.5) {
      // A rewrite after 5-60 idle minutes means this session runs on the 5-minute TTL
      if (!settings.ttlMin && gap > 5.5 * MIN && gap < S.ttlMin * MIN) {
        S.ttlMin = 5
        S.ttlSource = 'measured'
      }
      S.coldRestarts.push({ at: now, tokens: written, usd: rewriteCost(written, S.model, ttlMin()), gapMin: Math.round(gap / MIN) })
      const measured = S.pingReadTokens ? { usd: S.pingUsd, readTokens: S.pingReadTokens } : undefined
      const c = classifyColdRestart({
        gapMs: realGap || gap,
        ttlMin: ttlMin(),
        tokens: written,
        model: S.model,
        keepWarmOn: S.keepWarm || keepWarmMissed,
        longestSleepMs: S.longestSleepMs,
        measured,
      })
      await recordEvent($, { at: now, kind: 'cold', category: c.category, tokens: written, usd: c.usd, avoidableUsd: c.avoidableUsd, pingsNeeded: c.pingsNeeded, gapMin: Math.round((realGap || gap) / MIN) })
    } else if (S.lastActivity && total > 30000 && gap > 5.5 * MIN && cachedShare(u) > 0.8) {
      // A hit after more than 5 idle minutes proves the 1-hour TTL
      if (!settings.ttlMin) {
        S.ttlMin = 60
        S.ttlSource = 'measured'
      }
    }
    S.ctx = total
    S.lastActivity = now
    S.lastRealAt = now
    S.longestSleepMs = 0
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    now = await $.clock.now()
    S.working = false
    S.waitingSince = 0
    S.tool = ''
    S.lastTurnEnd = now
    await saveUsage($)
    try {
      const usage = await $.session.usage()
      if (usage.context && usage.context.tokens) S.ctx = usage.context.tokens
      if (usage.context && usage.context.window) S.window = usage.context.window
      if (usage.cost) S.costUsd = usage.cost.usd
      if (Array.isArray(usage.rateLimits) && usage.rateLimits.length) S.rateLimits = usage.rateLimits
    } catch {
      // usage unavailable: keep the per-request figures
    }
    if (H.armed && e.turnId !== H.notTurn) await captureHandoff($, e)
    await heartbeat($, true)
    $.ui.invalidate('ui.render')
    return r
  })

  on('session.compact', async ($, e, next) => {
    now = await $.clock.now()
    if (e.trigger !== 'precompute' && !e.agentId && !selfCompacting) {
      const silentMs = S.lastRealAt ? now - S.lastRealAt : 0
      const d = shouldBlockCompact({ trigger: e.trigger, keepWarmOn: S.keepWarm, working: S.working, silentMs, enabled: settings.idleGuard })
      if (d.block || (e.trigger === 'auto' && S.keepWarm)) {
        const silentMin = Math.round(silentMs / MIN)
        await recordEvent($, { at: now, kind: 'idle-compact', v: VERSION, outcome: d.block ? 'blocked' : 'passed', trigger: e.trigger, silentMin, ctx: S.ctx })
        if (d.block) {
          $.ui.toast(`Blocked Claude Code's idle compaction: keep warm is on and nobody wrote for ${silentMin} min. /cache stats shows the log.`, { timeoutMs: 10000 })
          lastBlock = { at: now, ctx: S.ctx }
          return vetoResult(d)
        }
      }
    }
    const before = cacheState(myHeartbeat())
    const r = await next(e)
    if (e.trigger === 'precompute' || e.agentId || !r || r.skip) return r
    justCompacted = true
    if (S.adviceTurns !== null && S.adviceCompactedAfter === null) S.adviceCompactedAfter = Math.max(0, S.turns - S.adviceTurns)
    const u = r.usage
    await recordEvent($, {
      at: now,
      kind: 'compact',
      trigger: e.trigger,
      before: r.tokensBefore || S.ctx,
      after: r.tokensAfter || 0,
      outputTokens: u ? u.output_tokens || 0 : 0,
      readTokens: u ? u.cache_read_input_tokens || 0 : 0,
      wroteTokens: u ? u.cache_creation_input_tokens || 0 : 0,
      usd: u ? requestCost(u, S.model, ttlMin()) : 0,
      warm: before.kind === 'warm' || before.kind === 'cooling' || before.kind === 'kept',
    })
    return r
  })

  on('session.measure', async ($, e, next) => {
    if (e.context && e.context.tokens) {
      S.ctx = e.context.tokens
      if (lastBlock && blockOverridden(lastBlock, await $.clock.now(), S.ctx)) {
        const b = lastBlock
        lastBlock = null
        await recordEvent($, { at: await $.clock.now(), kind: 'idle-compact', v: VERSION, outcome: 'overridden', trigger: 'auto', silentMin: 0, ctx: b.ctx })
        $.ui.toast('Claude Code compacted anyway: the block did not hold. See /cache stats.', { timeoutMs: 10000 })
      }
    }
    if (e.context && e.context.window) S.window = e.context.window
    if (e.cost) S.costUsd = e.cost.usd
    if (Array.isArray(e.rateLimits) && e.rateLimits.length) S.rateLimits = e.rateLimits
    return next(e)
  })

  // Waiting on the person: a permission prompt or a question
  on('tool.check', async ($, e, next) => {
    const d = await next(e)
    if (d && d.decision === 'ask' && !S.waitingSince) {
      now = await $.clock.now()
      S.waitingSince = now
      S.waitingFor = 'permission for ' + e.tool
    }
    return d
  })

  on('tool.call', async ($, e, next) => {
    if (!e.agentId) S.tool = e.tool
    // Claude calling the handoff skill itself: this turn's answer is the handoff
    if (!e.agentId && e.tool === 'Skill' && HANDOFF_SKILL.test(String(e.skill || ''))) armHandoff(true)
    if (e.tool === 'AskUserQuestion') {
      now = await $.clock.now()
      S.waitingSince = now
      S.waitingFor = 'a question'
    }
    try {
      return await next(e)
    } finally {
      if (S.waitingSince) {
        S.waitingSince = 0
        S.waitingFor = ''
      }
    }
  })

  // /session-handoff from anywhere (typed, the band, /handoff): watch for its answer
  on('command.run', async ($, e, next) => {
    if (HANDOFF_SKILL.test(String(e.command || ''))) armHandoff(false)
    return next(e)
  })

  // /handoff runs the handoff and then asks to clear and continue (the band's
  // buttons draw only in the terminal); /handoff continue does the second half.
  // Both run off the hook: a command started inside a hook the session is
  // waiting on is refused.
  on('command.run', { command: ['handoff', 'ck-handoff'] }, async ($, e) => {
    now = await $.clock.now()
    const arg = String(e.args || '').trim().toLowerCase()
    if (arg === 'continue' || arg === 'go') {
      if (!H.text) return { text: `No handoff ready yet. Type /${names.handoff} to make one.` }
      $.clock.after(50, () => clearAndContinue($).catch(() => {}))
      return { text: 'Clearing this chat and continuing with the handoff.' }
    }
    H.askAfter = true
    $.clock.after(50, () => runHandoff($).catch(() => {}))
    return { text: 'Running the session handoff. When it finishes, you can clear this chat and continue with it.' }
  })

  on('command.run', { command: ['cache', 'ck-cache'] }, async ($, e) => {
    now = await $.clock.now()
    const [key, value] = String(e.args || '').trim().toLowerCase().split(/\s+/)
    if (key === 'stats') return { text: await statsText($) }
    if (key === 'compact') {
      await refreshCompactParams($)
      return { text: compactText() }
    }
    if (key === 'reset') {
      Object.assign(settings, DEFAULTS)
    } else if (key === 'ttl') {
      settings.ttlMin = value === '5' ? 5 : value === '60' ? 60 : 0
    } else if (key === 'guard' || key === 'alerts') {
      settings[key] = value !== 'off'
    } else if (key === 'big') {
      const n = parseTokens(value)
      if (n) settings.bigTokens = n
    } else if (key === 'horizon') {
      const n = Math.round(Number(value))
      if (value === 'auto') settings.horizonTurns = 0
      else if (n > 0) settings.horizonTurns = Math.min(500, n)
      S.advisedCtx = 0
      if (compactCache) compactCache.at = 0 // recompute with the new horizon
    } else if (key === 'endcompact') {
      settings.endCompactTokens = value === 'off' ? 0 : parseTokens(value) || settings.endCompactTokens
    } else if (key === 'idleguard') {
      settings.idleGuard = value !== 'off'
    } else if (key === 'autocompact') {
      settings.autoCompactTokens = value === 'off' ? 0 : parseTokens(value) || settings.autoCompactTokens
    }
    if (key) {
      await $.store.set('settings', settings)
      $.ui.invalidate('ui.render')
    }
    return { text: statusText() }
  })

  on('command.run', { command: ['keepwarm', 'ck-keepwarm'] }, async ($, e) => {
    now = await $.clock.now()
    const arg = String(e.args || '').trim().toLowerCase()
    if (arg === 'off' || (arg === '' && S.keepWarm)) {
      stopKeepWarm($, 'turned off')
    } else {
      const hours = Number(arg) > 0 ? Math.min(24, Number(arg)) : settings.keepWarmHours
      startKeepWarm($, hours)
    }
    await heartbeat($, true)
    $.ui.invalidate('ui.render')
    return {}
  })

  on('command.run', { command: ['board', 'ck-board'] }, async ($, e) => {
    now = await $.clock.now()
    await heartbeat($, true)
    await readFleet($)
    const surface = await $.session.surface()
    if (!surface) return { text: boardText() }
    paneOpen = true
    await $.ui.open({ id: PANE, title: 'Sessions', focus: true, closeOnEscape: true })
    return {}
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) paneOpen = false
    return next(e)
  })

  // The band above the prompt: this session's cache at a glance
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props && e.props.hasSurvey) return below
    if (!S.lastActivity && !S.keepWarm) return below
    const { Box, Text, Button } = $.ui.resolve(e)
    const hb = myHeartbeat()
    const st = cacheState(hb)
    const ttl = ttlMin()
    const big = S.ctx >= settings.bigTokens
    const parts = []
    if (st.kind === 'kept') parts.push(Text({ color: 'cyan', children: [`◆ kept warm · ${S.pings} ping${S.pings === 1 ? '' : 's'} ${money(S.pingUsd)} · until ${clock(S.keepWarmUntil)}`] }))
    else if (st.kind === 'warm') parts.push(Text({ color: 'green', children: [`● cache warm ${minutes(st.left)}`] }))
    else if (st.kind === 'cooling') parts.push(Text({ color: 'yellow', bold: true, children: [`◐ cache cools in ${minutes(st.left)}`] }))
    else if (st.kind === 'cold') parts.push(Text(big ? { color: 'red', bold: true, children: [`○ cache cold ${minutes(-st.left)}`] } : { dimColor: true, children: [`○ cache cold ${minutes(-st.left)}`] }))
    parts.push(Text({ dimColor: true, children: [` │ ctx ${tokens(S.ctx)}`] }))
    if (st.kind === 'cold' && big) parts.push(Text({ color: 'red', children: [` │ next send rewrites it ≈ ${money(rewriteCost(S.ctx, S.model, ttl))}`] }))
    else parts.push(Text({ dimColor: true, children: [` │ rewrite ≈ ${money(rewriteCost(S.ctx, S.model, ttl))}`] }))
    if (S.rateLimits.length) parts.push(Text(limitTone(S.rateLimits, { children: [' │ ' + limitsText(S.rateLimits)] })))
    parts.push(Text({ dimColor: true, children: [` │ session ${money(S.costUsd)}`] }))
    if (S.coldRestarts.length) parts.push(Text({ dimColor: true, children: [` │ ${S.coldRestarts.length} cold restart${S.coldRestarts.length === 1 ? '' : 's'} ${money(S.coldRestarts.reduce((a, c) => a + c.usd, 0))}`] }))
    const row = [Box({ flexDirection: 'row', children: parts })]
    // Offered whenever the cache is still alive (warm or cooling), whatever its size
    // and however long it has left: a cold cache can't be kept, a ping would rewrite it.
    if (st.kind === 'warm' || st.kind === 'cooling') {
      row.push(Button({ key: 'keepwarm', label: `keep warm ${settings.keepWarmHours}h`, hotkey: '1', plain: true, onPress: async () => { now = await $.clock.now(); startKeepWarm($, settings.keepWarmHours); await heartbeat($, true); $.ui.invalidate('ui.render') } }))
    } else if (st.kind === 'kept') {
      row.push(Button({ key: 'keepwarm', label: 'stop warm', hotkey: '1', plain: true, onPress: async () => { now = await $.clock.now(); stopKeepWarm($, 'turned off'); await heartbeat($, true); $.ui.invalidate('ui.render') } }))
    }
    const left = Box({ flexDirection: 'row', columnGap: 2, children: row })
    // Right edge: one click runs /session-handoff (h while the band has the focus;
    // a letter never fires from the prompt box, unlike a digit). Once a handoff
    // is in, c clears this chat and sends it as the fresh chat's first prompt.
    const busy = handoffPending || H.armed
    const handoff = Button({ key: 'handoff', label: handoffPending ? 'handoff queued' : H.armed ? 'handoff running' : 'handoff', hotkey: 'h', plain: true, dimColor: busy, onPress: () => runHandoff($) })
    let right = handoff
    if (H.text || H.continuing) {
      const go = Button({ key: 'continue', label: H.continuing ? 'clearing' : 'clear and continue', hotkey: 'c', plain: true, onPress: () => clearAndContinue($) })
      right = Box({ flexDirection: 'row', columnGap: 2, children: [go, handoff] })
    }
    const mine = Box({ flexDirection: 'row', justifyContent: 'space-between', width: '100%', columnGap: 2, children: [left, right] })
    return Box({ flexDirection: 'column', children: below ? [mine, below] : [mine] })
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    return drawBoard($, e)
  })

  // The band is terminal-only. The footer also draws in the Desktop app, so it
  // carries a short label, only when there's something to act on.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const label = footerLabel()
    if (!label) return next(e)
    const modes = Array.isArray(e.props && e.props.modes) ? e.props.modes : []
    return next({ ...e, props: { ...e.props, modes: [...modes, label] } })
  })
}

function footerLabel() {
  const parts = []
  const st = cacheState(myHeartbeat())
  const big = S.ctx >= settings.bigTokens
  if (st.kind === 'kept') parts.push('cache kept warm')
  else if (st.kind === 'cooling' && big) parts.push(`cache cools in ${minutes(st.left)} · /keepwarm`)
  else if (st.kind === 'cold' && big) parts.push(`cache cold · rewrite ≈ ${money(rewriteCost(S.ctx, S.model, ttlMin()))}`)
  const high = S.rateLimits.filter((l) => (l.percentUsed || 0) >= 80)
  if (high.length) parts.push(limitsText(high))
  if (H.text) parts.push(`handoff ready · /${names.handoff} continue`)
  return parts.join(' · ')
}

function sortFleet(list) {
  const rank = { waiting: 0, working: 1, idle: 2 }
  return [...list].sort((a, b) => {
    const r = (rank[a.state] ?? 3) - (rank[b.state] ?? 3)
    if (r !== 0) return r
    const la = msLeft(a.lastActivity, a.ttlMin) ?? Infinity
    const lb = msLeft(b.lastActivity, b.ttlMin) ?? Infinity
    return la - lb
  })
}

function cacheCell(hb) {
  const st = cacheState(hb)
  if (st.kind === 'kept') return ['kept warm', 'cyan']
  if (st.kind === 'warm') return ['warm ' + minutes(st.left), 'green']
  if (st.kind === 'cooling') return ['cools in ' + minutes(st.left), 'yellow']
  if (st.kind === 'cold') return ['cold ' + minutes(-st.left), (hb.ctx || 0) >= settings.bigTokens ? 'red' : 'gray']
  return ['–', 'gray']
}

function stateCell(hb) {
  if (hb.stale) return ['? silent', 'gray']
  if (hb.state === 'waiting') return ['⏳ waiting', 'magenta']
  if (hb.state === 'working') return ['● working', 'cyan']
  return ['○ idle', 'gray']
}

// Text props for a colour name; 'gray' draws dim, which every theme has
function tone(color, extra = {}) {
  return color === 'gray' ? { ...extra, dimColor: true } : { ...extra, color }
}

function boardText() {
  const rows = sortFleet(fleet).map((hb) => {
    const [state] = stateCell(hb)
    const [cache] = cacheCell(hb)
    return `${pad(state, 11)} ${pad(clip(mask(hb.label), 40), 41)} ${pad(tokens(hb.ctx), 6)} ${pad(cache, 13)} ${money(hb.costUsd)}${hb.agentsRunning ? '  ' + hb.agentsRunning + ' agents' : ''}${hb.self ? '  (this one)' : ''}`
  })
  return ['Sessions on this machine:', ...rows].join('\n')
}

function drawBoard($, e) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const width = Math.max(60, (e.props && e.props.bodyColumns) || 100)
  const labelWidth = Math.max(16, Math.min(44, width - 62))
  const list = sortFleet(fleet)
  const header = Text({ dimColor: true, children: [`${pad('STATE', 11)} ${pad('SESSION', labelWidth + 1)} ${pad('CONTEXT', 8)} ${pad('CACHE', 14)} ${pad('COST', 7)} AGENTS`] })
  const rows = list.map((hb, i) => {
    const [state, stateColor] = stateCell(hb)
    const [cache, cacheColor] = cacheCell(hb)
    const label = clip(mask(hb.label || hb.id), labelWidth) + (hb.self ? ' ◂' : '')
    const ctx = tokens(hb.ctx) + (hb.window ? ' ' + Math.round((100 * (hb.ctx || 0)) / hb.window) + '%' : '')
    const cells = [
      Text(tone(stateColor, { children: [pad(state, 11) + ' '] })),
      Text({ bold: !!hb.self, children: [pad(label, labelWidth + 1) + ' '] }),
      Text({ children: [pad(ctx, 8) + ' '] }),
      Text(tone(cacheColor, { children: [pad(cache, 14) + ' '] })),
      Text({ children: [pad(money(hb.costUsd), 7) + ' '] }),
      Text({ dimColor: !hb.agentsRunning, children: [String(hb.agentsRunning || 0) + '  '] }),
    ]
    const big = (hb.ctx || 0) >= settings.bigTokens
    if (big && !hb.stale && i < 9) {
      cells.push(
        Button({
          key: 'kw-' + hb.id,
          label: hb.keepWarm ? 'stop warm' : 'keep warm',
          hotkey: String(i + 1),
          plain: true,
          dimColor: !hb.keepWarm && cacheState(hb).kind !== 'cooling',
          onPress: async () => {
            now = await $.clock.now()
            if (hb.self) {
              if (S.keepWarm) stopKeepWarm($, 'turned off')
              else startKeepWarm($, settings.keepWarmHours)
              await heartbeat($, true)
            } else {
              await $.store.set('cmd:' + hb.id, { keepWarm: !hb.keepWarm, at: now })
              $.ui.toast(`Sent to "${mask(hb.label)}". It applies within 30 seconds.`)
            }
            await readFleet($)
            $.ui.invalidate('ui.render')
          },
        }),
      )
    }
    const line = Box({ flexDirection: 'row', children: cells })
    const detail = []
    if (hb.state === 'waiting' && hb.waitingFor) detail.push(`needs you: ${hb.waitingFor}`)
    else if (hb.state === 'working' && hb.tool) detail.push(`running ${hb.tool}`)
    if (hb.coldCount) detail.push(`${hb.coldCount} cold restart${hb.coldCount === 1 ? '' : 's'} ${money(hb.coldUsd)}`)
    if (hb.keepWarm) detail.push(`warm until ${clock(hb.keepWarmUntil)}, ${hb.pings} ping(s) ${money(hb.pingUsd)}`)
    if (detail.length === 0) return line
    return Box({ flexDirection: 'column', children: [line, Text({ dimColor: true, children: ['            └ ' + detail.join(' · ')] })] })
  })
  const totalCost = list.reduce((a, hb) => a + (hb.costUsd || 0), 0)
  const totalCold = list.reduce((a, hb) => a + (hb.coldUsd || 0), 0)
  const waiting = list.filter((hb) => hb.state === 'waiting').length
  const footer = Text({
    dimColor: true,
    children: [`${list.length} session${list.length === 1 ? '' : 's'} · ${money(totalCost)} total · ${waiting} waiting on you · cold restarts ${money(totalCold)} · keep warm reads the cache before it expires · Esc closes`],
  })
  return Box({ flexDirection: 'column', children: [header, ...rows, Text({ children: [' '] }), footer] })
}
