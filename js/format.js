// ============================================================================
// Shared pure formatters. One source for every app — no per-page copies.
// (Formatters whose OUTPUT differs by app, e.g. fmtDay's "5 Jul" vs
// "Jul 5, 2026", intentionally stay local: same name, different behaviour.)
// ============================================================================

// Current date as YYYY-MM-DD (UTC).
export const todayISO = () => new Date().toISOString().slice(0, 10)

// Parse a user-typed money/number string to a Number, or null if not finite.
export const toNum = (s) => {
  const v = parseFloat(String(s).replace(/[^0-9.\-]/g, ''))
  return Number.isFinite(v) ? v : null
}

// USD, whole dollars. null -> a quiet placeholder.
export const fmtUSD = (n) => (n == null ? '· · ·' : '$' + Math.round(n).toLocaleString('en-US'))
