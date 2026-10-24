// Reading a dropped utility bill for the Utilities drawer.
//
// The regex parsers read it first (parse-utility-bill: free, and instant
// for the providers they know). extract-document's utility_bill profile
// reads it only when they can't: a photo, a PDF from a provider they don't
// know, or a PDF with fields they missed. Both answer a ParsedBill
// (supabase/functions/_shared/utility-parsers.ts), so the drawer prefills
// its review the same way from either.

import { parseBillPdf } from './supabase-client.js'
import { extractAll, toBase64 } from './doc-extract.js'
import { invokeExtract } from './extract-client.js'
import { forReading } from './normalize-image.js'

// The parsers' bill with each field they missed taken from the extractor's,
// when both read the same meter.
export function fillMissing(parsed, read) {
  if (read.meter !== parsed.meter) return parsed
  const bill = { ...parsed }
  for (const k of parsed.missing) if (read[k] != null) bill[k] = read[k]
  return { ...bill, missing: parsed.missing.filter((k) => bill[k] == null) }
}

// The file read by extract-document → { ok: true, bill } or { ok: false, error }.
async function extractBill(file) {
  let bill = null
  try {
    const original = new Uint8Array(await file.arrayBuffer())
    const { bytes, mime } = file.type === 'application/pdf'
      ? { bytes: original, mime: file.type }
      : await forReading(original, file.type)
    const result = await extractAll({
      invoke: invokeExtract, profile: 'utility_bill', mime, data: toBase64(bytes),
      onPart: (body) => { bill = body.bill; return null },
    })
    return result.ok ? { ok: true, bill } : { ok: false, error: result.error }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

// A PDF, JPEG or PNG bill → { ok: true, bill } (a ParsedBill, its
// `missing` what neither reader found), or { ok: false, error } when
// neither could read it. Never throws.
export async function readBill(file) {
  let parsed = null
  if (file.type === 'application/pdf') {
    try {
      const res = await parseBillPdf(file)
      if (res?.ok && res.bill) parsed = res.bill
    } catch {
      // The extractor reads it instead.
    }
    if (parsed && !parsed.missing.length) return { ok: true, bill: parsed }
  }
  const read = await extractBill(file)
  if (!read.ok) return parsed ? { ok: true, bill: parsed } : read
  return { ok: true, bill: parsed ? fillMissing(parsed, read.bill) : read.bill }
}
