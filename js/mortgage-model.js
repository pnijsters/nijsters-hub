// Mortgage amortization + modeling engine.
//
// Pure ES module — no DOM, no Supabase, no imports. Every dollar is held
// internally as an integer number of cents so 360 rounds of multiply/round
// never drift off a real lender's schedule. Dollars (floats) cross the API
// boundary; cents stay inside.
//
// Scope notes (deliberate simplifications, see the mortgage brief):
//   • Schedule is MONTHLY. Chase amortizes monthly and the statements are
//     monthly, so that's the contract we model.
//   • BIWEEKLY autopay is not simulated. For ACTUALS it's already encoded in
//     the observed paid-principal per statement; for MODELLING it's the
//     standard "13th payment" trick — express it as a `monthly` extra rule of
//     scheduled_pi / 12.
//   • ESCROW is excluded from amortization entirely (it's not principal or
//     interest). Escrow is tracked from the statement snapshots separately.
//
// `terms` shape (dollars):
//   { originalPrincipal, annualRate /* fraction, e.g. 0.03 */, termMonths,
//     scheduledPi, firstPaymentDate /* 'YYYY-MM-DD' */ }

// ── money helpers ───────────────────────────────────────────────────────
const toCents = (d) => Math.round(d * 100)
const toDollars = (c) => c / 100

// Monthly rate as a full-precision fraction (NOT rounded — only the per-row
// interest dollar amount is rounded to the cent, the way a servicer does it).
export function monthlyRate(annualRate) {
  return annualRate / 12
}

// Add whole months to a 'YYYY-MM-DD' date, returning a new ISO date. Day is
// pinned to the first of the month (payments post monthly; the day-of-month
// is immaterial to the schedule).
function addMonths(iso, n) {
  const [y, m] = iso.split('-').map(Number)
  const total = (y * 12 + (m - 1)) + n
  const yy = Math.floor(total / 12)
  const mm = (total % 12) + 1
  return `${yy}-${String(mm).padStart(2, '0')}-01`
}

// ── (i) baseline schedule ────────────────────────────────────────────────
// Generate the contractual amortization from the loan terms alone, with an
// optional per-month extra-principal function (cents in, cents out) used by
// applyExtra(). Returns a Schedule.
//
//   Schedule = {
//     rows: [{ n, date, payment, principal, interest, balance, extra }],
//     payoffDate, totalInterest, totalPaid, months
//   }
function buildSchedule(terms, startBalanceCents, startDate, startN, extraForMonth) {
  const r = monthlyRate(terms.annualRate)
  const pmt = toCents(terms.scheduledPi)
  const HARD_CAP = terms.termMonths + 600   // backstop against a non-amortizing rate

  let balance = startBalanceCents
  let n = startN
  let date = startDate
  let totalInterest = 0
  let totalPaid = 0
  const rows = []

  while (balance > 0 && rows.length < HARD_CAP) {
    const interest = Math.round(balance * r)
    let principal = pmt - interest
    // A fully-amortizing loan always has principal > 0; guard anyway so a
    // pathological rate can't loop forever.
    if (principal <= 0) break

    let payment = pmt
    // Final payment true-up: clear the balance when this payment would retire
    // it, or at the contractual maturity month (the rounded scheduled payment
    // leaves a small residual a servicer folds into the last payment).
    if (principal >= balance || n >= terms.termMonths) {
      principal = balance
      payment = principal + interest
    }
    let extra = extraForMonth ? extraForMonth(date, balance - principal) : 0
    if (extra > balance - principal) extra = balance - principal   // cap at remaining
    if (extra < 0) extra = 0

    balance = balance - principal - extra
    totalInterest += interest
    totalPaid += payment + extra

    rows.push({
      n,
      date,
      payment: toDollars(payment),
      principal: toDollars(principal),
      interest: toDollars(interest),
      extra: toDollars(extra),
      balance: toDollars(balance),
    })
    n += 1
    date = addMonths(date, 1)
  }

  return {
    rows,
    payoffDate: rows.length ? rows[rows.length - 1].date : startDate,
    totalInterest: toDollars(totalInterest),
    totalPaid: toDollars(totalPaid),
    months: rows.length,
  }
}

export function baselineSchedule(terms) {
  return buildSchedule(
    terms,
    toCents(terms.originalPrincipal),
    terms.firstPaymentDate,
    1,
    null,
  )
}

// ── (ii) apply extra-payment rules ───────────────────────────────────────
// rules: ExtraPaymentRule[]
//   { kind:'monthly',  amount, startDate?, endDate? }
//   { kind:'annual',   amount, month /* 1-12 */, startYear?, endYear? }
//   { kind:'onetime',  amount, date /* 'YYYY-MM-DD' */ }
//
// opts.startBalance / opts.startDate / opts.startN let a projection begin from
// a known point (e.g. the latest statement's unpaid principal) instead of
// origination. Omit for a from-origination model.
export function applyExtra(terms, rules = [], opts = {}) {
  const startBalance = opts.startBalance != null
    ? toCents(opts.startBalance) : toCents(terms.originalPrincipal)
  const startDate = opts.startDate || terms.firstPaymentDate
  const startN = opts.startN || 1

  const extraForMonth = (date, _remaining) => {
    const [y, m] = date.split('-').map(Number)
    let cents = 0
    for (const rule of rules) {
      if (!rule || !rule.amount) continue
      if (rule.kind === 'monthly') {
        if (rule.startDate && date < rule.startDate) continue
        if (rule.endDate && date > rule.endDate) continue
        cents += toCents(rule.amount)
      } else if (rule.kind === 'annual') {
        if (m !== rule.month) continue
        if (rule.startYear && y < rule.startYear) continue
        if (rule.endYear && y > rule.endYear) continue
        cents += toCents(rule.amount)
      } else if (rule.kind === 'onetime') {
        // Match on the payment month (day-of-month is immaterial).
        if (rule.date && rule.date.slice(0, 7) === date.slice(0, 7)) {
          cents += toCents(rule.amount)
        }
      }
    }
    return cents
  }

  return buildSchedule(terms, startBalance, startDate, startN, extraForMonth)
}

// ── comparison ────────────────────────────────────────────────────────────
export function compare(baseline, modified) {
  return {
    payoffBaseline: baseline.payoffDate,
    payoffModified: modified.payoffDate,
    monthsSaved: baseline.months - modified.months,
    interestSaved: Math.round((baseline.totalInterest - modified.totalInterest) * 100) / 100,
  }
}

// ── (iii) solve for the extra needed to hit a target payoff date ──────────
// target: 'YYYY-MM-DD' (or 'YYYY-MM') — the month the loan should be gone.
// mode:
//   { kind:'monthly' }                 → solve a monthly extra
//   { kind:'annual', month }           → solve an annual lump in `month`
//   { kind:'onetime', date }           → solve a single lump on `date`
// Binary search is safe: payoff date is monotonic non-increasing in the extra
// amount. Returns { amount, schedule, achievedPayoff }.
export function solveExtra(terms, target, mode = { kind: 'monthly' }, opts = {}) {
  const targetYm = target.slice(0, 7)
  const ruleFor = (amount) => {
    if (mode.kind === 'monthly') return [{ kind: 'monthly', amount }]
    if (mode.kind === 'annual') return [{ kind: 'annual', amount, month: mode.month }]
    if (mode.kind === 'onetime') return [{ kind: 'onetime', amount, date: mode.date }]
    return []
  }
  const payoffOf = (amount) => applyExtra(terms, ruleFor(amount), opts).payoffDate.slice(0, 7)

  // No extra at all already meets the target → nothing to solve.
  if (payoffOf(0) <= targetYm) {
    const schedule = applyExtra(terms, [], opts)
    return { amount: 0, schedule, achievedPayoff: schedule.payoffDate }
  }

  // Find an upper bound that beats the target (double until it does, capped).
  let hi = 100
  for (let i = 0; i < 40 && payoffOf(hi) > targetYm; i++) hi *= 2
  let lo = 0
  // Bisect to the nearest dollar.
  for (let i = 0; i < 60 && hi - lo > 1; i++) {
    const mid = (lo + hi) / 2
    if (payoffOf(mid) <= targetYm) hi = mid
    else lo = mid
  }
  const amount = Math.ceil(hi)
  const schedule = applyExtra(terms, ruleFor(amount), opts)
  return { amount, schedule, achievedPayoff: schedule.payoffDate }
}

// Whole months between two ISO dates (b - a), by year*12+month. Chase
// statement dates drift around the cycle (the 30th/1st), so we compare by
// calendar month, not day.
function monthsBetween(a, b) {
  const [ay, am] = a.split('-').map(Number)
  const [by, bm] = b.split('-').map(Number)
  return (by * 12 + (bm - 1)) - (ay * 12 + (am - 1))
}

// ── (iv) overlay ACTUALS from statements ──────────────────────────────────
// statements: rows from listStatements() (unique by statement_date — the DB
//   enforces it), each with statement_date, unpaid_principal, escrow_balance,
//   paid_principal/interest/escrow, plus an optional `transactions` array.
//
// The contractual balance curve and the actual curve are simply overlaid on a
// shared time axis; nothing needs per-statement schedule matching. "Ahead of
// schedule" is read off the vertical gap between the two curves, which is the
// honest measure (it folds in both explicit extra principal and the biweekly
// 13th-payment effect).
//
//   {
//     actualBalance:    [{ date, balance }],      // realized UPB curve
//     scheduledBalance: [{ date, balance }],      // contract curve, same span
//     aheadOfSchedule:  number,                   // $ below the contract today
//     monthsAhead:      number | null,            // payoff months pulled forward
//     extraPrincipalPaid: number,                 // Σ additional-principal txns
//     interestPaid:     number,                   // Σ interest paid to date
//     escrowBalance:    [{ date, balance }],
//     escrowIn:         number,                   // Σ escrow paid in
//     escrowOut:        [{ date, amount, label }],// disbursements (txn + derived)
//     latest:           statement | null,
//     project: (rules) => Schedule                // forward model from `latest`
//   }
export function overlayActuals(terms, statements, base) {
  const sorted = [...statements].sort((a, b) =>
    a.statement_date < b.statement_date ? -1 : 1)
  const num = (v) => (v == null ? 0 : Number(v))
  const baseSched = base || baselineSchedule(terms)

  const actualBalance = sorted
    .filter(s => s.unpaid_principal != null)
    .map(s => ({ date: s.statement_date, balance: num(s.unpaid_principal) }))
  const escrowBalance = sorted
    .filter(s => s.escrow_balance != null)
    .map(s => ({ date: s.statement_date, balance: num(s.escrow_balance) }))

  // paid-since-last is non-overlapping, so summing it is exact.
  const interestPaid = sorted.reduce((t, s) => t + num(s.paid_interest), 0)
  const escrowIn = sorted.reduce((t, s) => t + num(s.paid_escrow), 0)

  // Explicit extra principal: sum the additional-principal transaction lines.
  let extraPrincipalPaid = 0
  for (const s of sorted) {
    for (const t of (s.transactions || [])) {
      if (t.kind === 'additional_principal' && t.principal) extraPrincipalPaid += Number(t.principal)
    }
  }

  // Contract balance at a calendar month (the baseline curve sampled there).
  const baseByYm = new Map(baseSched.rows.map(r => [r.date.slice(0, 7), r]))
  const contractBalanceAt = (date) => {
    const row = baseByYm.get(date.slice(0, 7))
    return row ? row.balance : null
  }
  const scheduledBalance = actualBalance
    .map(p => ({ date: p.date, balance: contractBalanceAt(p.date) }))
    .filter(p => p.balance != null)

  const latest = sorted.length ? sorted[sorted.length - 1] : null

  // Ahead of schedule (dollars): how far the real balance sits below the
  // contract at the latest statement's month.
  let aheadOfSchedule = 0, monthsAhead = null
  if (latest && latest.unpaid_principal != null) {
    const upb = num(latest.unpaid_principal)
    const contractNow = contractBalanceAt(latest.statement_date)
    if (contractNow != null) aheadOfSchedule = Math.round((contractNow - upb) * 100) / 100
    // Months pulled forward: the contract reaches today's balance at row M;
    // the elapsed payment count is months since the first payment.
    const contractRow = baseSched.rows.find(r => r.balance <= upb)
    const elapsed = monthsBetween(terms.firstPaymentDate, latest.statement_date) + 1
    if (contractRow) monthsAhead = contractRow.n - elapsed
  }

  // Escrow disbursements: prefer the explicit transaction lines; fall back to
  // deriving from consecutive escrow balances when a statement has no txns.
  const escrowOut = []
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i]
    const txnOuts = (cur.transactions || []).filter(t => t.kind === 'escrow_disbursement' && t.escrow)
    if (txnOuts.length) {
      for (const t of txnOuts) escrowOut.push({
        date: t.txn_date || cur.statement_date,
        amount: Math.abs(Number(t.escrow)),
        label: t.description || 'Escrow disbursement',
      })
    } else if (i > 0) {
      const prev = sorted[i - 1]
      if (prev.escrow_balance == null || cur.escrow_balance == null) continue
      const out = num(prev.escrow_balance) + num(cur.paid_escrow) - num(cur.escrow_balance)
      if (out > 1) escrowOut.push({
        date: cur.statement_date, amount: Math.round(out * 100) / 100, label: 'Escrow disbursement',
      })
    }
  }

  // Forward projection seeded from the latest statement's UPB (continues from
  // reality, not origination), with startN/startDate from elapsed months.
  // `projectOpts` is the same seed, exposed so callers can run solveExtra()
  // from today's balance rather than from origination.
  let projectOpts = null
  if (latest && latest.unpaid_principal != null) {
    const elapsed = monthsBetween(terms.firstPaymentDate, latest.statement_date) + 1
    projectOpts = {
      startBalance: num(latest.unpaid_principal),
      startDate: addMonths(terms.firstPaymentDate, elapsed),
      startN: elapsed + 1,
    }
  }
  const project = (rules = []) =>
    projectOpts ? applyExtra(terms, rules, projectOpts) : applyExtra(terms, rules)

  return {
    actualBalance, scheduledBalance, escrowBalance, escrowOut,
    interestPaid: Math.round(interestPaid * 100) / 100,
    escrowIn: Math.round(escrowIn * 100) / 100,
    extraPrincipalPaid: Math.round(extraPrincipalPaid * 100) / 100,
    aheadOfSchedule, monthsAhead, latest, project, projectOpts,
  }
}
