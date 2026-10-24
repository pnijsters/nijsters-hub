// ============================================================================
// Shared input validation + output sanitisation for every Hub app.
//
// Two concerns, one module:
//   1. escapeHtml() — the XSS guard. Any user-supplied value that ends up in
//      innerHTML / a template-literal string of HTML MUST pass through this.
//      (Prefer .textContent where possible; escapeHtml is for when you build
//      HTML strings.)
//   2. Field validators — guard user input at the UI boundary. This is
//      defence-in-depth + UX, NOT the authority: the authoritative checks live
//      in the Postgres RPCs / RLS. Never trust the client alone.
//
// Each validator returns an error STRING when invalid, or null when valid, so
// callers read naturally:  const err = vEmail(x); if (err) { show(err); return }
// vNumber/vDate also expose parsed helpers for when you need the coerced value.
// ============================================================================

// ── Output sanitisation (XSS) ──────────────────────────────────────────────
const HTML_ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPE[ch])
}
// Escape a value for use inside an HTML attribute value (same set; kept named
// for intent at call sites).
export const escapeAttr = escapeHtml

// ── Primitives ──────────────────────────────────────────────────────────────
const isBlank = (v) => v == null || String(v).trim() === ''

// ── Field validators (return error string | null) ───────────────────────────

export function vRequired(value, label = 'This field') {
  return isBlank(value) ? `${label} is required.` : null
}

// RFC-pragmatic email check. Not a full RFC 5322 parser (those enable ReDoS and
// false negatives); this rejects the obviously-invalid and is backed by the
// server. Caps length to avoid pathological input.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/
export function vEmail(value, { required = true, label = 'Email' } = {}) {
  if (isBlank(value)) return required ? `${label} is required.` : null
  const v = String(value).trim()
  if (v.length > 254) return `${label} is too long.`
  return EMAIL_RE.test(v) ? null : `Enter a valid ${label.toLowerCase()}.`
}

// Bounded text: trims, enforces min/max length, and (optionally) rejects
// control characters. Does NOT sanitise for HTML — escape at render time.
export function vText(value, { required = true, min = 0, max = 500, label = 'This field' } = {}) {
  if (isBlank(value)) return required ? `${label} is required.` : null
  const v = String(value).trim()
  if (v.length < min) return `${label} must be at least ${min} characters.`
  if (v.length > max) return `${label} must be ${max} characters or fewer.`
  // Reject NUL and other C0 control chars (except tab/newline) — never valid input.
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(v)) return `${label} contains invalid characters.`
  return null
}

// Number within an optional range; `integer` forces whole numbers.
export function vNumber(value, { required = true, min = -Infinity, max = Infinity, integer = false, label = 'This field' } = {}) {
  if (isBlank(value)) return required ? `${label} is required.` : null
  const n = Number(String(value).replace(/,/g, ''))
  if (!Number.isFinite(n)) return `${label} must be a number.`
  if (integer && !Number.isInteger(n)) return `${label} must be a whole number.`
  if (n < min) return `${label} must be at least ${min}.`
  if (n > max) return `${label} must be at most ${max}.`
  return null
}
// Parse a validated number (call after vNumber returns null).
export const toNumber = (value) => Number(String(value).replace(/,/g, ''))

// ISO calendar date (YYYY-MM-DD, as produced by <input type="date">) that is a
// real date and within an optional [min,max] range (also YYYY-MM-DD strings).
export function vDate(value, { required = true, min = null, max = null, label = 'Date' } = {}) {
  if (isBlank(value)) return required ? `${label} is required.` : null
  const v = String(value).trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return `Enter a valid ${label.toLowerCase()}.`
  const t = Date.parse(v + 'T00:00:00Z')
  if (!Number.isFinite(t)) return `Enter a valid ${label.toLowerCase()}.`
  if (min && v < min) return `${label} must be on or after ${min}.`
  if (max && v > max) return `${label} must be on or before ${max}.`
  return null
}

// Value must be one of an explicit allow-list (roles, statuses, units…). This
// is the key guard for anything mapped to a privileged action: never let an
// arbitrary string through to an RPC.
export function vEnum(value, allowed, { label = 'Value' } = {}) {
  return allowed.includes(value) ? null : `${label} must be one of: ${allowed.join(', ')}.`
}

// http/https URL only (blocks javascript:, data:, etc. — an XSS/redirect vector).
export function vUrl(value, { required = true, label = 'URL' } = {}) {
  if (isBlank(value)) return required ? `${label} is required.` : null
  let u
  try { u = new URL(String(value).trim()) } catch { return `Enter a valid ${label.toLowerCase()}.` }
  return (u.protocol === 'http:' || u.protocol === 'https:') ? null : `${label} must be an http(s) link.`
}

// Compose: run a list of validators, return the FIRST error (or null).
// e.g. firstError(() => vRequired(x,'Name'), () => vText(x,{max:80,label:'Name'}))
export function firstError(...checks) {
  for (const check of checks) {
    const err = typeof check === 'function' ? check() : check
    if (err) return err
  }
  return null
}
