// The cache ledger: what keep warm cost and saved, what cold restarts cost and
// how much of that keep warm could have saved. Pure functions, no `$`, so they
// are tested on their own (node --test cache-keeper/tests/).
//
// T is the cache TTL. A ping fires at T minus a margin after the last request
// and gives the cache another T. Prices come from pricing.mjs (API list prices;
// on a subscription they are usage against plan limits, not a bill).

import { rewriteCost, readCost, requestCost, cachedShare } from './pricing.mjs'

const MIN = 60000
export const MAX_KEEP_WARM_HOURS = 24

// Same timing keepWarmStep uses: 8 minutes early on the 1-hour TTL, 90 s on 5 min
export function pingMarginMs(ttlMin) {
  return ttlMin >= 60 ? 8 * MIN : 90000
}

// Pings that would have carried the cache over an idle gap
export function pingsNeeded(gapMs, ttlMin) {
  const ttlMs = ttlMin * MIN
  if (gapMs <= ttlMs) return 0
  return Math.ceil((gapMs - ttlMs) / (ttlMs - pingMarginMs(ttlMin)))
}

// One ping over a context of ctxTokens. With pings measured in this session, use
// their cost per cached token; otherwise a read of the context plus the ping's
// own few tokens.
export function pingCostUsd(ctxTokens, model, ttlMin, measured) {
  if (measured && measured.readTokens > 0) return (measured.usd / measured.readTokens) * ctxTokens
  return requestCost({ cache_read_input_tokens: ctxTokens, input_tokens: 60, output_tokens: 5 }, model, ttlMin)
}

// A cold restart: what it cost, and whether keep warm could have prevented it
// for less. Categories are checked in order; only 'avoidable' claims a saving.
export function classifyColdRestart({ gapMs, ttlMin, tokens, model, keepWarmOn = false, longestSleepMs = 0, measured }) {
  const usd = rewriteCost(tokens, model, ttlMin)
  const need = pingsNeeded(gapMs, ttlMin)
  const keepWarmUsd = need * pingCostUsd(tokens, model, ttlMin, measured)
  const base = { usd, pingsNeeded: need, keepWarmUsd, avoidableUsd: 0 }
  if (keepWarmOn) return { ...base, category: 'keepwarm-failed' }
  if (gapMs > MAX_KEEP_WARM_HOURS * 60 * MIN) return { ...base, category: 'too-long' }
  if (longestSleepMs >= pingMarginMs(ttlMin)) return { ...base, category: 'asleep' }
  if (keepWarmUsd >= usd) return { ...base, category: 'not-worth' }
  return { ...base, category: 'avoidable', avoidableUsd: usd - keepWarmUsd }
}

// The first real request after a keep-warm stretch settles it. A hit saves the
// rewrite only if the cache would have expired without the pings.
export function settleKeepWarm({ episode, startedAt, ttlMin, usage, model }) {
  const base = { pings: episode.pings, pingUsd: episode.usd, savedUsd: 0 }
  if (cachedShare(usage) <= 0.8) return { ...base, outcome: 'failed' }
  if (startedAt - episode.lastRealAt <= ttlMin * MIN) return { ...base, outcome: 'unneeded' }
  const read = usage.cache_read_input_tokens || 0
  return { ...base, outcome: 'saved', savedUsd: rewriteCost(read, model, ttlMin) - readCost(read, model) }
}

export function pruneEvents(events, cutoff) {
  return events.filter((ev) => ev.at >= cutoff)
}

export function summarize(events, since = 0) {
  const s = {
    keepWarm: { pings: 0, pingUsd: 0, savedUsd: 0, wastedUsd: 0, netUsd: 0, saved: 0, unneeded: 0, failed: 0, abandoned: 0 },
    cold: { count: 0, usd: 0, avoidableUsd: 0, byCategory: {} },
    resume: { count: 0, usd: 0 },
  }
  for (const ev of events) {
    if (ev.at < since) continue
    if (ev.kind === 'keepwarm') {
      const k = s.keepWarm
      k.pings += ev.pings || 0
      k.pingUsd += ev.pingUsd || 0
      k.savedUsd += ev.savedUsd || 0
      if (ev.outcome !== 'saved') k.wastedUsd += ev.pingUsd || 0
      if (ev.outcome in k) k[ev.outcome] += 1
    } else if (ev.kind === 'cold') {
      const c = s.cold
      c.count += 1
      c.usd += ev.usd || 0
      c.avoidableUsd += ev.avoidableUsd || 0
      const cat = (c.byCategory[ev.category] ||= { count: 0, usd: 0, avoidableUsd: 0 })
      cat.count += 1
      cat.usd += ev.usd || 0
      cat.avoidableUsd += ev.avoidableUsd || 0
    } else if (ev.kind === 'resume') {
      s.resume.count += 1
      s.resume.usd += ev.usd || 0
    }
  }
  s.keepWarm.netUsd = s.keepWarm.savedUsd - s.keepWarm.pingUsd
  return s
}
