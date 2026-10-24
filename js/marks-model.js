// Marks: where a visit's lines are on a document, so a copy of it can show
// whoever reviews the claim which rows are this expense.
//
// Pure: no DOM, no PDF or OCR library. js/mark-document.js gives the words
// of a document (its own text, or OCR of a scan) and what the reader read
// for the visit; this finds the rows to mark.
//
// A word is { page, text, box: [left, top, right, bottom] }, in the page's
// units as it is shown (top down). Words on one page whose heights overlap
// by more than half make a row, read left to right.
//
// The amount is what pins a visit down: its payment line carries it, and
// OCR reads digits better than words. The reader's quotes of the line are
// tried first, word for word (OCR may misread one letter in eight, never a
// digit); a quote that isn't found that way is looked for by its amounts
// alone. Where an amount is printed for more than one visit, the date of
// service nearest above it says which. Nothing is guessed: what can't be
// told apart is left unmarked.

// Letters and digits only, lower case: what is compared.
const squash = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
// Every number in a text as printed: -$1,286.50 → 1,286.50; 05/25/21.
const NUMBER_RE = /\d+(?:[.,/:-]\d+)*/g
// A number's digits: 1,286.50 → 128650, 05/25/21 → 052521.
const digits = (n) => n.replace(/\D/g, '')
const numbersOf = (s) => (s.match(NUMBER_RE) ?? []).map(digits)
// An amount, as cents without leading zeros: a number printed with cents
// (OCR may read the point as a comma): 1,286.50 → 128650, 0.38 → 38; or
// after a dollar sign, with one decimal or none: $604.6 → 60460, $100 →
// 10000. A barcode's digits (0000864) or a strength (2.5 MG) are no amount.
function amountOf(n, dollar) {
  const cents = /[.,]\d{2}$/.test(n) ? digits(n)
    : dollar && /\.\d$/.test(n) ? `${digits(n)}0`
    : dollar && /^\d{1,3}(,\d{3})*$|^\d+$/.test(n) ? `${digits(n)}00`
    : null
  return cents?.replace(/^0+(?=\d)/, '') ?? null
}
// The numbers in a text: [{ n (digits), amount }].
const numbersIn = (s) => [...s.matchAll(NUMBER_RE)]
  .map((m) => ({ n: digits(m[0]), amount: amountOf(m[0], /\$\s?$/.test(s.slice(0, m.index))) }))
const amountsOf = (s) => numbersIn(s).map((x) => x.amount).filter(Boolean)

// A quote shorter than this (once squashed) is too common to place.
const MIN_QUOTE = 4
// Of the width of a page's text, a gap in a row that parts two things
// printed side by side (a label and its receipt scanned together); a
// table's columns are closer.
const SIDE_BY_SIDE = 0.15
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october',
  'november', 'december']

// words → rows, in reading order (page, then top to bottom). Each row:
// { page, top, bottom, gap, words, text (squashed), at (the word each
// character of text comes from), numbers: [{ n, amount, w, last }] (each
// number's digits, and its amount when it is one, and the words it is
// printed in) }.
export function rowsOf(words) {
  // Of punctuation alone, only what joins digits stays (a decimal point set
  // apart is part of its number); OCR's specks and rules would join rows.
  const sorted = words.filter((w) => squash(w.text) || /^[.,/:-]$/.test(w.text.trim()))
    .sort((a, b) => a.page - b.page || a.box[1] - b.box[1] || a.box[0] - b.box[0])
  const rows = []
  const extent = new Map()
  for (const w of sorted) {
    const h = w.box[3] - w.box[1]
    const row = rows.findLast((r) => r.page === w.page &&
      Math.min(r.bottom, w.box[3]) - Math.max(r.top, w.box[1]) > Math.min(h, r.bottom - r.top) / 2)
    if (row) row.words.push(w)
    else rows.push({ page: w.page, top: w.box[1], bottom: w.box[3], words: [w] })
    const e = extent.get(w.page) ?? [Infinity, -Infinity]
    extent.set(w.page, [Math.min(e[0], w.box[0]), Math.max(e[1], w.box[2])])
  }
  for (const r of rows) {
    const [left, right] = extent.get(r.page)
    r.gap = (right - left) * SIDE_BY_SIDE
    r.words.sort((a, b) => a.box[0] - b.box[0])
    r.text = ''
    r.at = []
    r.words.forEach((w, k) => {
      const s = squash(w.text)
      r.text += s
      for (let i = 0; i < s.length; i++) r.at.push(k)
    })
    // Words that touch are one: some PDFs set each glyph apart.
    r.numbers = []
    for (let k = 0; k < r.words.length; k++) {
      const first = k
      let s = r.words[k].text
      while (k + 1 < r.words.length && touch(r.words[k], r.words[k + 1])) s += r.words[++k].text
      for (const x of numbersIn(s)) r.numbers.push({ ...x, w: first, last: k })
    }
  }
  return rows
}

// Two words that are one: the gap between them under a quarter of a character.
function touch(a, b) {
  return b.box[0] - a.box[2] <= (a.box[2] - a.box[0]) / Math.max(a.text.length, 1) / 4
}

// The closest stretch of t to q: { dist, start, end }, dist the edits
// between q and t.slice(start, end) (Sellers' algorithm: the stretch may
// start anywhere in t).
function closest(q, t) {
  let prev = new Array(t.length + 1).fill(0)
  let prevStart = Array.from({ length: t.length + 1 }, (_, j) => j)
  for (let i = 1; i <= q.length; i++) {
    const cur = [i]
    const curStart = [0]
    for (let j = 1; j <= t.length; j++) {
      const same = prev[j - 1] + (q[i - 1] === t[j - 1] ? 0 : 1)
      const lessQ = prev[j] + 1
      const moreT = cur[j - 1] + 1
      if (same <= lessQ && same <= moreT) { cur[j] = same; curStart[j] = prevStart[j - 1] }
      else if (lessQ <= moreT) { cur[j] = lessQ; curStart[j] = prevStart[j] }
      else { cur[j] = moreT; curStart[j] = curStart[j - 1] }
    }
    prev = cur
    prevStart = curStart
  }
  let best = { dist: Infinity, start: 0, end: 0 }
  for (let j = 0; j <= t.length; j++) if (prev[j] < best.dist) best = { dist: prev[j], start: prevStart[j], end: j }
  return best
}

// A place: { row, boxes: [{ page, row, box }], x }, x the middle of its
// first box across. spans: [{ r, from, to }], the words from..to of row r.
function place(rows, row, spans) {
  const boxes = spans.map(({ r, from, to }) => {
    const ws = rows[r].words.slice(from, to + 1)
    return { page: rows[r].page, row: r, box: [Math.min(...ws.map((w) => w.box[0])), Math.min(...ws.map((w) => w.box[1])),
      Math.max(...ws.map((w) => w.box[2])), Math.max(...ws.map((w) => w.box[3]))] }
  })
  return { row, boxes, x: (boxes[0].box[0] + boxes[0].box[2]) / 2 }
}

// Where a quote is, word for word: [place]. Every number in it must be on
// those rows as it is; the letters may differ by one in eight. A quote may
// run on into the next row (a wrapped heading).
function findQuote(rows, quote) {
  const q = squash(quote)
  if (q.length < MIN_QUOTE) return []
  const nums = numbersOf(quote)
  const allowed = Math.floor(q.length / 8)
  const out = []
  for (let i = 0; i < rows.length; i++) {
    for (const span of [1, 2]) {
      const rs = rows.slice(i, i + span)
      if (rs.length < span || rs.some((r) => r.page !== rows[i].page)) break
      const have = rs.flatMap((r) => r.numbers.map((x) => x.n))
      if (!nums.every((n) => have.includes(n))) continue
      let t = rs.map((r) => r.text).join('')
      const found = []
      for (;;) {
        let m = { dist: 0, start: t.indexOf(q) }
        if (m.start >= 0) m.end = m.start + q.length
        else if (allowed && t.length >= q.length - allowed) m = closest(q, t)
        else break
        if (m.start < 0 || m.dist > allowed) break
        found.push(m)
        t = t.slice(0, m.start) + '\0'.repeat(m.end - m.start) + t.slice(m.end)
      }
      // A wrapped quote starts in row i and ends in the next one.
      const own = found.filter((m) => span === 1 || (m.start < rs[0].text.length && m.end > rs[0].text.length))
      for (const m of own) {
        const spans = []
        let from = m.start
        let to = m.end
        rs.forEach((r, k) => {
          const a = Math.max(0, from)
          const b = Math.min(r.text.length, to)
          if (b > a) spans.push({ r: i + k, from: r.at[a], to: r.at[b - 1] })
          from -= r.text.length
          to -= r.text.length
        })
        out.push(place(rows, i, spans))
      }
      if (own.length) break
    }
  }
  return out
}

// Where amounts (as amountsOf gives them) are, all on one row:
// [place], their row's words around them up to a gap that parts things
// side by side: a table's row, or a receipt's line, as a whole.
function findAmounts(rows, amounts) {
  if (!amounts.length) return []
  const out = []
  rows.forEach((r, i) => {
    const at = amounts.map((a) => r.numbers.find((x) => x.amount === a))
    if (at.some((x) => !x)) return
    let from = Math.min(...at.map((x) => x.w))
    let to = Math.max(...at.map((x) => x.last))
    while (from > 0 && r.words[from].box[0] - r.words[from - 1].box[2] <= r.gap) from--
    while (to < r.words.length - 1 && r.words[to + 1].box[0] - r.words[to].box[2] <= r.gap) to++
    out.push(place(rows, i, [{ r: i, from, to }]))
  })
  return out
}

// A date of service as documents print it: 05/25/21, 5/25/2021,
// 2021-05-25 (numbers), or May 25, NOV 03 (a month and its day). iso:
// 'YYYY-MM-DD'.
function findDate(rows, iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '')
  if (!m) return []
  const [, y, mm, dd] = m
  const md = [[mm, dd], [String(+mm), String(+dd)], [mm, String(+dd)], [String(+mm), dd]]
  const nums = new Set([...md.flatMap(([a, b]) => [a + b + y.slice(2), a + b + y]), y + mm + dd])
  const month = MONTHS[+mm - 1]
  const isMonth = (w) => { const t = w.text.toLowerCase().replace(/[^a-z]/g, ''); return t.length >= 3 && month.startsWith(t) }
  const isDay = (w) => +(/^\d{1,2}(?!\d)/.exec(w.text)?.[0] ?? NaN) === +dd
  const out = []
  rows.forEach((r, i) => {
    const hit = r.numbers.find((x) => nums.has(x.n))
    if (hit) { out.push(place(rows, i, [{ r: i, from: hit.w, to: hit.last }])); return }
    const k = r.words.findIndex((w, k) => isMonth(w) && r.words[k + 1] && isDay(r.words[k + 1]))
    if (k >= 0) out.push(place(rows, i, [{ r: i, from: k, to: k + 1 }]))
  })
  return out
}

// Of found places, the one nearest to a place `to`: on the nearest row at
// or above it (or below, when none is above and `either`), then nearest
// across, as receipts scanned side by side print their provider on one
// row. null when none, or when two are as near.
function nearest(found, to, either = false) {
  const above = found.filter((f) => f.row <= to.row)
  const pool = above.length || !either ? above : found
  if (!pool.length) return null
  const rowD = (f) => Math.abs(to.row - f.row)
  const near = pool.filter((f) => rowD(f) === Math.min(...pool.map(rowD)))
  const xD = (f) => Math.abs(to.x - f.x)
  const best = near.filter((f) => xD(f) === Math.min(...near.map(xD)))
  return best.length === 1 ? best[0] : null
}

// A field's evidence as separate quotes: the reader joins lines with " | "
// and leaves words out with "...".
export const quotesOf = (evidence) =>
  String(evidence ?? '').split(/\s\|\s|\.\.\.|…/).map((s) => s.trim()).filter(Boolean)

// One visit's marks: { marks: [{ page, box, kinds }], found: { paid, date, head } },
// kinds what a mark shows: 'paid', 'date', 'head'. Its payment marked or
// nothing: a date and provider alone point at no payment.
// visit:
//   paid         the evidence of its payment lines (an EOB claim: of the patient's share)
//   date, head   the evidence of its date of service and of its provider
//   amounts      its amounts in cents, looked for in turn when no payment
//                line is found: the visit's, then the expense's (a card slip's
//                total carries a fee its base amount, the expense's, doesn't)
//   serviceDate  'YYYY-MM-DD', looked for when its date's evidence isn't found
//   alone        it is the only visit on the document: where its amount is
//                printed more than once with no date to tell, every place is its own
export function locate(rows, { paid = '', date = '', head = '', amounts = [], serviceDate = null, alone = false }) {
  const paidQuotes = quotesOf(paid)
  const dates = quotesOf(date).flatMap((q) => findQuote(rows, q))
  if (!dates.length) dates.push(...findDate(rows, serviceDate))
  const heads = quotesOf(head).flatMap((q) => findQuote(rows, q))

  // Each payment line's places: word for word, else by its amounts; with
  // no payment line found, by the visit's amounts in turn.
  const lines = paidQuotes.filter((q) => numbersOf(q).length).map((q) => {
    const found = findQuote(rows, q)
    return found.length ? found : findAmounts(rows, amountsOf(q))
  })
  for (const a of amounts) {
    if (lines.some((l) => l.length)) break
    lines.push(findAmounts(rows, [String(a)]))
  }
  const chosen = []
  for (const found of lines) {
    if (found.length === 1) { chosen.push({ ...found[0], kind: 'paid' }); continue }
    // The place with a date nearest above it, alone.
    const d = (f) => { const n = nearest(dates, f); return n ? f.row - n.row : Infinity }
    const best = Math.min(...found.map(d))
    const at = found.filter((f) => d(f) === best)
    if (Number.isFinite(best) && at.length === 1) chosen.push({ ...at[0], kind: 'paid' })
    else if (alone) chosen.push(...found.map((f) => ({ ...f, kind: 'paid' })))
  }
  if (!chosen.length) return { marks: [], found: { paid: false, date: false, head: false } }
  // A quote with no number only adds to a row a payment line already marked.
  for (const q of paidQuotes.filter((q) => !numbersOf(q).length)) {
    const on = findQuote(rows, q).filter((f) => chosen.some((c) => c.row === f.row))
    if (on.length === 1) chosen.push({ ...on[0], kind: 'paid' })
  }
  const first = chosen.reduce((a, b) => (b.row < a.row ? b : a))
  const d = nearest(dates, first, true)
  if (d) chosen.push({ ...d, kind: 'date' })
  const h = nearest(heads, d ?? first, true)
  if (h) chosen.push({ ...h, kind: 'head' })

  // One mark per row: what is on the same row is marked together.
  const byRow = new Map()
  for (const c of chosen) {
    for (const b of c.boxes) {
      const m = byRow.get(b.row)
      if (!m) { byRow.set(b.row, { page: b.page, box: [...b.box], kinds: [c.kind] }); continue }
      m.box = [Math.min(m.box[0], b.box[0]), Math.min(m.box[1], b.box[1]), Math.max(m.box[2], b.box[2]), Math.max(m.box[3], b.box[3])]
      if (!m.kinds.includes(c.kind)) m.kinds.push(c.kind)
    }
  }
  return { marks: [...byRow.values()], found: { paid: true, date: !!d, head: !!h } }
}
