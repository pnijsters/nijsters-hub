// FX — the shared exchange-rate data surface for the whole Hub.
//
// FX was born inside the Airbnb tracker; on 2026-05-16 it became its
// own Hub app (fx.html) and a shared service. The data lives in the
// `fx` schema (table fx.rates, resolver fx.rate_asof). Any module that
// needs a USD conversion imports from HERE, never from airbnb-client.js
// and never by reaching into the airbnb namespace.
//
// DAILY model (decision D6, revised 2026-05-15). One stored row per
// trading day per currency pair; `rate` is <quote> units per 1 <base>
// (base=USD; quote ∈ {PHP, EUR, SGD}). Non-trading days (weekends, ECB
// holidays) are NOT stored; a date resolves via as-of carry-forward to
// the most recent prior trading day ("use the Friday rate"). Source:
// Frankfurter (keyless ECB reference) backfilled to 2000 + daily-cron'd
// by scripts/update_fx.py; the fetch-fx-rates Edge Function is the
// on-demand safety net. FX_FALLBACK only fires if the table is somehow
// empty for the requested pair.

import { supabase } from './supabase-client.js'

const SCHEMA = 'fx'
const TABLE = 'rates'

// Last-resort ballparks, per quote, if the table is empty for a pair
// (should never happen post-backfill). USD -> quote.
const FX_FALLBACK = { PHP: 58.0, EUR: 0.92, SGD: 1.35 }
const fallback = (quote) => FX_FALLBACK[quote] ?? 1

const ymd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10))

// As-of rate for a single date: most recent rate on or before it.
export async function fxRateForDate(date, { base = 'USD', quote = 'PHP' } = {}) {
  const { data, error } = await supabase
    .schema(SCHEMA).from(TABLE)
    .select('rate')
    .eq('base_currency', base).eq('quote_currency', quote)
    .lte('rate_date', ymd(date))
    .order('rate_date', { ascending: false }).limit(1).maybeSingle()
  if (error) throw error
  return data ? Number(data.rate) : fallback(quote)
}

/**
 * Batch as-of resolver for many dates (e.g. the Airbnb export converts
 * every line at its own date). Fetches the needed span once and returns
 * a synchronous `(date) => ratePerUsd` carry-forward resolver, so the
 * caller does zero extra round-trips and no RPC-per-row.
 */
export async function fxRatesForDates(dates, { base = 'USD', quote = 'PHP' } = {}) {
  const iso = dates.map(ymd).filter(Boolean).sort()
  if (iso.length === 0) return () => fallback(quote)
  const lo = new Date(`${iso[0]}T00:00:00Z`)
  lo.setUTCDate(lo.getUTCDate() - 14)   // look-back to cover any gap before the earliest date
  const { data, error } = await supabase
    .schema(SCHEMA).from(TABLE)
    .select('rate_date, rate')
    .eq('base_currency', base).eq('quote_currency', quote)
    .gte('rate_date', lo.toISOString().slice(0, 10))
    .lte('rate_date', iso[iso.length - 1])
    .order('rate_date', { ascending: true })
  if (error) throw error
  const series = (data || []).map(r => [r.rate_date, Number(r.rate)])
  let earliest = null
  if (series.length === 0) {
    // Window empty (pre-2000 dates, or table not yet backfilled):
    // fall back to the nearest single as-of for the latest date.
    earliest = await fxRateForDate(iso[iso.length - 1], { base, quote })
  }
  return (date) => {
    const d = ymd(date)
    let r = earliest ?? fallback(quote)
    for (const [rd, rate] of series) {
      if (rd <= d) r = rate
      else break
    }
    return r
  }
}

/**
 * Ensure recent days up to `date` are stored for the pair. The backfill
 * + daily cron normally cover everything; this only fires when `date`
 * is newer than the latest stored row (a transaction entered before
 * today's cron, or a forward-dated one). Returns the as-of rate for
 * `date`. Best-effort: the Edge Function upsert needs aal2+parent, so
 * callers that may lack that should treat a throw as "use
 * fxRatesForDates carry-forward".
 */
export async function ensureFxRateForDate(date, { base = 'USD', quote = 'PHP' } = {}) {
  const want = ymd(date)
  const { data: latest } = await supabase
    .schema(SCHEMA).from(TABLE)
    .select('rate_date, rate, source')
    .eq('base_currency', base).eq('quote_currency', quote)
    .order('rate_date', { ascending: false }).limit(1).maybeSingle()
  if (latest && latest.rate_date >= want) {
    return await fxRateForDate(want, { base, quote })
      .then(rate => ({ rate, source: 'stored', fetched: false }))
  }
  const { data, error } = await supabase.functions.invoke('fetch-fx-rates', {
    body: { date: want, base, quote },
  })
  if (error) throw error
  if (!data?.rate) throw new Error('FX function returned no rate')
  return { rate: Number(data.rate), source: data.source, fetched: true }
}

/**
 * Full daily series for one pair across [from, to] (inclusive), oldest
 * first. Trading days only (the carry-forward is the consumer's job, or
 * fx.rate_asof server-side). The whole 26y history for one pair is
 * ~6.7k rows; PostgREST caps a response at the project's max_rows
 * (1000 here), so this pages through with .range() until a short page
 * rather than forcing a global cap change. fx.html loads MAX once and
 * filters ranges in memory.
 */
export async function listFxSeries({ base = 'USD', quote = 'PHP', from = null, to = null } = {}) {
  const PAGE = 1000
  const out = []
  for (let offset = 0; ; offset += PAGE) {
    let q = supabase
      .schema(SCHEMA).from(TABLE)
      .select('rate_date, rate, source')
      .eq('base_currency', base).eq('quote_currency', quote)
      .order('rate_date', { ascending: true })
      .range(offset, offset + PAGE - 1)
    if (from) q = q.gte('rate_date', ymd(from))
    if (to) q = q.lte('rate_date', ymd(to))
    const { data, error } = await q
    if (error) throw error
    const page = data || []
    for (const r of page) out.push({ date: r.rate_date, rate: Number(r.rate), source: r.source })
    if (page.length < PAGE) break
  }
  return out
}

// Most recent `limit` rows for one pair, newest first. Used by the
// Airbnb Settings FX panel (admin hygiene: spot a bad auto-fetched
// row). The full table is far too large to render whole.
export async function listAllFxRates(limit = 120, { base = 'USD', quote = 'PHP' } = {}) {
  const { data, error } = await supabase
    .schema(SCHEMA).from(TABLE)
    .select('*')
    .eq('base_currency', base).eq('quote_currency', quote)
    .order('rate_date', { ascending: false }).limit(limit)
  if (error) throw error
  return data
}

// No manual FX upsert: rates are auto-only (backfill + daily cron + the
// on-demand fetch-fx-rates safety net). deleteFxRate stays so a bad
// auto-fetched row can still be pruned (aal2+parent via RLS).
export async function deleteFxRate(id) {
  const { error } = await supabase.schema(SCHEMA).from(TABLE).delete().eq('id', id)
  if (error) throw error
}
