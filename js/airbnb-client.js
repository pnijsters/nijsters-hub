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
 */
export async function importBookingsAndPayouts(newBookings, payouts) {
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
        // + source. nights/dates from CSV are authoritative.
        const { property_id: _drop, ...patch } = row
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
  return {
    bookingsInserted: insertedBookings.length,
    payoutsInserted: insertedPayouts.length,
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
