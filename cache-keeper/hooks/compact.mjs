// When does compacting a session pay for itself? Pure functions, no `$`, tested
// on their own (node --test cache-keeper/tests/).
//
// Notation (per token, USD): r cache read, w cache write at the session's TTL,
// o output. C is the context now, N the context right after compacting, s the
// tokens of the summary the model writes.
//
// Compacting costs, with the cache warm:
//     C·r      the compaction request reads the whole context from the cache
//   + s·o      the model writes the summary
//   + N·w      the first message afterwards writes the new, short prefix
// (with the cache cold and a message about to be sent anyway, the C·w rewrite is
// paid either way, so only s·o + N·w is extra).
//
// It saves, on every later message, (C - N)·rho, where rho = k·r + q·g: k reads
// of the smaller context (a message is k model requests, each reading the whole
// context), plus the share q of messages that arrive after a gap longer than the
// TTL, each of which would rewrite C instead of N (g = w, or two pings' worth of
// reads when keep warm is on). Break-even is cost / saving.
//
// Money only. A summary loses detail, and this does not price that.

import { priceFor, writeRate } from './pricing.mjs'

// Measured in the owner's transcripts (2026-10-08, 73 compactions): the first
// request after a compaction has 76k tokens in total (median; the transcript's own
// "post" count of 18k leaves out the system prompt, tools and instructions that
// every request carries, about 52k at the start of a session), and 80% of it is
// written rather than read. The rest are assumptions until the mod measures them.
export const DEFAULT_PARAMS = {
  summaryTokens: 10000, // assumed: not in transcripts
  newCtxTokens: 76000, // measured, median of 73 (min 54k)
  rewriteShare: 0.8, // measured, median of 73 (p25 0.67, p75 0.89)
  gapShare: 0.1, // assumed prior; shrinks toward what the mod measures
  horizonTurns: 15, // a setting: messages you expect to send from here
  stepsPerTurn: 12, // measured: median of 68 sessions (overall 13.8 requests per prompt)
}

const MEASURED_MIN = 3
const GAP_PRIOR_WEIGHT = 20 // messages worth of belief in the prior
const GAP_MEASURED_MIN = 30
const STEPS_PRIOR_WEIGHT = 10 // messages worth of belief in the prior
const PINGS_PER_GAP = 2 // keep warm over a typical long gap
const TOO_SMALL_FACTOR = 1.2 // under 1.2x the compacted size there is under 17% to cut

function prices(model, ttlMin) {
  const p = priceFor(model)
  return { r: p.read / 1e6, w: writeRate(model, ttlMin) / 1e6, o: p.output / 1e6 }
}

// Per-message saving factor: the reads of every request, plus the cost of the
// long gaps it removes
function rho({ model, ttlMin, params, keepWarmOn }) {
  const { r, w } = prices(model, ttlMin)
  const g = keepWarmOn ? PINGS_PER_GAP * r : w
  return params.stepsPerTurn * r + params.gapShare * g
}

export function compactionCostUsd({ ctx, model, ttlMin, params, warm, sendPending = false }) {
  const { r, w, o } = prices(model, ttlMin)
  const requestUsd = !warm && sendPending ? 0 : ctx * (warm ? r : w)
  const outputUsd = params.summaryTokens * o
  const rebuildUsd = params.newCtxTokens * params.rewriteShare * w
  return { requestUsd, outputUsd, rebuildUsd, totalUsd: requestUsd + outputUsd + rebuildUsd }
}

export function savingPerTurnUsd({ ctx, model, ttlMin, params, keepWarmOn = false }) {
  return Math.max(0, ctx - params.newCtxTokens) * rho({ model, ttlMin, params, keepWarmOn })
}

export function breakEvenTurns(args) {
  const saving = savingPerTurnUsd(args)
  if (saving <= 0) return Infinity
  return compactionCostUsd(args).totalUsd / saving
}

// The context size above which compacting (cache warm) pays back within `horizon`
// messages: C·(H·rho - r) = N·H·rho + s·o + N·share·w
export function breakEvenCtx({ model, ttlMin, params, horizon = params.horizonTurns, keepWarmOn = false }) {
  const { r, w, o } = prices(model, ttlMin)
  const rh = rho({ model, ttlMin, params, keepWarmOn }) * horizon
  const den = rh - r
  if (den <= 0) return Infinity
  return (params.newCtxTokens * rh + params.summaryTokens * o + params.newCtxTokens * params.rewriteShare * w) / den
}

// Compacting just before the cache expires, against letting it expire and
// rewriting on return: better if you come back with probability above this.
// Above 1 means never; Infinity means the context is no bigger than the compacted one.
export function idleReturnThreshold({ ctx, model, ttlMin, params }) {
  const { r, w, o } = prices(model, ttlMin)
  const gain = ctx * w - params.newCtxTokens * params.rewriteShare * w
  if (ctx <= params.newCtxTokens || gain <= 0) return Infinity
  return (ctx * r + params.summaryTokens * o) / gain
}

export function advise(args) {
  const { ctx, params } = args
  const costUsd = compactionCostUsd(args).totalUsd
  const savingUsd = savingPerTurnUsd(args)
  const turns = breakEvenTurns(args)
  const out = {
    costUsd,
    savingPerTurnUsd: savingUsd,
    breakEvenTurns: turns,
    breakEvenCtx: breakEvenCtx(args),
    idleReturnThreshold: idleReturnThreshold(args),
  }
  if (ctx < params.newCtxTokens * TOO_SMALL_FACTOR) return { ...out, verdict: 'too-small' }
  return { ...out, verdict: turns <= params.horizonTurns ? 'compact' : 'wait' }
}

function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  const mid = Math.floor(v.length / 2)
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}

// Replace each default with the median of what the mod measured, once it has
// MEASURED_MIN figures for it; say which are which.
export function calibrate(events, defaults = DEFAULT_PARAMS) {
  const params = { ...defaults }
  const sources = { newCtxTokens: 'default', summaryTokens: 'default', rewriteShare: 'default' }
  const compacts = events.filter((e) => e.kind === 'compact')
  const rebuilds = events.filter((e) => e.kind === 'compact-rebuild' && e.total > 0)
  // N is what the next request really carries: the first request after compacting
  const after = rebuilds.map((e) => e.total)
  const wrote = compacts.map((e) => e.outputTokens).filter((x) => x > 0)
  const shares = rebuilds.map((e) => e.written / e.total)
  if (after.length >= MEASURED_MIN) {
    params.newCtxTokens = median(after)
    sources.newCtxTokens = 'measured'
  }
  if (wrote.length >= MEASURED_MIN) {
    params.summaryTokens = median(wrote)
    sources.summaryTokens = 'measured'
  }
  if (shares.length >= MEASURED_MIN) {
    params.rewriteShare = median(shares)
    sources.rewriteShare = 'measured'
  }
  return { params, sources }
}

// Share of messages that arrive after a gap longer than the TTL, shrunk toward
// the prior so a short history can't swing it.
export function gapShare({ turns, longGaps }, prior = DEFAULT_PARAMS.gapShare) {
  const value = (longGaps + GAP_PRIOR_WEIGHT * prior) / (turns + GAP_PRIOR_WEIGHT)
  return { value, source: turns >= GAP_MEASURED_MIN ? 'measured' : 'default' }
}

// Model requests per message, shrunk toward the prior like gapShare
export function stepsPerTurn({ turns, steps }, prior = DEFAULT_PARAMS.stepsPerTurn) {
  return (steps + STEPS_PRIOR_WEIGHT * prior) / (turns + STEPS_PRIOR_WEIGHT)
}

// The horizon is the messages still to come once compacting is worth a look. Each
// 'advice' event is one notice's outcome: `remaining` messages from the notice to
// the end of that session, so a compaction that carried on afterwards doesn't cut
// it short. Median once 3 are known, else the prior.
export function horizonFrom(events, prior = DEFAULT_PARAMS.horizonTurns) {
  const left = events.filter((e) => e.kind === 'advice' && Number.isFinite(e.remaining)).map((e) => e.remaining)
  if (left.length < MEASURED_MIN) return { value: prior, source: 'default' }
  return { value: Math.max(1, Math.round(median(left))), source: 'measured' }
}

// What came of the notices: how many, how often they led to a compaction, how
// many messages later, how many messages were left.
export function adviceSummary(events, since = 0) {
  const adv = events.filter((e) => e.kind === 'advice' && (e.at === undefined || e.at >= since))
  const acted = adv.filter((e) => e.compacted)
  return {
    shown: adv.length,
    acted: acted.length,
    actedShare: adv.length ? acted.length / adv.length : 0,
    medianRemaining: median(adv.map((e) => e.remaining)),
    medianMessagesToAct: median(acted.map((e) => e.compactedAfter)),
  }
}
