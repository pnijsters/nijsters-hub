// Medical receipts — the rules behind medical.html.
//
// Pure ES module: no DOM, no Supabase, no imports. It mirrors the checks in
// supabase/2026-10-03b_medical_receipts.sql so the drawer can say what is
// wrong before a save; Postgres stays the authority. Money is held as
// integer cents. It reaches the database as an exact 2-decimal string, so
// numeric(12,2) never rounds what was typed, and leaves this module as
// dollars.

export const CATEGORIES = ['dental', 'vision', 'pharmacy', 'doctor', 'hospital',
  'lab', 'mental_health', 'equipment', 'other']
// The patient value that means "patient unknown" (patient_id null): a card
// slip prints no patient. Not a uuid, so it can't be a patient's id.
export const PATIENT_UNKNOWN = 'unknown'
export const STATUSES = ['not_submitted', 'submitted', 'reimbursed']

// ── money ─────────────────────────────────────────────────────────────────

const MAX_CENTS = 999999999999   // numeric(12,2): 9,999,999,999.99
const MONEY_RE = /^\$?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?|\.\d{1,2})$/

// '$1,234.5' → 123450. Digits with optional thousands commas and at most
// two decimals; anything else (a sign, three decimals, '1,23') is null
// rather than a guess.
export function parseCents(input) {
  const s = String(input ?? '').trim()
  if (!MONEY_RE.test(s)) return null
  const [whole, frac = ''] = s.replace(/[$,]/g, '').split('.')
  const cents = Number(whole || '0') * 100 + Number(frac.padEnd(2, '0'))
  return cents <= MAX_CENTS ? cents : null
}

// 12550 → '125.50'
export const centsToDb = (c) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`

// A numeric(12,2) as PostgREST returns it (number or string) → cents.
export const dbToCents = (v) => (v == null ? 0 : Math.round(Number(v) * 100))

// ── dates ─────────────────────────────────────────────────────────────────

// A real calendar day as YYYY-MM-DD within the years the file name can
// spell (the database's expense_service_date range).
function isIsoDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v)
  if (!m || m[1] < '1000') return false
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3]
}

// ── expense ───────────────────────────────────────────────────────────────

// The control characters js/validate.js refuses too. They are invisible,
// and Postgres text can't hold NUL at all.
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/

// The drawer's values → the row to insert or update.
//   input: { patient_id (or PATIENT_UNKNOWN), provider, service_date, category, amount_paid,
//            paid_with_hsa_card, reimbursement_status, date_submitted,
//            amount_reimbursed, notes }   (amounts as typed)
// Returns { row, error: null } or { row: null, error: { field, message } }.
// Reimbursement values that don't apply are dropped, not rejected: an
// expense paid with the HSA card has none, 'not submitted' has no date or
// amount, and 'submitted' has no amount.
export function expenseRow(input) {
  const fail = (field, message) => ({ row: null, error: { field, message } })
  const text = (v) => String(v ?? '').trim()

  const patientId = text(input.patient_id)
  if (!patientId) return fail('patient_id', 'Choose the patient.')
  const provider = text(input.provider)
  if (!provider) return fail('provider', 'Enter the provider.')
  if (CONTROL_RE.test(provider)) return fail('provider', 'The provider has an invisible character in it. Retype it.')
  const serviceDate = text(input.service_date)
  if (!isIsoDate(serviceDate)) return fail('service_date', 'Enter the date of service.')
  if (!CATEGORIES.includes(input.category)) return fail('category', 'Choose a category.')
  const paid = parseCents(input.amount_paid)
  if (paid == null) return fail('amount_paid', 'Enter the amount paid, like 125.00.')
  const notes = text(input.notes)
  if (CONTROL_RE.test(notes)) return fail('notes', 'The notes have an invisible character in them. Retype them.')

  const row = {
    patient_id: patientId === PATIENT_UNKNOWN ? null : patientId,
    provider,
    service_date: serviceDate,
    category: input.category,
    amount_paid: centsToDb(paid),
    paid_with_hsa_card: input.paid_with_hsa_card === true,
    reimbursement_status: null,
    date_submitted: null,
    amount_reimbursed: null,
    notes: notes || null,
  }
  if (row.paid_with_hsa_card) return { row, error: null }

  const status = input.reimbursement_status
  if (!STATUSES.includes(status)) return fail('reimbursement_status', 'Choose the reimbursement status.')
  row.reimbursement_status = status
  if (status === 'not_submitted') return { row, error: null }

  const submitted = text(input.date_submitted)
  if (submitted || status === 'submitted') {
    if (!isIsoDate(submitted)) return fail('date_submitted', 'Enter the date submitted.')
    if (submitted < serviceDate) return fail('date_submitted', "The date submitted can't be before the date of service.")
    row.date_submitted = submitted
  }
  if (status === 'submitted') return { row, error: null }

  const reimbursed = parseCents(input.amount_reimbursed)
  if (reimbursed == null) return fail('amount_reimbursed', 'Enter the amount reimbursed, like 80.00.')
  if (reimbursed === 0) return fail('amount_reimbursed', 'The amount reimbursed must be more than 0.')
  if (reimbursed > paid) return fail('amount_reimbursed', "The amount reimbursed can't be more than the amount paid.")
  row.amount_reimbursed = centsToDb(reimbursed)
  return { row, error: null }
}

// The columns that void an expense, or the reason one is needed.
export function voidRow(reason, nowIso) {
  const r = String(reason ?? '').trim()
  if (!r) return { row: null, error: { field: 'void_reason', message: 'Say why this is being voided.' } }
  if (CONTROL_RE.test(r)) {
    return { row: null, error: { field: 'void_reason', message: 'The reason has an invisible character in it. Retype it.' } }
  }
  return { row: { voided_at: nowIso, void_reason: r }, error: null }
}

// ── totals ────────────────────────────────────────────────────────────────

// What is still to be reimbursed for one expense, in cents: paid minus
// reimbursed. Nothing for a voided expense or one paid with the HSA card.
export function outstandingCents(e) {
  if (e.voided_at || e.paid_with_hsa_card) return 0
  return dbToCents(e.amount_paid) - dbToCents(e.amount_reimbursed)
}

// Σ(paid − reimbursed) across expenses, in dollars.
export function unreimbursedTotal(expenses) {
  return expenses.reduce((sum, e) => sum + outstandingCents(e), 0) / 100
}

// ── the expense table ─────────────────────────────────────────────────────

// Where an expense is in its reimbursement, in the order it moves through
// it. An expense paid with the HSA card has nothing to reimburse, so it is
// only 'hsa', whatever reimbursement_status says. Reimbursed for less than
// was paid is 'partly_reimbursed'; the rest still counts as unreimbursed.
const LIFECYCLE = ['not_submitted', 'submitted', 'partly_reimbursed', 'reimbursed', 'hsa']
export function lifecycleOf(e) {
  if (e.paid_with_hsa_card) return 'hsa'
  if (e.reimbursement_status === 'reimbursed') {
    return dbToCents(e.amount_reimbursed) < dbToCents(e.amount_paid) ? 'partly_reimbursed' : 'reimbursed'
  }
  return e.reimbursement_status === 'submitted' ? 'submitted' : 'not_submitted'
}

const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
// The table's own order, as listExpenses() returns it: the newest service
// first, then the newest saved, then by id. Two visits saved together
// share created_at, so only the id keeps them in one place.
const newestFirst = (a, b) => order(b.service_date, a.service_date) || order(b.created_at, a.created_at) || order(a.id, b.id)
// Text as a person reads it: case and accents aside, 9 before 10.
const byText = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })

// The expenses sorted by one column, key 'date', 'patient', 'provider',
// 'category', 'paid' or 'status', dir 'asc' or 'desc'.
//   names  { patient: (patient_id) => name, category: (category) => label },
//          as the page shows them: patient and category sort by that text,
//          like the provider. The patient unknown sorts last either way.
// Status sorts in lifecycle order. Rows that tie keep the table's own
// order (newest first) in both directions, so a re-sort never shuffles
// them.
export function sortExpenses(expenses, { key, dir }, names) {
  const by = {
    date: (a, b) => newestFirst(b, a),
    patient: (a, b) => byText(names.patient(a.patient_id), names.patient(b.patient_id)),
    provider: (a, b) => byText(a.provider, b.provider),
    category: (a, b) => byText(names.category(a.category), names.category(b.category)),
    paid: (a, b) => dbToCents(a.amount_paid) - dbToCents(b.amount_paid),
    status: (a, b) => LIFECYCLE.indexOf(lifecycleOf(a)) - LIFECYCLE.indexOf(lifecycleOf(b)),
  }[key]
  const sign = dir === 'asc' ? 1 : -1
  const unknownLast = (a, b) => (key === 'patient' ? (a.patient_id == null) - (b.patient_id == null) : 0)
  return [...expenses].sort((a, b) => unknownLast(a, b) || sign * by(a, b) || newestFirst(a, b))
}

// The expenses the filters let through. Each filter is 'all', or
//   status    'not_submitted', 'submitted', 'reimbursed' (partly
//             reimbursed too) or 'hsa' (paid with the HSA card);
//   patient   a patient id, or PATIENT_UNKNOWN for patient_id null;
//   category  one of CATEGORIES.
export function filterExpenses(expenses, { status, patient, category }) {
  return expenses.filter((e) => {
    const s = lifecycleOf(e)
    return (status === 'all' || s === status || (status === 'reimbursed' && s === 'partly_reimbursed')) &&
      (patient === 'all' || (e.patient_id ?? PATIENT_UNKNOWN) === patient) &&
      (category === 'all' || e.category === category)
  })
}

// ── documents ─────────────────────────────────────────────────────────────

const startsWith = (b, sig, at = 0) => sig.every((x, i) => b[at + i] === x)
const PDF_SIG = [0x25, 0x50, 0x44, 0x46, 0x2d]   // %PDF-

// A HEIF-family photo (an iPhone's HEIC) starts with an ftyp box: its
// size, 'ftyp', the major brand, a minor version, then the compatible
// brands. The HEVC brands are HEIC; mif1 and msf1 only say HEIF, unless a
// compatible brand is HEVC too. Other ftyp files (AVIF, MP4) are null.
const HEIC_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs']
const HEIF_BRANDS = ['mif1', 'msf1']
const brandAt = (b, at) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3])
function heifMime(bytes) {
  if (bytes.length < 12 || brandAt(bytes, 4) !== 'ftyp') return null
  const major = brandAt(bytes, 8)
  if (HEIC_BRANDS.includes(major)) return 'image/heic'
  if (!HEIF_BRANDS.includes(major)) return null
  const end = Math.min(bytes.length, ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0)
  for (let at = 16; at + 4 <= end; at += 4) {
    if (HEIC_BRANDS.includes(brandAt(bytes, at))) return 'image/heic'
  }
  return 'image/heif'
}

// The type from the file's first bytes: File.type is only a guess from
// its extension. PDF readers accept the header anywhere in the first
// 1024 bytes, so this does too. Anything else is null.
export function sniffMime(bytes) {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  const heif = heifMime(bytes)
  if (heif) return heif
  for (let i = 0; i + PDF_SIG.length <= Math.min(bytes.length, 1024); i++) {
    if (startsWith(bytes, PDF_SIG, i)) return 'application/pdf'
  }
  return null
}

// Lowercase hex SHA-256, the form medical.document.sha256 stores.
export async function sha256Hex(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('')
}

// ── reading ───────────────────────────────────────────────────────────────

// The patient names extract-document accepts, as its request.ts checks
// them: words of letters, apostrophes, periods and hyphens.
export const FIRST_NAME_RE = /^\p{L}[\p{L}\p{M}'’.-]*( [\p{L}\p{M}'’.-]+)*$/u
const NAME_MAX = 40
const MAX_ALIASES = 5
const plainName = (n) => typeof n === 'string' && n.length <= NAME_MAX && FIRST_NAME_RE.test(n)

// The patients as extract-document's context. A patient or alias whose name
// the function would refuse is left out, so one bad stored name can't fail
// every reading (that patient can still be chosen in the review).
export function contextFor(patients) {
  return {
    patients: patients.filter((p) => plainName(p.first_name)).map((p) => {
      const seen = new Set()
      const also = (p.also_printed_as || []).filter((n) => {
        if (!plainName(n)) return false
        if (seen.has(n.toLowerCase())) return false
        seen.add(n.toLowerCase())
        return true
      })
      return { id: p.id, first_name: p.first_name, also_printed_as: also.slice(0, MAX_ALIASES) }
    }),
  }
}

// What a document's drafts already hold, as extract-document's `already`:
// the values as read (never as edited), for every draft in document order,
// saved and discarded ones too, so the next call never returns them again.
export function alreadyOf(drafts) {
  return [...drafts].sort((a, b) => a.ordinal - b.ordinal).map(({ extracted: { fields: f } }) => ({
    service_date: f.service_date.value,
    provider: f.provider.value,
    amount_paid: f.amount_paid.value,
  }))
}

// One draft → the review form.
//   draft.extracted: { fields: { name: { value, evidence } }, missing }
//   cards: Map last4 → is_hsa (the known cards)
// Returns { input, flags, card }:
//   input  the values in the shape expenseRow() takes;
//   flags  { field: 'not_found' | 'check' | 'choose' | 'answer' }: a required
//          value that wasn't read (no evidence), was read but refused
//          (evidence kept), a patient to choose (a name printed that is
//          nobody's), or a new card to answer. A visit that prints no
//          patient (a card slip) is the patient unknown, with nothing to
//          choose;
//   card   { last4, known, is_hsa, hint }. A known card decides whether
//          the HSA card paid. A new one is asked once. No card printed
//          saves as not paid with the HSA card. hint is what the document
//          says about the card ({ value, evidence } or null): shown, never
//          deciding.
export function draftForm(draft, cards) {
  const f = draft.extracted.fields
  const v = (name) => f[name].value ?? ''
  const last4 = f.payment_card_last4.value
  const known = cards.has(last4)
  const card = {
    last4,
    known,
    is_hsa: known ? cards.get(last4) : null,
    hint: f.card_marked_hsa_fsa.value == null ? null : f.card_marked_hsa_fsa,
  }
  const amount = f.amount_paid.value
  const slip = f.patient_name_printed.value == null && f.suggested_patient_id.value == null
  const input = {
    patient_id: slip ? PATIENT_UNKNOWN : v('suggested_patient_id'),
    provider: v('provider'),
    service_date: v('service_date'),
    category: v('category'),
    amount_paid: amount == null ? '' : centsToDb(Math.round(amount * 100)),
    paid_with_hsa_card: card.is_hsa === true,
    reimbursement_status: 'not_submitted',
    date_submitted: '',
    amount_reimbursed: '',
    notes: v('service_description'),
  }
  const flags = {}
  for (const name of ['service_date', 'provider', 'category', 'amount_paid']) {
    if (f[name].value == null) flags[name] = f[name].evidence ? 'check' : 'not_found'
  }
  if (f.suggested_patient_id.value == null && !slip) flags.patient_id = 'choose'
  if (last4 != null && !known) flags.card = 'answer'
  return { input, flags, card }
}

// The review's forms are a Map draft id → draftForm(), edited in place,
// in document order; `discarded` is a Set of draft ids.

// What stops a save, the first of: a new card not answered, a same
// purchase not answered (or a second visit merging into the expense
// another already merges into), the reading not finished, a visit to save
// whose values fail expenseRow(), the original not stored, every visit
// discarded. Returns null, or
// { reason, message, id?, field?, last4? } where id is the visit's draft.
//   cardsAnswered: the last4s now known (a Set, or the cards Map).
//   choices:       Map draft id → mergeChoice(), for the visits that match a
//                  saved expense; null until the user picks one. A merged
//                  visit's own values aren't saved, so they aren't checked.
export function saveBlockers({ forms, discarded, cardsAnswered, uploaded, complete, choices = new Map() }) {
  const live = [...forms].filter(([id]) => !discarded.has(id))
  for (const [id, { card }] of live) {
    if (card.last4 != null && !card.known && !cardsAnswered.has(card.last4)) {
      return { reason: 'card', id, last4: card.last4, message: 'Answer the card question.' }
    }
  }
  const into = new Set()
  for (const [id] of live) {
    const c = choices.get(id)
    if (choices.has(id) && !c) return { reason: 'choice', id, message: 'Say whether it is the same purchase.' }
    if (c?.action !== 'merge') continue
    if (into.has(c.expense_id)) {
      return { reason: 'choice', id, message: 'Two visits merge into one expense. Choose another answer for one.' }
    }
    into.add(c.expense_id)
  }
  if (!complete) return { reason: 'reading', message: "The reading isn't finished." }
  for (const [id, { input }] of live) {
    if (choices.get(id)?.action === 'merge') continue
    const { error } = expenseRow(input)
    if (error) return { reason: 'field', id, field: error.field, message: error.message }
  }
  if (!uploaded) return { reason: 'upload', message: "The original isn't stored yet." }
  if (!live.length) {
    return { reason: 'nothing', message: 'Every visit is discarded. Restore one, or discard the document.' }
  }
  return null
}

// Over the visits not discarded: how many, what they paid in cents, how
// many amounts aren't read yet, and how many still need a check.
export function reviewTotals(forms, discarded) {
  const t = { visits: 0, paidCents: 0, unread: 0, toCheck: 0 }
  for (const [id, { input }] of forms) {
    if (discarded.has(id)) continue
    t.visits++
    const cents = parseCents(input.amount_paid)
    if (cents == null) t.unread++
    else t.paidCents += cents
    if (expenseRow(input).error) t.toCheck++
  }
  return t
}

// The items save_document takes: every open draft once, in document order,
// either discarded, merged into a saved expense (choices, as saveBlockers
// takes them, each merge with card: whether it fills in the HSA card, and
// patient_id: the patient it fills in, worked out from the review as it is
// when the items are built), or saved with its expense values (the patient
// unknown as null). Reimbursement isn't sent: the database sets it from
// paid_with_hsa_card.
export function saveItems(drafts, forms, discarded, choices = new Map()) {
  return [...drafts]
    .filter((d) => d.expense_id == null && d.discarded_at == null)
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((d) => {
      if (discarded.has(d.id)) return { draft_id: d.id, action: 'discard' }
      const c = choices.get(d.id)
      if (c?.action === 'merge') {
        return {
          draft_id: d.id, action: 'merge', expense_id: c.expense_id,
          ...(c.cents != null && { amount_paid: centsToDb(c.cents) }),
          ...(c.card && { paid_with_hsa_card: true }),
          ...(c.patient_id && { patient_id: c.patient_id }),
        }
      }
      const { row, error } = expenseRow(forms.get(d.id).input)
      if (error) throw new Error(error.message)
      const { reimbursement_status, date_submitted, amount_reimbursed, ...expense } = row
      return { draft_id: d.id, action: 'save', ...expense }
    })
}

// ── same purchase ─────────────────────────────────────────────────────────

// Words that say what kind of business a provider is, not which one. Of
// these the live list (2026-10-05, 73 expenses) uses Associates, Assoc, PA,
// PLLC, Group and MD; the rest are their siblings. Of is part of a name
// (Laboratory Corporation of America) and stays. On that list the rule
// joins the Fort Bend Dental spellings, and also a hospital's name with its
// departments' (Sugar Land Hospital, … Hospital MRI), so the provider alone
// never makes a same purchase: the amount has to agree too.
const PROVIDER_FILLER = new Set(['pc', 'pa', 'pllc', 'llc', 'llp', 'lp', 'inc', 'co', 'corp', 'ltd',
  'dds', 'dmd', 'md', 'do', 'od', 'associates', 'associate', 'assoc', 'group', 'the'])
const PROVIDER_SPELLING = { ft: 'fort', st: 'saint', mt: 'mount' }
const providerKeys = new Map()

// A provider's name as the words that compare: lowercase ASCII without
// accents, & as and, apostrophes dropped (Children's is Childrens), dotted
// initials joined (P.A. is PA), every other run of punctuation a space,
// Ft, St and Mt spelled out, the filler words left out.
// 'Ft. Bend Dental Associates, P.A.' → 'fort bend dental'.
export function providerKey(name) {
  const s = String(name ?? '')
  if (!providerKeys.has(s)) {
    providerKeys.set(s, s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/&/g, ' and ').replace(/['’]/g, '').replace(/\b(?:[a-z]\.){2,}/g, (m) => m.replace(/\./g, ''))
      .split(/[^a-z0-9]+/)
      .map((w) => PROVIDER_SPELLING[w] ?? w)
      .filter((w) => w && !PROVIDER_FILLER.has(w))
      .join(' '))
  }
  return providerKeys.get(s)
}

// Two names are one provider when one's words are the first words of the
// other's: 'Fort Bend Dental Associa' (a cut name) is Fort Bend Dental;
// 'Bend Dental Associates' isn't. Not fuzzy: no word may differ.
export function sameProvider(a, b) {
  const x = providerKey(a), y = providerKey(b)
  if (!x || !y) return false
  const [short, long] = x.length <= y.length ? [x, y] : [y, x]
  return long === short || long.startsWith(short + ' ')
}

const DAY_MS = 86400000
const dayOf = (iso) => (isIsoDate(iso ?? '') ? Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) : NaN)

// Words of a pharmacy description that don't say which product it was:
// purchase words, counts, units, dosage forms and salts.
const DRUG_FILLER = new Set([
  'rx', 'prescription', 'prescriptions', 'medication', 'medications', 'medicine', 'medicines', 'drug', 'drugs',
  'pharmacy', 'generic', 'brand', 'refill', 'refills', 'otc', 'item', 'items', 'product', 'products', 'copay',
  'sale', 'purchase', 'purchases', 'pickup', 'picked', 'pick', 'fill', 'filled', 'dispensed', 'eligible', 'fsa',
  'hsa', 'cvs', 'walgreens', 'health', 'store', 'counter', 'over', 'the', 'and', 'with', 'for', 'including',
  'includes', 'plus', 'other', 'various', 'misc', 'miscellaneous', 'supply', 'supplies', 'day', 'days', 'qty',
  'quantity', 'count', 'each', 'pack', 'box', 'bottle', 'total', 'name', 'specialty', 'patient',
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'mcg', 'unit', 'units', 'meq',
  'tab', 'tabs', 'tablet', 'tablets', 'cap', 'caps', 'capsule', 'capsules', 'softgel', 'softgels', 'vegicap',
  'vegicaps', 'odt', 'cream', 'ointment', 'solution', 'suspension', 'syrup', 'suppository', 'suppositories',
  'inhaler', 'spray', 'drops', 'patch', 'patches', 'injection', 'pen', 'vial', 'liquid', 'gel', 'lotion',
  'chewable', 'oral', 'topical', 'nasal', 'ophthalmic', 'film', 'coated', 'delayed', 'release', 'extended',
  'sodium', 'potassium', 'calcium', 'hcl', 'hydrochloride', 'besylate', 'besy', 'succinate', 'tartrate',
  'citrate', 'sulfate', 'acetate', 'maleate', 'mesylate'])

// What a pharmacy purchase was, from the reader's description of it: the
// words that can name a product. 'Zolmitriptan 5 MG ODT, qty 6' →
// ['zolmitriptan']; 'Two prescriptions picked up' → [].
export function drugWords(description) {
  return String(description ?? '').normalize('NFD').toLowerCase().split(/[^a-z]+/)
    .filter((w) => w.length >= 3 && !DRUG_FILLER.has(w))
}
const drugsOf = (category, descriptions) =>
  (category === 'pharmacy' ? [...new Set(descriptions.flatMap(drugWords))] : [])

// A visit to match: { patient_id, provider, service_date, cents, kind, pharmacy, drugs }.
//   kind 'paid'       a payment for a printed patient (a receipt, a statement's visit);
//        'slip'       a payment that prints no patient (a card slip; its total
//                     may include a card fee);
//        'no_payment' a visit on a document nothing was paid on (an EOB);
//                     cents is the share it says the patient owes, null
//                     when none was read (or the reading predates shares).
//   drugs  for a pharmacy purchase, what its descriptions name (drugWords).
// A draft's visit holds its values as the review has them (input), else
// as read; what it was for is always as read.
export function draftVisit(draft, input = null) {
  const f = draft.extracted.fields
  const patient = input ? input.patient_id : f.suggested_patient_id.value
  const category = input ? input.category : f.category.value
  return {
    patient_id: patient && patient !== PATIENT_UNKNOWN ? patient : null,
    provider: input ? input.provider : f.provider.value,
    service_date: (input ? input.service_date : f.service_date.value) || null,
    cents: input ? parseCents(input.amount_paid) : f.amount_paid.value == null ? null : Math.round(f.amount_paid.value * 100),
    kind: f.patient_name_printed.value == null ? 'slip' : 'paid',
    pharmacy: category === 'pharmacy',
    drugs: drugsOf(category, [f.service_description.value]),
  }
}
export const noPaymentVisit = ({ fields: f }) => ({
  patient_id: f.suggested_patient_id.value, provider: f.provider.value, service_date: f.service_date.value,
  cents: f.patient_responsibility?.value == null ? null : Math.round(f.patient_responsibility.value * 100),
  kind: 'no_payment', pharmacy: false, drugs: [],
})
// A saved expense as a visit. slips: how many of the visits on it printed
// no patient (card slips already on it); items: what its visits were for;
// both from the expense's drafts.
export const expenseVisit = (e) => ({
  patient_id: e.patient_id, provider: e.provider, service_date: e.service_date, cents: dbToCents(e.amount_paid),
  slips: e.slips ?? 0, pharmacy: e.category === 'pharmacy', drugs: drugsOf(e.category, e.items ?? []),
})

// A slip: a payment that prints no patient, waiting (kind 'slip'), or saved
// from one with the patient unknown. An expense the user saved as Patient
// unknown from a visit is a visit.
const isSlip = (o) => o.kind === 'slip' || (o.kind == null && o.patient_id == null && o.slips > 0)
// A slip's total is the visit's plus at most a 5% card fee ($3,515 for
// $3,500, $56.91 for $54.72).
export const FEE_BAND_PERCENT = 5
const withinFee = (slip, paid) => slip >= paid && slip * 100 <= paid * (100 + FEE_BAND_PERCENT)
// Two pharmacy purchases that each name something are the same purchase
// only when they share a word of it: 'Docusate Sodium 100 MG' and 'Amlodipine
// and Docusate' can be; 'Zolmitriptan 5 MG ODT' and 'Meloxicam 15 mg' can't.
// A description that names nothing ('Two prescriptions picked up') never
// stands in the way.
const sameDrug = ({ drugs: a = [] }, { drugs: b = [] }) => !a.length || !b.length || a.some((d) => b.includes(d))

// Whether visit v is the same purchase as o (a saved expense, or a visit
// still waiting): the same money on two documents. The same provider,
// never two different drugs, and both amounts read; then
//   paid        the same patient and the same amount to the cent, on the
//               same date of service, or for pharmacy purchases at most 7
//               days apart (filled one day, picked up the next);
//   slip        the same date, any patient, the slip's total the visit's
//               plus at most the card fee (two slips: the same amount).
// An EOB's visits match by eobMatches() instead. A patient not known on either side is any patient. Amounts that differ
// otherwise are different purchases, however close the day: one hospital
// visit bills $120.27, $1,286.50 and $4,450 separately.
export function samePurchase(v, o) {
  const patient = v.patient_id == null || o.patient_id == null || v.patient_id === o.patient_id
  const sameDay = v.service_date != null && v.service_date === o.service_date
  if (!sameProvider(v.provider, o.provider) || !sameDrug(v, o)) return false
  if (v.cents == null || o.cents == null) return false
  const vSlip = v.kind === 'slip', oSlip = isSlip(o)
  if (vSlip && oSlip) return sameDay && v.cents === o.cents
  if (vSlip) return sameDay && withinFee(v.cents, o.cents)
  if (oSlip) return sameDay && withinFee(o.cents, v.cents)
  if (!patient || v.cents !== o.cents) return false
  return sameDay ||
    (v.pharmacy && o.pharmacy && Math.abs(dayOf(v.service_date) - dayOf(o.service_date)) <= 7 * DAY_MS)
}

// Candidates by date and by amount: one look-up per visit, not a scan.
function addTo(index, o) {
  for (const [map, k] of [[index.byDate, o.service_date], [index.byCents, o.cents]]) {
    if (k == null) continue
    if (!map.has(k)) map.set(k, [])
    map.get(k).push(o)
  }
}
function matchesIn(index, v) {
  const near = new Set([...(index.byDate.get(v.service_date) ?? []),
    ...(v.kind === 'paid' ? index.byCents.get(v.cents) ?? [] : [])])
  return [...near].filter((o) => samePurchase(v, o))
}

// Every same purchase of every visit, the user choosing among several.
//   docs      [{ id, visits: [{ id, ...visit }] }] in To review order
//   expenses  the saved expenses, each { id, ...expenseVisit() }
// A document is checked against the saved expenses and against the visits
// of the documents listed before it, never against its own (the reader
// lists each visit once).
// Returns Map visit id → [{ expense } | { waiting, docId }], for the visits
// with a match.
export function samePurchases(docs, expenses) {
  const saved = { byDate: new Map(), byCents: new Map() }
  const earlier = { byDate: new Map(), byCents: new Map() }
  for (const e of expenses) addTo(saved, e)
  const found = new Map()
  for (const doc of docs) {
    for (const v of doc.visits) {
      const m = [...matchesIn(saved, v).map((e) => ({ expense: e })),
        ...matchesIn(earlier, v).map((w) => ({ waiting: w, docId: w.docId }))]
      if (m.length) found.set(v.id, m)
    }
    for (const v of doc.visits) addTo(earlier, { ...v, docId: doc.id })
  }
  return found
}

// The saved expenses a kept document's visits with no payment (an EOB's
// claims) are proof for: the same patient and date of service, and the
// share the EOB says the patient owes equal to the expense's amount to the
// cent. The provider isn't compared: an EOB prints the insurer's billing
// entity (TMH Physician Associates), never the practice on the receipt.
// A claim matches on its own share; the claims of one patient's day that
// match nothing on their own match on their total (one visit billed as two
// claims, $5.22 and $21.20, paid as $26.42). A share of $0, or none read,
// matches nothing: that claim cost the patient nothing, or can't be told
// from the other visits that day.
//   visits    [{ id, ...noPaymentVisit() }], in document order
//   expenses  the saved expenses, each { id, ...expenseVisit() }
// Returns [{ visits, cents, cands }] for each claim, or day, that matches:
// cands the expenses it can be. One attaches by itself; of several, the
// user picks.
export function eobMatches(visits, expenses) {
  const days = new Map()
  for (const v of visits) {
    if (v.patient_id == null || v.service_date == null) continue
    const k = `${v.patient_id} ${v.service_date}`
    if (!days.has(k)) days.set(k, [])
    days.get(k).push(v)
  }
  const out = []
  for (const day of days.values()) {
    const same = expenses.filter((e) => e.patient_id === day[0].patient_id && e.service_date === day[0].service_date)
    const at = (cents) => (cents ? same.filter((e) => e.cents === cents) : [])
    const own = day.map((v) => ({ visits: [v], cents: v.cents, cands: at(v.cents) })).filter((m) => m.cands.length)
    const rest = day.filter((v) => !own.some((m) => m.visits[0] === v))
    out.push(...own)
    if (rest.length > 1 && rest.every((v) => v.cents != null)) {
      const cents = rest.reduce((sum, v) => sum + v.cents, 0)
      const cands = at(cents)
      if (cands.length) out.push({ visits: rest, cents, cands })
    }
  }
  return out
}

// The amount a visit merges into a saved expense at, in cents: the
// expense's own, which a merge leaves as it is; only a visit that prints
// the patient joining a slip saved with the patient unknown sets its own,
// since the slip's total can include the card fee.
export const mergeCents = (v, expense) => (v.kind === 'paid' && expense.patient_id == null ? v.cents : expense.cents)

// Whether merging a visit makes the expense paid with the HSA card: the
// expense's documents printed no card (expense.cards: the last4s read
// from them), the visit's card is known to be the HSA card, and the
// expense isn't submitted or reimbursed yet.
export function mergeFillsCard(expense, card, cards) {
  return !expense.paid_with_hsa_card && !expense.cards?.length && card.last4 != null &&
    cards.get(card.last4) === true && expense.reimbursement_status === 'not_submitted'
}

// A same purchase that merges by itself: the visit's only match, a saved
// expense, and
//   a visit for a matched patient, at the same amount to the cent: the
//   same visit on another statement or a second copy, left as it is;
//   a visit for a matched patient joining an expense saved with the
//   patient unknown, its total within the card fee: at the visit's own
//   amount, and it fills the patient in;
//   a slip joining a visit within the card fee, at the visit's amount.
// Returns the merge, or null: any other match, or two, waits for the user.
// So does a slip whose one match is another slip (an expense whose
// patient is unknown: two siblings' $50 copays, or one visit paid in two
// parts) or a visit that already holds a slip (a second payment the same
// day).
export function autoMerge(v, matches = []) {
  if (matches.length !== 1 || !matches[0].expense) return null
  const e = matches[0].expense
  if (v.cents == null || e.cents == null) return null
  const ok = v.kind === 'paid'
    ? v.patient_id != null && (e.patient_id == null ? withinFee(e.cents, v.cents) : v.cents === e.cents)
    : v.kind === 'slip' && e.patient_id != null && !e.slips && withinFee(v.cents, e.cents)
  return ok ? mergeChoice(e, mergeCents(v, e)) : null
}

// What a visit does without the user: with no same purchase it saves as
// read (a slip with the patient unknown); with one that qualifies it
// merges (autoMerge). null: it waits for the user, a match only waiting in
// To review included.
export const autoChoice = (v, matches = []) => (matches.length ? autoMerge(v, matches) : NEW_CHOICE)

// Whether a document's visits may save themselves, as far as duplicates
// go: each has its autoChoice (found: from samePurchases()), and no two
// merge into one expense (save_document refuses that; the user picks).
export function autoSavable(visits, found) {
  const choices = visits.map((v) => autoChoice(v, found.get(v.id)))
  const into = choices.filter((c) => c?.action === 'merge').map((c) => c.expense_id)
  return choices.every((c) => c != null) && new Set(into).size === into.length
}

// A visit's answer to a same purchase: Merge into one saved expense at
// mergeCents() (cents null keeps the expense's), or save it as new.
// Discarding it is the review's own Discard. Whether a merge fills in the
// card isn't part of the answer: the card question may change after it.
export const mergeChoice = (expense, cents) =>
  ({ action: 'merge', expense_id: expense.id, cents: cents === expense.cents ? null : cents })
export const NEW_CHOICE = { action: 'new' }

// ── to review ─────────────────────────────────────────────────────────────

// Where id sits in ids, for a pager: { at, of, prev, next }. at is 1-based
// (0 when id isn't there); prev and next are its neighbours, null at the
// ends (no wrap).
export function around(ids, id) {
  const i = ids.indexOf(id)
  return {
    at: i + 1,
    of: ids.length,
    prev: i > 0 ? ids[i - 1] : null,
    next: i >= 0 && i < ids.length - 1 ? ids[i + 1] : null,
  }
}

const KIND_OF_STATE = {
  upload_incomplete: 'upload_incomplete', unread: 'unread', stopped: 'stopped',
  review: 'ready', nothing_found: 'nothing_found',
}

// The status of one To review row, the first that applies.
//   state  the medical.inbox_document state, or null for a file with no
//          document row yet;
//   the flags are what this tab knows: refused (not added), saved here,
//   reading, queued to read, retrying an upload, storing the original,
//   readError (the last reading here failed).
// Storing only shows once the document isn't being read or waiting to be:
// those say more.
export function rowKind({ state, refused, saved, reading, queued, retrying, storing, readError }) {
  if (refused) return 'not_added'
  if (saved) return 'saved'
  if (reading) return 'reading'
  if (queued) return 'queued'
  if (retrying) return 'retrying'
  if (storing && state !== null) return 'storing'
  if (readError) return 'couldnt_read'
  if (state === null) return 'queued'   // its row is being made
  return KIND_OF_STATE[state]
}

// The batch tally over its rows, kinds = [{ kind, expenses }] (expenses:
// how many a saved row saved). Returns { read, of, toReview, saved,
// failed, already }: of counts the documents (a file not added isn't one,
// but it did fail; one already uploaded didn't), saved counts expenses.
export function batchCounts(kinds) {
  const c = { read: 0, of: 0, toReview: 0, saved: 0, failed: 0, already: 0 }
  for (const { kind, expenses } of kinds) {
    if (kind === 'already') { c.already++; continue }
    if (kind !== 'not_added') c.of++
    if (kind === 'ready' || kind === 'saved' || kind === 'nothing_found') c.read++
    if (kind === 'ready') c.toReview++
    if (kind === 'saved') c.saved += expenses
    if (kind === 'couldnt_read' || kind === 'not_added' || kind === 'upload_incomplete') c.failed++
  }
  return c
}
