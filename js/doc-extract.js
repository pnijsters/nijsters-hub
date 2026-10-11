// Document extraction — the browser side of the extract-document Edge
// Function, for any profile.
//
// Pure ES module: no DOM, no Supabase, no imports. The caller passes
// `invoke(body)`, which resolves { status, body } (a network error is
// status 0), so the loop can be tested without a server. A long statement
// takes more than one call: each successful call is handed to onPart
// before the next starts, and the next call sends back what is already
// read so the function continues after it.

// Bytes → base64. String.fromCharCode in chunks: one call per byte is
// slow, and one call for a whole file overflows the argument limit.
export function toBase64(bytes) {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  }
  return btoa(bin)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A network failure, a 401 (the window after a redeploy), any 5xx, or a
// run that ended before its first expense is worth one more try.
const retryable = ({ status, body }) =>
  status === 0 || status === 401 || status >= 500 ||
  (status === 200 && body?.ok === false && body.retryable === true)

// Read a document to the end, one call after another.
//   invoke(body) → { status, body }; data is the file as base64.
//   onPart(body) is called with every successful answer and returns the
//   `already` for the next call, or null when the reading is complete
//   (it can know better than the answer, e.g. another tab finished it).
// Each call is retried once after retryDelayMs when retryable. After
// maxCalls calls the reading stops where it is; the caller continues it
// later with the same `already`. Never throws. Returns:
//   { ok: true, complete: true }
//   { ok: true, complete: false, stopped: true }      maxCalls reached
//   { ok: false, error, retryable, status, cause? }   the call failed; cause
//        is the function's when it sent one ('account' | 'rate_limit')
//   { ok: false, error, retryable: false, stage: 'record' }   onPart threw
//   { ok: false, error, stale: true }                 onPart threw an error with .stale
export async function extractAll({
  invoke, profile, data, mime, context, already = [], onPart, maxCalls = 4, retryDelayMs = 2000,
}) {
  const call = async () => {
    try {
      return await invoke({ profile, files: [{ mime, data }], context, already })
    } catch (e) {
      return { status: 0, body: { error: e.message } }
    }
  }
  for (let calls = 1; ; calls++) {
    let res = await call()
    if (retryable(res)) {
      await sleep(retryDelayMs)
      res = await call()
    }
    const { status, body } = res
    if (status !== 200 || !body?.ok) {
      return {
        ok: false,
        error: body?.error || `The reader failed (${status})`,
        retryable: retryable(res),
        status,
        ...(body?.cause && { cause: body.cause }),
      }
    }
    let next
    try {
      next = await onPart(body)
    } catch (e) {
      if (e.stale) return { ok: false, error: e.message, stale: true }
      return { ok: false, error: e.message, retryable: false, stage: 'record' }
    }
    if (body.complete || next == null) return { ok: true, complete: true }
    if (calls >= maxCalls) return { ok: true, complete: false, stopped: true }
    already = next
  }
}

// Why a failed reading should stop the readings still waiting: a failure
// that isn't about this document, so the next document would fail the
// same way. null when it is (5xx or a run out of time after the retry, a
// file refused by the function, a throw before any call) or nothing failed.
//   'account'  the Anthropic account: credit, spend limit, key, model
//   'rate'     Anthropic's rate limit
//   'session'  the Hub session: a 401 after the retry, or a 403
//   'network'  the connection
//   'record'   what was read couldn't be kept
export function pauseOf(r) {
  if (r.ok) return null
  if (r.cause === 'account') return 'account'
  if (r.cause === 'rate_limit') return 'rate'
  if (r.status === 401 || r.status === 403) return 'session'
  if (r.status === 0) return 'network'
  if (r.stage === 'record') return 'record'
  return null
}
