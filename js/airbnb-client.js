// Airbnb module — Supabase query helpers.
//
// Wraps the airbnb.* schema for the browser. Re-uses the singleton
// supabase client from supabase-client.js (one init per tab). Read-only
// in Phase 2 step 2.3; write helpers land alongside the import drop-zone
// in 2.5 and the adjustment editor in 2.6.
//
// All derived fee values (mgmt fee, VAT, expected net) are computed at
// READ time from the fee_schedule whose [effective_from, effective_to)
// brackets the booking's start_date. Nothing derived is stored on the
// bookings row.

import { supabase } from './supabase-client.js'

const SCHEMA = 'airbnb'
const PROPERTY_SLUG = 'the-beacon-manila'

// Cached lookups (per page load).
let _propertyCache = null
let _feeSchedulesCache = null
let _categoriesCache = null

/* ──────────────────────────────────────────────────────────────────────
   Lookups
   ────────────────────────────────────────────────────────────────────── */
export async function getProperty() {
  if (_propertyCache) return _propertyCache
  const { data, error } = await supabase
    .schema(SCHEMA).from('properties')
    .select('*').eq('slug', PROPERTY_SLUG).single()
  if (error) throw error
  _propertyCache = data
  return data
}

export async function listFeeSchedules() {
  if (_feeSchedulesCache) return _feeSchedulesCache
  const prop = await getProperty()
  const { data, error } = await supabase
    .schema(SCHEMA).from('fee_schedules')
    .select('*').eq('property_id', prop.id)
    .order('effective_from', { ascending: true })
  if (error) throw error
  _feeSchedulesCache = data
  return data
}

export async function listExpenseCategories() {
  if (_categoriesCache) return _categoriesCache
  const { data, error } = await supabase
    .schema(SCHEMA).from('expense_categories')
    .select('*').order('sort_order', { ascending: true })
  if (error) throw error
  _categoriesCache = data
  return data
}

/* ──────────────────────────────────────────────────────────────────────
   Month-view queries
   ────────────────────────────────────────────────────────────────────── */
function monthBounds(yyyymm) {
  const [y, m] = yyyymm.split('-').map(Number)
  const start = `${y}-${String(m).padStart(2, '0')}-01`
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const end = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
  return { start, end, daysInMonth: lastDay }
}

export async function listBookingsForMonth(yyyymm) {
  const prop = await getProperty()
  const { start, end } = monthBounds(yyyymm)
  // Include bookings that START in a prior month but whose stay spills
  // into this one. 60-day lookback covers every realistic stay length.
  const lookback = new Date(start + 'T00:00:00Z')
  lookback.setUTCDate(lookback.getUTCDate() - 60)
  const lookbackIso = lookback.toISOString().slice(0, 10)
  const { data, error } = await supabase
    .schema(SCHEMA).from('bookings')
    .select('*, booking_adjustments(*), email_events(id, parsed_type, received_at, subject, guest_name, parsed_payload)')
    .eq('property_id', prop.id)
    .eq('status', 'active')
    .gte('start_date', lookbackIso)
    .lte('start_date', end)
    .order('start_date', { ascending: true })
  if (error) throw error
  // Keep only those whose stay actually overlaps the month: a booking
  // is in [start_date, start_date + nights). The month is [start, end+1).
  return (data || []).filter(b => {
    const sd = new Date(b.start_date + 'T00:00:00Z')
    const ed = new Date(sd); ed.setUTCDate(ed.getUTCDate() + (b.nights || 0))
    const ms = new Date(start + 'T00:00:00Z')
    const me = new Date(end   + 'T00:00:00Z'); me.setUTCDate(me.getUTCDate() + 1)
    return sd < me && ed > ms
  })
}

/**
 * Reservations Airbnb emailed about that have no booking row: the
 * "Reservation confirmed" email never arrived (a forwarding glitch),
 * yet reminders/payouts for the same code did. Global, not month-scoped:
 * these gaps have no reliable date, so they're surfaced as a standing
 * notice rather than placed on a calendar. `had_confirmation_email`
 * separates a delivery gap (false) from a booking-creation bug (true).
 */
export async function listMissingConfirmations() {
  const { data, error } = await supabase
    .schema(SCHEMA).from('missing_confirmations')
    .select('*')
    .order('last_seen', { ascending: false })
  if (error) throw error
  return data
}

export async function listExpensesForMonth(yyyymm) {
  const prop = await getProperty()
  const { start, end } = monthBounds(yyyymm)
  const { data, error } = await supabase
    .schema(SCHEMA).from('expenses')
    .select('*, expense_categories(slug, label)')
    .eq('property_id', prop.id)
    .gte('incurred_date', start)
    .lte('incurred_date', end)
    .order('incurred_date', { ascending: true })
  if (error) throw error
  return data
}

export async function listFreestandingAdjustmentsForMonth(yyyymm) {
  const prop = await getProperty()
  const { start, end } = monthBounds(yyyymm)
  const { data, error } = await supabase
    .schema(SCHEMA).from('freestanding_adjustments')
    .select('*')
    .eq('property_id', prop.id)
    .gte('occurred_date', start)
    .lte('occurred_date', end)
    .order('occurred_date', { ascending: true })
  if (error) throw error
  return data
}

/**
 * Returns the set of YYYY-MM strings that have at least one booking,
 * ordered descending (most recent first). Used to populate the month
 * picker and to choose the default-visible month.
 */
export async function listAvailableMonths() {
  const prop = await getProperty()
  const { data, error } = await supabase
    .schema(SCHEMA).from('bookings')
    .select('start_date').eq('property_id', prop.id)
    .eq('status', 'active')
    .order('start_date', { ascending: false })
  if (error) throw error
  const months = new Set()
  for (const r of data) months.add(r.start_date.slice(0, 7))
  return [...months]
}

/* ──────────────────────────────────────────────────────────────────────
   Fee schedule application — the core derivation logic
   ────────────────────────────────────────────────────────────────────── */

/**
 * Find the fee_schedule row whose [effective_from, effective_to)
 * brackets the given booking start date. Throws if none — the
 * application contract is that every booking has a schedule (we seed
 * two on day one).
 */
export function scheduleForDate(schedules, dateIso) {
  for (const s of schedules) {
    if (dateIso < s.effective_from) continue
    if (s.effective_to && dateIso > s.effective_to) continue
    return s
  }
  throw new Error(`No fee_schedule covers ${dateIso}`)
}

/**
 * Given a booking row and the schedule that applied at its start_date,
 * return computed fee components. All amounts in PHP.
 *
 *   gross               what the guest paid AirBnB
 *   airbnb_fee          AirBnB's host fee (typically 3% of gross)
 *   cleaning_gross      cleaning fee per the schedule (VAT-exclusive in
 *                       era ≥ 2025; the actual ₱900 in earlier era)
 *   cleaning_vat        12% VAT on cleaning, 0 in era 1
 *   mgmt_base           the amount mgmt fee is taken from
 *                       (= deposit-to-bank minus cleaning)
 *   mgmt_fee_gross      mgmt percentage of mgmt_base
 *   mgmt_vat            12% VAT on mgmt_fee_gross, 0 in era 1
 *   net_to_bank         what AirBnB deposited to Patrick's BPI
 *                       (gross - airbnb_fee)
 *   net_to_owner        what Patrick keeps after settling with mgmt
 *                       (= net_to_bank - cleaning_gross - cleaning_vat
 *                          - mgmt_fee_gross - mgmt_vat)
 */
export function deriveFees(booking, schedule) {
  const era_label = schedule.effective_to
    ? `${schedule.effective_from} → ${schedule.effective_to}`
    : `${schedule.effective_from} → open`

  // is_provisional follows the source, not the null state of the
  // numbers: confirmation emails ship a HOST PAYOUT breakdown that
  // we extract on ingest, so an email-sourced row can have real
  // values. Callers that exclude provisional rows from aggregates
  // (totals, charts, Moneydance export) still do so by this flag.
  const is_provisional = booking.source === 'email'

  // If the financial fields didn't get parsed (older email body,
  // older backfill), return null fees so the UI renders a quiet
  // placeholder rather than NaN.
  if (booking.gross_earnings_php == null || booking.airbnb_service_fee_php == null) {
    return {
      gross: null, airbnb_fee: null, net_to_bank: null,
      cleaning_gross: null, cleaning_vat: null,
      mgmt_base: null, mgmt_fee_gross: null, mgmt_vat: null,
      net_to_owner: null,
      era_label, is_provisional,
    }
  }

  const gross       = Number(booking.gross_earnings_php)
  const airbnb_fee  = Number(booking.airbnb_service_fee_php)
  const net_to_bank = gross - airbnb_fee
  // Per-booking cleaning override (if a booking_adjustment exists,
  // it replaces the contract's cleaning fee).
  const adj = booking.booking_adjustments?.[0]
  const cleaning_gross = adj
    ? Number(adj.cleaning_fee_override_php)
    : Number(schedule.cleaning_fee_php)
  const cleaning_vat = cleaning_gross * Number(schedule.cleaning_vat_pct)
  // Management fee is levied on rental net of the FULL cleaning charge
  // (gross + VAT). Cleaning revenue sits inside gross_earnings, so the
  // base must subtract both parts, not just the VAT-exclusive fee — else
  // the fee is overstated by mgmt_fee_pct × cleaning_vat in the VAT era.
  const mgmt_base = net_to_bank - cleaning_gross - cleaning_vat
  const mgmt_fee_gross = mgmt_base * Number(schedule.mgmt_fee_pct)
  const mgmt_vat = mgmt_fee_gross * Number(schedule.mgmt_vat_pct)
  const net_to_owner = net_to_bank - cleaning_gross - cleaning_vat
                       - mgmt_fee_gross - mgmt_vat
  return {
    gross, airbnb_fee, net_to_bank,
    cleaning_gross, cleaning_vat,
    mgmt_base, mgmt_fee_gross, mgmt_vat,
    net_to_owner,
    era_label, is_provisional,
  }
}

/* ──────────────────────────────────────────────────────────────────────
   Rate history — every change to what a stay costs, newest first.
   ────────────────────────────────────────────────────────────────────── */

const cleaningTotal = s => Number(s.cleaning_fee_php) * (1 + Number(s.cleaning_vat_pct))

// Always Home terms, compared era to era. `revert` rebuilds the new era
// with just this one term put back, which is how the impact is isolated.
const CONTRACT_TERMS = [
  { what: 'Cleaning', unit: 'php', val: s => Math.round(cleaningTotal(s) * 100) / 100,
    revert: (s, p) => ({ ...s, cleaning_fee_php: cleaningTotal(p) / (1 + Number(s.cleaning_vat_pct)) }) },
  { what: 'Management', unit: 'pct', val: s => Number(s.mgmt_fee_pct),
    revert: (s, p) => ({ ...s, mgmt_fee_pct: p.mgmt_fee_pct }) },
  // VAT reverts hold the cleaning total, so it reads as a VAT change only.
  { what: 'Cleaning VAT', unit: 'pct', val: s => Number(s.cleaning_vat_pct),
    revert: (s, p) => ({ ...s, cleaning_vat_pct: p.cleaning_vat_pct,
                         cleaning_fee_php: cleaningTotal(s) / (1 + Number(p.cleaning_vat_pct)) }) },
  { what: 'Management VAT', unit: 'pct', val: s => Number(s.mgmt_vat_pct),
    revert: (s, p) => ({ ...s, mgmt_vat_pct: p.mgmt_vat_pct }) },
]

// Airbnb's side is read off the bookings themselves, in booking-date
// order: the fee as a share of gross (bucketed to 0.5% so 3.35%/3.36%
// rounding noise is one value) and the guest cleaning fee.
const AIRBNB_TERMS = [
  { what: 'Airbnb fee', unit: 'pct',
    key: b => Math.round(Number(b.airbnb_service_fee_php) / Number(b.gross_earnings_php) * 200),
    val: b => Number(b.airbnb_service_fee_php) / Number(b.gross_earnings_php),
    // Same stay, the old share of gross.
    revert: (b, from) => ({ ...b, airbnb_service_fee_php: Number(b.gross_earnings_php) * from }) },
  { what: 'Guest cleaning', unit: 'php',
    key: b => Number(b.cleaning_fee_php),
    val: b => Number(b.cleaning_fee_php),
    // Same stay, the old cleaning fee; Airbnb's cut scales with gross.
    revert: (b, from) => {
      const gross = Number(b.gross_earnings_php)
      const g = gross - (Number(b.cleaning_fee_php) - from)
      return { ...b, gross_earnings_php: g, airbnb_service_fee_php: Number(b.airbnb_service_fee_php) * g / gross }
    } },
]

// A new value only counts once this many bookings in a row carry it, so
// one-off stays (a ₱0 or ₱450 cleaning) don't read as rate changes.
const RATE_RUN = 3
const IMPACT_MONTHS = 3

const median = xs => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }

function addMonths(iso, n, days = 0) {
  const d = new Date(iso + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

// Calendar months in [from, to), fractional for partial months.
function monthsBetween(from, to) {
  let n = 0, cur = from
  while (cur < to) {
    const d = new Date(cur + 'T00:00:00Z')
    const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10)
    const end = next < to ? next : to
    const dim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
    n += (Date.parse(end) - Date.parse(cur)) / 864e5 / dim
    cur = end
  }
  return n
}

function airbnbChanges(term, bookings) {
  const rows = bookings
    .map(b => ({ b, k: term.key(b), d: b.booking_date || b.start_date }))
    .sort((x, y) => x.d < y.d ? -1 : x.d > y.d ? 1 : 0)
  const runs = []   // { k, start } for each established value
  for (let i = 0; i < rows.length; i++) {
    if (runs.length && rows[i].k === runs[runs.length - 1].k) continue
    const ahead = rows.slice(i, i + RATE_RUN)
    if (ahead.length === RATE_RUN && ahead.every(r => r.k === rows[i].k)) runs.push({ k: rows[i].k, start: i })
  }
  const value = run => median(rows.filter(r => r.k === run.k).map(r => term.val(r.b)))
  return runs.slice(1).map((run, i) => ({
    date: rows[run.start].d, source: 'airbnb', basis: 'booking',
    what: term.what, unit: term.unit,
    from: value(runs[i]), to: value(run),
    affected: b => term.key(b) === run.k && (b.booking_date || b.start_date) >= rows[run.start].d,
    counterfactual: (b, from) => term.revert(b, from),
  }))
}

/**
 * Every rate change, newest first: Always Home contract terms per era
 * (by stay date) and Airbnb's fee and guest cleaning fee (by booking
 * date, detected from the bookings). Each change carries `impact`: the
 * change in what the owner keeps per month, over the first
 * IMPACT_MONTHS of stays it touched (`so_far` while that window is
 * still open), holding everything else fixed.
 *
 * `bookings` must be final (CSV/legacy) rows; provisional email rows
 * would bias both detection and impact.
 */
export function rateChanges(schedules, bookings) {
  const changes = []
  schedules.forEach((s, i) => {
    const p = schedules[i - 1]
    if (!p) {
      changes.push({ date: s.effective_from, source: 'always-home', basis: 'stay', what: 'Contract start',
                     schedule: s, era: 1, note: s.notes })
      return
    }
    const terms = CONTRACT_TERMS.filter(t => Math.abs(t.val(s) - t.val(p)) > 1e-6)
    // Cleaning and management VAT moving together read as one change.
    const cv = terms.find(t => t.what === 'Cleaning VAT'), mv = terms.find(t => t.what === 'Management VAT')
    const merged = cv && mv && cv.val(s) === mv.val(s) && cv.val(p) === mv.val(p)
      ? [...terms.filter(t => t !== cv && t !== mv),
         { what: 'VAT', unit: 'pct', val: cv.val, revert: (x, y) => mv.revert(cv.revert(x, y), y) }]
      : terms
    merged.forEach((t, j) => changes.push({
      date: s.effective_from, source: 'always-home', basis: 'stay',
      what: t.what, unit: t.unit, from: t.val(p), to: t.val(s),
      schedule: s, era: i + 1, note: j === 0 ? s.notes : null,
      ends: s.effective_to ? addMonths(s.effective_to, 0, 1) : null,
      affected: b => scheduleForDate(schedules, b.start_date) === s,
      counterfactual: () => t.revert(s, p),
    }))
  })
  for (const term of AIRBNB_TERMS) changes.push(...airbnbChanges(term, bookings))

  // Bookings are imported a whole month at a time, so data runs to the
  // end of the latest stay's month.
  const last = bookings.reduce((m, b) => b.start_date > m ? b.start_date : m, '')
  const horizon = last ? addMonths(last.slice(0, 7) + '-01', 1) : ''
  const net = (b, s) => deriveFees({ ...b, source: 'airbnb_csv' }, s).net_to_owner
  for (const c of changes) {
    if (!c.affected) { c.impact = null; continue }
    // An era that ended within the window only counts while it ran.
    let end = addMonths(c.date, IMPACT_MONTHS)
    if (c.ends && c.ends < end) end = c.ends
    const until = end < horizon ? end : horizon
    const months = monthsBetween(c.date, until)
    if (months <= 0) { c.impact = null; continue }
    let delta = 0
    for (const b of bookings) {
      if (b.start_date < c.date || b.start_date >= until || !c.affected(b)) continue
      const s = scheduleForDate(schedules, b.start_date)
      delta += c.source === 'airbnb'
        ? net(b, s) - net(c.counterfactual(b, c.from), s)
        : net(b, s) - net(b, c.counterfactual())
    }
    c.impact = delta / months
    c.so_far = end > horizon
  }
  return changes.sort((a, b) => a.date < b.date ? 1 : a.date > b.date ? -1
    : (a.source === b.source ? 0 : a.source === 'always-home' ? -1 : 1))
}

/* ──────────────────────────────────────────────────────────────────────
   Writes — CSV import
   ────────────────────────────────────────────────────────────────────── */

/**
 * Returns the set of confirmation codes (from airbnb_csv source) that
 * already exist for the given list, so the import preview can mark
 * duplicates. Empty list → empty set.
 */
export async function existingConfirmationCodes(codes) {
  if (!codes.length) return new Set()
  const { data, error } = await supabase
    .schema(SCHEMA).from('bookings')
    .select('confirmation_code')
    .eq('source', 'airbnb_csv')
    .in('confirmation_code', codes)
  if (error) throw error
  return new Set(data.map(r => r.confirmation_code))
}

/**
 * Map of confirmation_code -> source for the given codes (any source), so
 * the import preview can show precisely what each row will do: insert a
 * new booking, fill in a provisional 'email' row, or skip one already
 * imported from a CSV/legacy source.
 */
export async function existingBookingsByCode(codes) {
  if (!codes.length) return new Map()
  const { data, error } = await supabase
    .schema(SCHEMA).from('bookings')
    .select('confirmation_code, source')
    .in('confirmation_code', codes)
  if (error) throw error
  return new Map(data.map(r => [r.confirmation_code, r.source]))
}

/**
 * Provisional ('email') bookings a CSV proves were never paid. Airbnb
 * releases the payout the day after check-in, and the CSV lists every
 * payout in its date range, so an active provisional stay whose payout
 * day falls inside [from, to] but whose code is absent from the file was
 * cancelled and refunded (the backstop for a cancellation email that
 * never arrived). If the payout was only late, the CSV that carries it
 * reinstates the row; see importBookingsAndPayouts.
 */
export async function provisionalUnpaidInCsv({ from, to }, csvCodes) {
  const dayBefore = iso => {
    const d = new Date(iso + 'T00:00:00Z')
    d.setUTCDate(d.getUTCDate() - 1)
    return d.toISOString().slice(0, 10)
  }
  const { data, error } = await supabase
    .schema(SCHEMA).from('bookings')
    .select('id, confirmation_code, guest_name, start_date, nights')
    .eq('source', 'email')
    .eq('status', 'active')
    .gte('start_date', dayBefore(from))
    .lte('start_date', dayBefore(to))
  if (error) throw error
  const inCsv = new Set(csvCodes)
  return data.filter(b => !inCsv.has(b.confirmation_code))
}

/**
 * Returns the set of payout reference codes already stored, so the import
 * preview can show how many payouts are genuinely new vs already imported.
 */
export async function existingPayoutRefs(refs) {
  if (!refs.length) return new Set()
  const { data, error } = await supabase
    .schema(SCHEMA).from('payouts')
    .select('reference_code')
    .in('reference_code', refs)
  if (error) throw error
  return new Set(data.map(r => r.reference_code))
}

/**
 * Insert new bookings + payouts in a single client-side step.
 *
 * @param newBookings Array of booking objects (must include
 *   property_id, confirmation_code, source='airbnb_csv', start/end
 *   dates, nights, gross, fees, etc.).
 * @param payouts Array of payout objects with `_match_code` (the
 *   booking's confirmation_code, used to map booking_id after insert).
 *   Payouts whose match doesn't resolve get booking_id = null.
 * @param unpaidIds Ids from provisionalUnpaidInCsv, marked cancelled.
 */
export async function importBookingsAndPayouts(newBookings, payouts, unpaidIds = []) {
  // Demote any provisional (source='email') row in place: same id,
  // confirmation_code preserved, financials filled in, source becomes
  // 'airbnb_csv'. Pure inserts for codes that don't exist yet.
  const writtenBookings = []
  if (newBookings.length) {
    const codes = newBookings.map(b => b.confirmation_code)
    const { data: existing, error: lookupErr } = await supabase
      .schema(SCHEMA).from('bookings')
      .select('id, confirmation_code, source')
      .in('confirmation_code', codes)
    if (lookupErr) throw lookupErr
    const existingByCode = new Map(existing.map(b => [b.confirmation_code, b]))

    const toInsert = []
    const toUpdate = []
    for (const row of newBookings) {
      const prior = existingByCode.get(row.confirmation_code)
      if (!prior) { toInsert.push(row); continue }
      if (prior.source === 'email') {
        // Strip property_id and confirmation_code from the patch:
        // the row keeps its id; we just overwrite financials + dates
        // + source. nights/dates from CSV are authoritative. A CSV
        // row means Airbnb paid out, so it also reinstates a booking
        // a cancellation email retired (guest cancelled, host kept
        // the payout).
        const { property_id: _drop, ...patch } = row
        Object.assign(patch, { status: 'active', cancelled_at: null, cancelled_reason: null })
        toUpdate.push({ id: prior.id, patch })
      }
      // source='airbnb_csv' (already-imported) or 'legacy_xls' — leave alone.
    }

    if (toInsert.length) {
      const { data, error } = await supabase
        .schema(SCHEMA).from('bookings')
        .insert(toInsert)
        .select('id, confirmation_code')
      if (error) throw error
      writtenBookings.push(...data)
    }
    for (const { id, patch } of toUpdate) {
      const { data, error } = await supabase
        .schema(SCHEMA).from('bookings')
        .update(patch).eq('id', id)
        .select('id, confirmation_code').single()
      if (error) throw error
      writtenBookings.push(data)
    }
  }
  const insertedBookings = writtenBookings
  // Also resolve any pre-existing bookings the payouts might match
  // against (in case a Reservation row was already in DB but a new
  // Payout for it shows up in this CSV).
  const allCodes = [...new Set(payouts.map(p => p._match_code).filter(Boolean))]
  const codeToId = new Map(writtenBookings.map(b => [b.confirmation_code, b.id]))
  if (allCodes.length) {
    const { data: existing, error } = await supabase
      .schema(SCHEMA).from('bookings')
      .select('id, confirmation_code')
      .in('confirmation_code', allCodes)
    if (error) throw error
    for (const b of existing) codeToId.set(b.confirmation_code, b.id)
  }
  let payoutRows = payouts.map(p => {
    const { _match_code, ...rest } = p
    return { ...rest, booking_id: codeToId.get(_match_code) ?? null }
  })
  // Idempotent re-import: drop payouts already stored. reference_code is
  // uniquely indexed, so inserting one again would abort the whole batch
  // (and the booking writes above already committed). Skipping keeps a
  // re-run of the same CSV a no-op on the payout side.
  const payoutRefs = payoutRows.map(p => p.reference_code).filter(Boolean)
  if (payoutRefs.length) {
    const { data: existingPayouts, error: pErr } = await supabase
      .schema(SCHEMA).from('payouts')
      .select('reference_code')
      .in('reference_code', payoutRefs)
    if (pErr) throw pErr
    const havePayout = new Set(existingPayouts.map(r => r.reference_code))
    payoutRows = payoutRows.filter(p => !p.reference_code || !havePayout.has(p.reference_code))
  }
  let insertedPayouts = []
  if (payoutRows.length) {
    const { data, error } = await supabase
      .schema(SCHEMA).from('payouts')
      .insert(payoutRows)
      .select('id')
    if (error) throw error
    insertedPayouts = data
  }
  let cancelled = []
  if (unpaidIds.length) {
    const { data, error } = await supabase
      .schema(SCHEMA).from('bookings')
      .update({
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
        cancelled_reason: 'Not paid out in Airbnb CSV',
      })
      .in('id', unpaidIds)
      .eq('source', 'email')
      .select('id')
    if (error) throw error
    cancelled = data
  }
  return {
    bookingsInserted: insertedBookings.length,
    payoutsInserted: insertedPayouts.length,
    bookingsCancelled: cancelled.length,
  }
}

/* ──────────────────────────────────────────────────────────────────────
   Adjustments — per-booking cleaning override and freestanding lines
   ────────────────────────────────────────────────────────────────────── */

/**
 * Replaces any existing cleaning-fee adjustment on this booking. We
 * keep the table model "one adjustment per booking" by deleting the
 * old row before inserting the new one — atomic enough for one user.
 */
export async function setCleaningAdjustment(bookingId, overridePhp, reason) {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not signed in')
  const { error: delErr } = await supabase
    .schema(SCHEMA).from('booking_adjustments')
    .delete().eq('booking_id', bookingId)
  if (delErr) throw delErr
  const { data, error } = await supabase
    .schema(SCHEMA).from('booking_adjustments')
    .insert({
      booking_id: bookingId,
      cleaning_fee_override_php: overridePhp,
      reason,
      created_by: user.id,
    })
    .select().single()
  if (error) throw error
  return data
}

export async function clearCleaningAdjustment(bookingId) {
  const { error } = await supabase
    .schema(SCHEMA).from('booking_adjustments')
    .delete().eq('booking_id', bookingId)
  if (error) throw error
}

export async function addFreestandingAdjustment({ occurredDate, statementPeriod,
                                                  description, amountPhp,
                                                  moneydanceAccount }) {
  const prop = await getProperty()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not signed in')
  const { data, error } = await supabase
    .schema(SCHEMA).from('freestanding_adjustments')
    .insert({
      property_id: prop.id,
      occurred_date: occurredDate,
      statement_period: statementPeriod || null,
      description,
      amount_php: amountPhp,
      moneydance_account: moneydanceAccount,
      created_by: user.id,
    })
    .select().single()
  if (error) throw error
  return data
}

export async function deleteFreestandingAdjustment(id) {
  const { error } = await supabase
    .schema(SCHEMA).from('freestanding_adjustments')
    .delete().eq('id', id)
  if (error) throw error
}

/* ──────────────────────────────────────────────────────────────────────
   Quarter-view reads — month-bucketed totals + statement + payments
   ────────────────────────────────────────────────────────────────────── */

function quarterBounds(yyyymm) {
  const [y, m] = yyyymm.split('-').map(Number)
  const qIdx = Math.floor((m - 1) / 3)
  const startM = qIdx * 3 + 1
  const start = `${y}-${String(startM).padStart(2, '0')}-01`
  const endM = startM + 2
  const lastDay = new Date(Date.UTC(y, endM, 0)).getUTCDate()
  const end = `${y}-${String(endM).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
  return { start, end, year: y, qIdx, months: [startM, startM+1, startM+2] }
}

export function quarterForMonth(yyyymm) { return quarterBounds(yyyymm) }

export async function listBookingsForQuarter(yyyymm) {
  const prop = await getProperty()
  const { start, end } = quarterBounds(yyyymm)
  // Include bookings starting before the quarter whose stay spills in,
  // so cross-quarter nights show up on the right side of the boundary.
  const lookback = new Date(start + 'T00:00:00Z')
  lookback.setUTCDate(lookback.getUTCDate() - 60)
  const lookbackIso = lookback.toISOString().slice(0, 10)
  const { data, error } = await supabase
    .schema(SCHEMA).from('bookings')
    .select('*, booking_adjustments(*), email_events(id, parsed_type, received_at, subject, guest_name, parsed_payload)')
    .eq('property_id', prop.id)
    .eq('status', 'active')
    .gte('start_date', lookbackIso)
    .lte('start_date', end)
    .order('start_date', { ascending: true })
  if (error) throw error
  return (data || []).filter(b => {
    const sd = new Date(b.start_date + 'T00:00:00Z')
    const ed = new Date(sd); ed.setUTCDate(ed.getUTCDate() + (b.nights || 0))
    const ms = new Date(start + 'T00:00:00Z')
    const me = new Date(end   + 'T00:00:00Z'); me.setUTCDate(me.getUTCDate() + 1)
    return sd < me && ed > ms
  })
}

export async function listExpensesForQuarter(yyyymm) {
  const prop = await getProperty()
  const { start, end } = quarterBounds(yyyymm)
  // statement_period bucket OR incurred_date within the quarter — covers
  // cross-period bills like a Jan property tax billed on Q4 statement.
  const stmtPeriods = quarterBounds(yyyymm).months.map(m =>
    `${quarterBounds(yyyymm).year}-${String(m).padStart(2, '0')}`)
  const { data, error } = await supabase
    .schema(SCHEMA).from('expenses')
    .select('*, expense_categories(slug, label)')
    .eq('property_id', prop.id)
    .or(`and(incurred_date.gte.${start},incurred_date.lte.${end}),statement_period.in.(${stmtPeriods.join(',')})`)
    .order('incurred_date', { ascending: true })
  if (error) throw error
  return data
}

export async function listMgmtPaymentsForQuarter(yyyymm) {
  const prop = await getProperty()
  const { start, end } = quarterBounds(yyyymm)
  const { data, error } = await supabase
    .schema(SCHEMA).from('mgmt_payments')
    .select('*').eq('property_id', prop.id)
    .gte('paid_at', start).lte('paid_at', end)
    .order('paid_at', { ascending: true })
  if (error) throw error
  return data
}

export async function getStatementForQuarter(yyyymm) {
  const prop = await getProperty()
  const { start, end } = quarterBounds(yyyymm)
  const { data, error } = await supabase
    .schema(SCHEMA).from('mgmt_statements')
    .select('*').eq('property_id', prop.id)
    .eq('period_start', start).eq('period_end', end).maybeSingle()
  if (error) throw error
  return data
}

/* ──────────────────────────────────────────────────────────────────────
   Quarterly statement PDF — upload, parse via Edge Function, save
   ────────────────────────────────────────────────────────────────────── */

/**
 * Upload a PDF to airbnb-statements/<period_start>--<period_end>.pdf.
 * Re-uploads overwrite (upsert=true) so editing on top is safe.
 */
export async function uploadStatementPdf(file, periodStart, periodEnd) {
  const path = `${periodStart}--${periodEnd}.pdf`
  const { error } = await supabase.storage
    .from('airbnb-statements')
    .upload(path, file, { contentType: 'application/pdf', upsert: true })
  if (error) throw error
  // Return the bucket-qualified path: the parse-mgmt-pdf Edge Function
  // requires the `airbnb-statements/` prefix (upload's data.path omits it).
  return { storage_path: `airbnb-statements/${path}` }
}

/**
 * Invoke the parse-mgmt-pdf Edge Function with the storage path of a
 * just-uploaded PDF. Returns the structured parse result.
 */
export async function parseStatementPdf(storagePath) {
  const { data, error } = await supabase.functions.invoke('parse-mgmt-pdf', {
    body: { storage_path: storagePath },
  })
  if (error) throw error
  return data
}

/**
 * Insert or update a mgmt_statement row from a parsed payload. Also
 * stores the storage path for the source PDF on the row.
 */
export async function upsertStatement({ periodStart, periodEnd, periodLength,
                                         opening, paymentsReceived, charges,
                                         ending, pdfStoragePath, parsedJson,
                                         status = 'verified' }) {
  const prop = await getProperty()
  const { data: { user } } = await supabase.auth.getUser()
  const { data: company } = await supabase.schema(SCHEMA).from('mgmt_companies').select('id').limit(1).single()
  const { data, error } = await supabase
    .schema(SCHEMA).from('mgmt_statements')
    .upsert({
      property_id: prop.id,
      mgmt_company_id: company.id,
      period_start: periodStart, period_end: periodEnd,
      period_length: periodLength,
      opening_balance_php: opening,
      payments_received_php: paymentsReceived,
      charges_php: charges,
      ending_balance_php: ending,
      pdf_storage_path: pdfStoragePath,
      parsed_json: parsedJson,
      status,
      verified_by: user?.id ?? null,
      verified_at: new Date().toISOString(),
    }, { onConflict: 'property_id,period_start,period_end' })
    .select().single()
  if (error) throw error
  return data
}

// Substring → category slug, first match wins. Classifies invoice
// expense line descriptions into a category. Unmatched → 'misc'.
const CATEGORY_RULES = [
  ['management fee', 'management'], ['cleaning fee', 'cleaning'],
  ['meralco', 'meralco'], ['pldt', 'pldt'], ['globe', 'globe'],
  ['netflix', 'netflix'], ['property tax', 'property-tax'],
  ['aircon', 'aircon'], ['queen bed', 'renovation'],
  ['repaint', 'renovation'], ['light fixture', 'renovation'],
  ['grout', 'renovation'], ['curtain', 'renovation'],
  ['amazon firestick', 'renovation'], ['kitchen gear', 'renovation'],
  ['rice cooker', 'renovation'], ['trash bin', 'renovation'],
  ['ac cleaning', 'aircon'], ['microwave', 'renovation'],
  [' ref ', 'renovation'], ['deep cleaning', 'renovation'],
  ['iron/board', 'renovation'], ['rattle noise', 'repair'],
  ['ceiling leak', 'repair'], ['door profile', 'repair'],
  ['bed boxes', 'equipment'], ['kettle', 'equipment'],
  ['chairs replacement', 'equipment'], ['globe prepaid', 'globe'],
  ['repair', 'repair'], ['replacement', 'equipment'],
  ['trucking', 'equipment'],
]

export function classifyExpense(description) {
  const d = (description || '').toLowerCase()
  for (const [sub, slug] of CATEGORY_RULES) if (d.includes(sub)) return slug
  return 'misc'
}

/**
 * Replace the mgmt-invoice expense lines attached to a statement with a
 * fresh set (idempotent: delete-then-reinsert by statement_id, mirroring
 * the Python importer). Pass the pass-through lines only — the management
 * and cleaning fees are derived from bookings, not stored as expenses.
 * Returns the number of rows written.
 */
export async function replaceStatementExpenses(statementId, statementPeriod, lines) {
  const prop = await getProperty()
  const { data: { user } } = await supabase.auth.getUser()
  const cats = await listExpenseCategories()
  const catId = slug => {
    const c = cats.find(x => x.slug === slug)
    if (!c) throw new Error(`Unknown expense category "${slug}"`)
    return c.id
  }
  const del = await supabase.schema(SCHEMA).from('expenses')
    .delete().eq('statement_id', statementId)
  if (del.error) throw del.error
  if (!lines.length) return 0
  const payload = lines.map(e => ({
    property_id: prop.id,
    category_id: catId(classifyExpense(e.description)),
    incurred_date: e.incurred_date,
    statement_period: statementPeriod,
    description: e.description,
    gross_php: e.gross_php,
    vat_php: e.vat_php || 0,
    source: 'mgmt_invoice',
    statement_id: statementId,
    created_by: user?.id ?? null,
  }))
  const { error } = await supabase.schema(SCHEMA).from('expenses').insert(payload)
  if (error) throw error
  return payload.length
}

export async function addMgmtPayment({ paidAt, amountPhp, method, reference, notes }) {
  const prop = await getProperty()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not signed in')
  const { data, error } = await supabase
    .schema(SCHEMA).from('mgmt_payments')
    .insert({
      property_id: prop.id,
      mgmt_company_id: (await supabase.schema(SCHEMA).from('mgmt_companies').select('id').limit(1).single()).data.id,
      paid_at: paidAt, amount_php: amountPhp,
      method: method || null, reference: reference || null, notes: notes || null,
      created_by: user.id,
    }).select().single()
  if (error) throw error
  return data
}

export async function listMoneydanceAccounts() {
  const { data, error } = await supabase
    .schema(SCHEMA).from('moneydance_accounts')
    .select('*').order('sort_order', { ascending: true })
  if (error) throw error
  return data
}

/* ──────────────────────────────────────────────────────────────────────
   Year view — full-history reads
   ────────────────────────────────────────────────────────────────────── */

export async function listAllBookings() {
  const prop = await getProperty()
  const { data, error } = await supabase
    .schema(SCHEMA).from('bookings')
    .select('id, start_date, nights, gross_earnings_php, airbnb_service_fee_php, cleaning_fee_php, booking_adjustments(cleaning_fee_override_php)')
    .eq('property_id', prop.id)
    .eq('status', 'active')
    .order('start_date', { ascending: true })
  if (error) throw error
  return data
}

// Final (CSV/legacy) bookings with the fields the rate history reads.
export async function listBookingRates() {
  const prop = await getProperty()
  const { data, error } = await supabase
    .schema(SCHEMA).from('bookings')
    .select('booking_date, start_date, gross_earnings_php, airbnb_service_fee_php, cleaning_fee_php, booking_adjustments(cleaning_fee_override_php)')
    .eq('property_id', prop.id)
    .eq('status', 'active')
    .neq('source', 'email')
    .gt('gross_earnings_php', 0)
    .order('start_date', { ascending: true })
  if (error) throw error
  return data
}

export async function listAllExpenses() {
  const prop = await getProperty()
  const { data, error } = await supabase
    .schema(SCHEMA).from('expenses')
    .select('id, incurred_date, gross_php, vat_php, expense_categories(slug)')
    .eq('property_id', prop.id)
    .order('incurred_date', { ascending: true })
  if (error) throw error
  return data
}

/* ──────────────────────────────────────────────────────────────────────
   Settings — CRUD over reference + contract data
   ────────────────────────────────────────────────────────────────────── */

export async function addFeeSchedule(row) {
  const prop = await getProperty()
  const { data: company } = await supabase.schema(SCHEMA).from('mgmt_companies').select('id').limit(1).single()
  const { data, error } = await supabase
    .schema(SCHEMA).from('fee_schedules')
    .insert({
      property_id: prop.id, mgmt_company_id: company.id,
      effective_from: row.effective_from,
      effective_to: row.effective_to || null,
      airbnb_host_fee_pct: row.airbnb_host_fee_pct,
      cleaning_fee_php: row.cleaning_fee_php,
      cleaning_vat_pct: row.cleaning_vat_pct || 0,
      mgmt_fee_pct: row.mgmt_fee_pct,
      mgmt_vat_pct: row.mgmt_vat_pct || 0,
      notes: row.notes || null,
    }).select().single()
  if (error) throw error
  return data
}

export async function deleteFeeSchedule(id) {
  const { error } = await supabase.schema(SCHEMA).from('fee_schedules').delete().eq('id', id)
  if (error) throw error
}

async function setFeeScheduleEnd(id, effectiveTo) {
  const { error } = await supabase.schema(SCHEMA).from('fee_schedules')
    .update({ effective_to: effectiveTo }).eq('id', id)
  if (error) throw error
}

/**
 * Start a new contract era for stays from `row.effective_from`, ending
 * the open era the day before (eras can't overlap). The two writes
 * aren't one transaction, so a failed insert reopens the era.
 */
export async function changeFeeSchedule(row) {
  const schedules = await listFeeSchedules()
  const current = schedules[schedules.length - 1]
  const dayBefore = new Date(row.effective_from + 'T00:00:00Z')
  dayBefore.setUTCDate(dayBefore.getUTCDate() - 1)
  // The ended era must keep at least two days (DB: effective_to > effective_from).
  if (dayBefore.toISOString().slice(0, 10) <= current.effective_from) {
    throw new Error(`New rates must start after ${current.effective_from}`)
  }
  const wasOpen = current.effective_to == null
  if (wasOpen) await setFeeScheduleEnd(current.id, dayBefore.toISOString().slice(0, 10))
  try {
    // Airbnb's fee is read from bookings now; carry the column forward.
    await addFeeSchedule({ ...row, effective_to: null, airbnb_host_fee_pct: current.airbnb_host_fee_pct })
  } catch (e) {
    if (wasOpen) await setFeeScheduleEnd(current.id, null)
    throw e
  } finally {
    _feeSchedulesCache = null
  }
}

/** Delete the newest era (`id`, the one the user confirmed) and reopen
 *  the one before it, so no stay date is left without terms. */
export async function deleteNewestFeeSchedule(id) {
  _feeSchedulesCache = null
  const schedules = await listFeeSchedules()
  if (schedules.length < 2) throw new Error('The first contract era can’t be deleted')
  const [prev, last] = schedules.slice(-2)
  if (last.id !== id) throw new Error('Rates changed since this page loaded. Reload and try again.')
  try {
    await deleteFeeSchedule(last.id)
    await setFeeScheduleEnd(prev.id, null)
  } finally {
    _feeSchedulesCache = null
  }
}

export async function addExpenseCategory(row) {
  const { data, error } = await supabase
    .schema(SCHEMA).from('expense_categories')
    .insert({
      slug: row.slug, label: row.label,
      default_moneydance_account: row.default_moneydance_account,
      default_has_vat: !!row.default_has_vat,
      sort_order: row.sort_order ?? 100,
    }).select().single()
  if (error) throw error
  return data
}

export async function deleteExpenseCategory(id) {
  const { error } = await supabase.schema(SCHEMA).from('expense_categories').delete().eq('id', id)
  if (error) throw error
}

export async function addMoneydanceAccount(row) {
  const { data, error } = await supabase
    .schema(SCHEMA).from('moneydance_accounts')
    .insert({ account_path: row.account_path, use_for: row.use_for || null,
              sort_order: row.sort_order ?? 100 })
    .select().single()
  if (error) throw error
  return data
}

export async function deleteMoneydanceAccount(id) {
  const { error } = await supabase.schema(SCHEMA).from('moneydance_accounts').delete().eq('id', id)
  if (error) throw error
}

/* ──────────────────────────────────────────────────────────────────────
   FX rates: now a shared Hub service in its own `fx` schema, no longer
   owned by airbnb (promoted 2026-05-16). Airbnb is just a consumer:
   bookings still convert at each line's own start-date rate via the
   daily as-of carry-forward. The implementation lives in fx-client.js;
   these re-exports keep airbnb.html's import surface unchanged.
   ────────────────────────────────────────────────────────────────────── */
export {
  fxRateForDate, fxRatesForDates, ensureFxRateForDate,
  listAllFxRates, deleteFxRate,
} from './fx-client.js'
