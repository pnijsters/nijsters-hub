// Medical receipts — the data surface for medical.html.
//
// A thin module over the `medical` schema (2026-10-03b_medical_receipts.sql,
// 2026-10-04_medical_extraction.sql, 2026-10-05_medical_duplicates.sql),
// the medical-doc-url Edge Function,
// which signs every R2 request for the scans, and extract-document, which
// reads them. The rules a row must meet live in js/medical-model.js (for
// the drawer) and in Postgres (the authority). RLS and the RPCs' gate limit
// every call to an aal2 parent or admin. Expenses and documents are created
// and deleted only through the RPCs; the broker deletes a deleted
// document's files.

import { supabase } from './supabase-client.js'
import { sniffMime, sha256Hex, alreadyOf, contextFor } from './medical-model.js'
import { extractAll, toBase64 } from './doc-extract.js'
import { invokeExtract } from './extract-client.js'
import { normalizeImage, forReading } from './normalize-image.js'

const M = () => supabase.schema('medical')

const EXPENSE_COLS =
  'id, patient_id, provider, service_date, category, amount_paid, paid_with_hsa_card, ' +
  'reimbursement_status, date_submitted, amount_reimbursed, notes, created_at, updated_at'
const DOCUMENT_COLS =
  'id, expense_id, seq, original_filename, mime, byte_size, sha256, uploaded_at, file_name, readable_sha256, ' +
  'no_payment_found'
const INBOX_COLS =
  'id, original_filename, mime, byte_size, sha256, uploaded_at, created_at, calls, drafts, open_drafts, state, no_payment, ' +
  'readable_sha256, profile_version, reread_refused'
const DRAFT_COLS = 'id, document_id, extraction_id, ordinal, extracted, expense_id'

// An RPC; a refusal becomes an Error carrying the SQLSTATE as .code
// ('MD001': stale, re-list and try again) and its detail as .detail. The
// code is always a string ('' when the answer had none, e.g. a gateway's
// error page), so the page can tell an RPC or network failure from a file
// refused here.
async function rpc(fn, args) {
  const { data, error } = await M().rpc(fn, args)
  if (error) throw Object.assign(new Error(error.message), { code: String(error.code ?? ''), detail: error.details ?? '' })
  return data
}

// PostgREST caps a response at max_rows. Read page after page until the
// exact count is reached, so a table that outgrows the cap is never cut
// short (the unreimbursed total would quietly be wrong).
const PAGE = 1000
async function selectAll(query) {
  const rows = []
  for (;;) {
    const { data, error, count } = await query().range(rows.length, rows.length + PAGE - 1)
    if (error) throw error
    rows.push(...data)
    if (!data.length || rows.length >= count) return rows
  }
}

// ── patients ──────────────────────────────────────────────────────────────

export async function listPatients() {
  const { data, error } = await M().from('patient')
    .select('id, first_name, last_name, user_id, also_printed_as')
    .order('first_name')
  if (error) throw new Error(`listPatients failed: ${error.message}`)
  return data || []
}

// ── expenses ──────────────────────────────────────────────────────────────

// Every expense, newest service first, each with
// `documents`: its documents, in upload order, carrying
// the descriptive file_name from medical.document_file (one row per link)
// and `shared`: how many other listed expenses the document is on too;
// `cards`: the card last4s read from its drafts (saved or merged), so a
// merge can tell whether its documents printed a card; `slips`: how many
// of those drafts printed no patient (card slips already on it);
// `items`: what those drafts say each visit was for; and `printed_as`: the
// provider names they read.
export async function listExpenses() {
  try {
    const [expenses, documents, read] = await Promise.all([
      selectAll(() => M().from('expense').select(EXPENSE_COLS, { count: 'exact' })
        .order('service_date', { ascending: false })
        .order('created_at', { ascending: false })
        .order('id')),
      selectAll(() => M().from('document_file').select(DOCUMENT_COLS, { count: 'exact' })
        .order('expense_id')
        .order('seq')),
      selectAll(() => M().from('draft')
        .select('id, expense_id, card:extracted->fields->payment_card_last4->>value, ' +
                'printed:extracted->fields->patient_name_printed->>value, ' +
                'item:extracted->fields->service_description->>value, ' +
                'provider:extracted->fields->provider->>value', { count: 'exact' })
        .not('expense_id', 'is', null)
        .order('id')),
    ])
    const byExpense = new Map(expenses.map((e) => [e.id, { ...e, documents: [], cards: [], slips: 0, items: [], printed_as: [] }]))
    for (const d of read) {
      const e = byExpense.get(d.expense_id)
      if (!e) continue
      if (d.card != null) e.cards.push(d.card)
      if (d.printed == null) e.slips++
      if (d.item != null) e.items.push(d.item)
      if (d.provider != null) e.printed_as.push(d.provider)
    }
    const live = documents.filter((d) => byExpense.has(d.expense_id))
    const links = new Map()
    for (const d of live) links.set(d.id, (links.get(d.id) || 0) + 1)
    for (const d of live) byExpense.get(d.expense_id).documents.push({ ...d, shared: links.get(d.id) - 1 })
    return [...byExpense.values()]
  } catch (e) {
    throw new Error(`listExpenses failed: ${e.message}`)
  }
}

// `row` comes from expenseRow() in medical-model.js.
export async function updateExpense(id, row) {
  const { data, error } = await M().from('expense').update(row).eq('id', id)
    .select(EXPENSE_COLS).single()
  if (error) throw new Error(`updateExpense failed: ${error.message}`)
  return data
}

// Delete an expense for good (medical.delete_expense): its links, the
// visits read into it and each document that was only there for it. Then
// the broker deletes those documents' files.
export async function deleteExpense(id) {
  await deleteFiles(await rpc('delete_expense', { p_expense_id: id }))
}

// ── to review ─────────────────────────────────────────────────────────────

const listDrafts = (documentIds) => selectAll(() => M().from('draft').select(DRAFT_COLS, { count: 'exact' })
  .in('document_id', documentIds)
  .order('document_id')
  .order('ordinal'))

// The documents still waiting for a decision (medical.inbox_document),
// oldest first (the order they were dropped and are read in), and the
// drafts read from them, by document and ordinal.
// Only documents with drafts are asked about (kept no-payment documents
// stay in the inbox until they are attached), and in chunks, so the URL
// stays short. A kept document carries its no-payment visits (no_payment).
const IDS_PER_GET = 100
export async function listInbox() {
  try {
    const documents = await selectAll(() => M().from('inbox_document').select(INBOX_COLS, { count: 'exact' })
      .order('created_at')
      .order('id'))
    const drafts = await listDraftsOf(documents.filter((d) => d.drafts > 0).map((d) => d.id))
    return { documents, drafts }
  } catch (e) {
    throw new Error(`listInbox failed: ${e.message}`)
  }
}

// The drafts read from documents, by document and ordinal: a saved
// expense's documents too, whose visits the reader marks.
export async function listDraftsOf(documentIds) {
  const drafts = []
  for (let i = 0; i < documentIds.length; i += IDS_PER_GET) drafts.push(...await listDrafts(documentIds.slice(i, i + IDS_PER_GET)))
  return drafts
}

// ── cards ─────────────────────────────────────────────────────────────────

// The cards answered once for every document: Map last4 → is_hsa.
export async function listCards() {
  const { data, error } = await M().from('payment_card').select('last4, is_hsa')
  if (error) throw new Error(`listCards failed: ${error.message}`)
  return new Map(data.map((c) => [c.last4, c.is_hsa]))
}

// Answer for a card, or change the answer (the card exists: 23505).
export async function setCard(last4, isHsa) {
  let { error } = await M().from('payment_card').insert({ last4, is_hsa: isHsa })
  if (error?.code === '23505') {
    ({ error } = await M().from('payment_card').update({ is_hsa: isHsa }).eq('last4', last4))
  }
  if (error) throw new Error(`Couldn't keep the card answer: ${error.message}`)
}

// ── documents ─────────────────────────────────────────────────────────────

// Call the broker about one copy of a document: the original, or a HEIC
// photo's readable copy. A non-2xx answer becomes an Error carrying its
// status and the function's own message.
async function broker(documentId, op, copy = 'original') {
  const { data, error } = await supabase.functions.invoke('medical-doc-url', {
    body: { document_id: documentId, op, copy },
  })
  if (!error) return data
  const res = error.context
  const body = res && typeof res.json === 'function' ? await res.json().catch(() => null) : null
  const err = new Error(body?.error || error.message)
  err.status = res?.status
  throw err
}

// PUT the original bytes to R2 with exactly the headers the broker signed.
// XHR rather than fetch, so the page can show upload progress (0..1).
function putBytes(url, headers, bytes, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v)
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total) }
    xhr.onload = () => resolve(xhr.status)
    xhr.onerror = () => reject(new Error('Upload failed: network error'))
    xhr.send(bytes)
  })
}

// PUT one copy to R2. The broker signs the row's hash into every PUT, so
// R2 only ever holds the exact bytes the row describes. An object already
// at the key (the broker's 409, or R2's 412 when two uploads race) is
// therefore this copy. true once R2 holds it; without bytes only that case
// can be true.
async function putCopy(doc, copy, bytes, onProgress) {
  try {
    const { url, headers } = await broker(doc.id, 'put', copy)
    if (!bytes) return false
    const status = await putBytes(url, headers, bytes, onProgress)
    if (status !== 412 && (status < 200 || status >= 300)) throw new Error(`Upload failed (${status})`)
  } catch (e) {
    if (e.status !== 409) throw e
  }
  return true
}

// Store a document's original in R2, then mark the row uploaded. A HEIC
// photo's readable copy is stored first, so an original in R2 always has
// its copy, and uploaded_at means both are there. Without bytes only
// copies R2 already holds can finish: false means it doesn't hold them
// yet. Progress runs over both PUTs, by their sizes.
export async function storeOriginal(doc, bytes, onProgress) {
  const heif = isHeif(doc.mime)
  const readable = heif && bytes ? await readableOf(doc, bytes) : null
  const share = readable ? readable.length / (readable.length + bytes.length) : 0
  if (heif && !(await putCopy(doc, 'readable', readable, onProgress && ((p) => onProgress(p * share))))) return false
  if (!(await putCopy(doc, 'original', bytes, onProgress && ((p) => onProgress(share + p * (1 - share)))))) return false
  const { error } = await M().from('document')
    .update({ uploaded_at: new Date().toISOString() })
    .eq('id', doc.id).is('uploaded_at', null)
  if (error) throw new Error(`The file is stored, but marking it uploaded failed: ${error.message}`)
  readables.delete(doc.id)
  return true
}

const MB = 1024 * 1024

// A File's bytes. A File only points at the file on disk: once that is
// moved, renamed or deleted, reading it fails, and the Error says so with
// .moved.
async function fileBytes(file) {
  try {
    return new Uint8Array(await file.arrayBuffer())
  } catch (e) {
    if (e?.name !== 'NotFoundError' && e?.name !== 'NotReadableError') throw e
    throw Object.assign(new Error('The file was moved or changed after it was dropped.'), { moved: true })
  }
}

// The bytes of the File a document was created from, checked against the
// row: its size and sha256.
async function bytesOf(doc, file) {
  const bytes = await fileBytes(file)
  if (bytes.length !== Number(doc.byte_size) || await sha256Hex(bytes) !== doc.sha256) {
    throw new Error(`${file.name} isn't the file this document was created from.`)
  }
  return bytes
}

// A file's bytes and type, checked by its first bytes.
async function readFile(file) {
  const bytes = await fileBytes(file)
  if (!bytes.length) throw new Error('The file is empty.')
  const mime = sniffMime(bytes)
  if (!mime) throw new Error("This isn't a PDF, JPEG, PNG or HEIC.")
  return { bytes, mime }
}

// A HEIC or HEIF photo is stored as it was taken, with a readable copy: a
// JPEG at full size, made here when it is dropped, which every browser
// shows and extract-document reads. The copy's hash goes into the row, so
// only those exact bytes can be stored. They are kept here until they are
// stored; made again later (a reload, a retry), they must come out the
// same, which they do in the same browser.
const isHeif = (mime) => mime === 'image/heic' || mime === 'image/heif'
const readables = new Map()   // document id → its readable copy, until stored
// Always made exactly so: a copy made again must match the row's hash.
const makeReadable = async (bytes, mime) => (await normalizeImage(bytes, mime, { quality: 0.92 })).bytes

// A HEIC document's readable copy from its original's bytes: the one kept
// since it was dropped, or made again and checked against the row.
async function readableOf(doc, original) {
  const kept = readables.get(doc.id)
  if (kept) return kept
  const bytes = await makeReadable(original, doc.mime)
  if (await sha256Hex(bytes) !== doc.readable_sha256) {
    throw new Error("This photo's JPEG copy came out different this time. Delete the document and drop the photo again.")
  }
  return bytes
}

// Insert a document row through add_document. With an expense the server
// links it at the next seq. A file
// that is already a document (MD002) is the file's own refusal: an
// Error with no .code, carrying that document's id as .existing. A HEIC
// photo's readable copy is made first: its hash and size go into the row.
async function insertDocument(expenseId, file, bytes, mime) {
  const sha256 = await sha256Hex(bytes)
  const readable = isHeif(mime) ? await makeReadable(bytes, mime) : null
  const copy = { readable_sha256: readable && await sha256Hex(readable), readable_byte_size: readable?.length ?? null }
  let rows
  try {
    rows = await rpc('add_document', {
      p_expense_id: expenseId,
      p_original_filename: file.name,
      p_mime: mime,
      p_byte_size: bytes.length,
      p_sha256: sha256,
      ...(readable && { p_readable_sha256: copy.readable_sha256, p_readable_byte_size: copy.readable_byte_size }),
    })
  } catch (e) {
    if (e.code !== 'MD002') throw e
    throw Object.assign(new Error(e.message), { existing: e.detail || null })
  }
  const [{ id, seq }] = rows
  if (readable) readables.set(id, readable)
  return { id, expense_id: expenseId, seq, original_filename: file.name, mime, byte_size: bytes.length, sha256, ...copy }
}

// A dropped file → { document, readable }: its row, with no expense yet,
// and for a HEIC photo its readable copy, to show it. The original's bytes
// aren't kept: storing and reading read the File again and check it
// against the row. A file over 15 MB, extract-document's cap
// (request.ts), is refused by its size, before it is read into memory, so
// nothing is stored that can't be read; a photo over its 7 MB is made
// smaller when it is read. A refused file throws an Error with a plain
// message and no .code (an RPC failure carries its string .code); a file
// already uploaded also carries the live copy's document id as .existing.
export async function createDocument(file) {
  if (file.size > 15 * MB) throw new Error('This file is over 15 MB. Scan it smaller.')
  const { bytes, mime } = await readFile(file)
  const document = await insertDocument(null, file, bytes, mime)
  return { document, readable: readables.get(document.id) ?? null }
}

// Add files to an expense in the order given, without reading them. Each
// file is checked by its first bytes and hashed, its row is inserted and
// linked, its original goes to R2, and the row is marked uploaded. A
// failing file never stops the others.
// Returns one result per file, { file, document } or { file, error }, the
// latter with `existing` (the live copy's document id) for a file already
// uploaded; a result can carry both when the row exists but the upload
// didn't finish (the reader offers a retry). onProgress(file, 0..1)
// follows each PUT.
export async function addDocuments(expenseId, files, { onProgress } = {}) {
  const results = []
  for (const file of files) {
    let document = null
    try {
      const { bytes, mime } = await readFile(file)
      document = await insertDocument(expenseId, file, bytes, mime)
      await storeOriginal(document, bytes, onProgress && ((p) => onProgress(file, p)))
      results.push({ file, document })
    } catch (e) {
      results.push({ file, document, error: e.message, ...(e.existing !== undefined && { existing: e.existing }) })
    }
  }
  return results
}

// Store a document's original from the File it was created from, read
// again and checked against the row (createDocument() keeps no bytes).
export async function storeFile(doc, file, { onProgress } = {}) {
  return storeOriginal(doc, await bytesOf(doc, file), onProgress)
}

// Finish an incomplete upload. R2 may already hold the original (the PUT
// landed but marking the row didn't), so try without a file first: false
// means the page must ask for the file and call again with it. That file
// must be the same one: its size and hash have to match the row's.
export async function retryUpload(doc, file = null, { onProgress } = {}) {
  return file ? storeFile(doc, file, { onProgress }) : storeOriginal(doc, null, onProgress)
}

// Delete a document for good (medical.delete_document), with its readings,
// then its files.
export async function deleteDocument(id) {
  await deleteFiles(await rpc('delete_document', { p_document_id: id }))
}

// The files of documents whose rows were just deleted: the broker deletes
// each one's original and readable copy. A failure is tried once more; one
// that persists leaves a file in R2 that no row names, and the Error
// (filesLeft) says so.
async function deleteFiles(rows) {
  const failed = []
  for (const { document_id: id } of rows ?? []) {
    try {
      await broker(id, 'delete')
    } catch {
      await new Promise((r) => setTimeout(r, 2000))
      try { await broker(id, 'delete') } catch (e) { failed.push(e.message) }
    }
  }
  if (failed.length) {
    throw Object.assign(new Error(`${failed.length === 1 ? 'its stored file' : `${failed.length} stored files`} couldn't be deleted (${failed[0]})`),
      { filesLeft: true })
  }
}

// A short-lived inline URL for viewing an uploaded document: { url, mime }.
// copy 'readable' is a HEIC photo's JPEG copy: only Safari shows HEIC.
export async function getDocumentUrl(id, copy = 'original') {
  try {
    return await broker(id, 'get', copy)
  } catch (e) {
    throw new Error(`Couldn't open the document: ${e.message}`)
  }
}

// A stored copy, for reading or showing it again: the original, or a HEIC
// photo's readable copy. Refused unless its bytes are the ones the row
// describes.
export async function fetchStored(doc, copy = 'original') {
  if (!doc.uploaded_at) throw new Error("The original isn't stored yet.")
  const readable = copy === 'readable'
  const { url } = await getDocumentUrl(doc.id, copy)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Couldn't fetch the ${readable ? "photo's JPEG copy" : 'original'} (${res.status}).`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  if (await sha256Hex(bytes) !== (readable ? doc.readable_sha256 : doc.sha256)) {
    throw new Error(readable ? "The stored JPEG copy isn't the one made when the photo was dropped."
      : "The stored original isn't the file this document was created from.")
  }
  return bytes
}

// An uploaded document's bytes as a browser shows them, to view them or
// put them in one PDF with others: { bytes, mime }, the original, or a
// HEIC photo's JPEG copy.
export async function viewableBytes(doc) {
  return isHeif(doc.mime) ? { bytes: await fetchStored(doc, 'readable'), mime: 'image/jpeg' }
    : { bytes: await fetchStored(doc), mime: doc.mime }
}

// ── reading ───────────────────────────────────────────────────────────────

// The original to read: the dropped File, checked against the row, or,
// without it (after a reload) or once it was moved but its original is
// stored, the stored original from R2.
async function originalBytes(doc, file) {
  if (!file) return fetchStored(doc)
  try {
    return await bytesOf(doc, file)
  } catch (e) {
    if (e.moved && doc.uploaded_at) return fetchStored(doc)
    throw e
  }
}

// A HEIC photo's readable copy to read: the one kept since it was dropped,
// or made again from the dropped File, or the stored one from R2, the same
// way as the original.
async function readableBytes(doc, file) {
  const kept = readables.get(doc.id)
  if (kept) return kept
  if (!file) return fetchStored(doc, 'readable')
  try {
    return await readableOf(doc, await bytesOf(doc, file))
  } catch (e) {
    if (e.moved && doc.uploaded_at) return fetchStored(doc, 'readable')
    throw e
  }
}

// What extract-document reads for a document: { bytes, mime }. A PDF as
// it is; a photo, or a HEIC photo's readable copy, through forReading().
async function toRead(doc, file) {
  if (doc.mime === 'application/pdf') return { bytes: await originalBytes(doc, file), mime: doc.mime }
  const heif = isHeif(doc.mime)
  const bytes = heif ? await readableBytes(doc, file) : await originalBytes(doc, file)
  return forReading(bytes, heif ? 'image/jpeg' : doc.mime)
}

// Read a document, or continue a reading that stopped. `file` is the File
// the document was created from, when this tab still holds it. `drafts`
// are the document's drafts so far; each successful call is kept with
// record_reading before the next starts, and onDrafts(drafts) gets the
// growing list. Throws before any call when the file or the stored
// original doesn't match the row. Returns extractAll()'s result plus
// `drafts`.
export async function readDocument(doc, { file = null, patients, drafts = [], onDrafts, maxCalls } = {}) {
  const { bytes, mime } = await toRead(doc, file)
  const data = toBase64(bytes)
  const context = contextFor(patients)
  let all = [...drafts]
  const onPart = async (body) => {
    let rows
    try {
      rows = await rpc('record_reading', { p_document_id: doc.id, p_after: all.length, p_result: body })
    } catch (e) {
      // Another tab kept a call first: re-list, then continue or stop.
      if (e.code === 'MD001') e.stale = true
      throw e
    }
    all = [...all, ...rows].sort((a, b) => a.ordinal - b.ordinal)
    onDrafts?.(all)
    return body.complete ? null : alreadyOf(all)
  }
  for (;;) {
    const result = await extractAll({
      invoke: invokeExtract, profile: 'medical_receipt', data, mime, context,
      already: alreadyOf(all), onPart, maxCalls,
    })
    if (!result.stale) return { ...result, drafts: all }
    let fresh, done
    try {
      const [rows, ext] = await Promise.all([
        listDrafts([doc.id]),
        M().from('extraction').select('id').eq('document_id', doc.id).eq('complete', true).limit(1),
      ])
      if (ext.error) throw ext.error
      fresh = rows
      done = ext.data.length > 0
    } catch (e) {
      return { ok: false, error: e.message, retryable: true, stage: 'record', drafts: all }
    }
    // Stale with nothing new kept elsewhere would only pay for the same
    // call again.
    const moved = fresh.length > all.length
    all = fresh
    onDrafts?.(all)
    if (done) return { ok: true, complete: true, drafts: all }
    if (!moved) return { ok: false, error: result.error, retryable: false, stage: 'record', drafts: all }
  }
}

// Read a kept document again, from its original in R2, for what a reader
// of version `since` or newer finds on its visits with no payment (each
// claim's patient share). One call, kept with read_again, which supersedes
// the document's reading. An answer that finds a payment, or fewer visits
// than the reading it would replace (cut short), isn't kept, nor is one that
// read_again refuses: the document stays as it was, the result says why
// with `refused`, and refuse_read_again records it, so the document isn't
// offered to this reader again. An answer from an older reader (the
// function not redeployed yet) isn't kept either, and stops the line like a
// failure to keep what was read. Returns extractAll()'s result otherwise.
export async function readAgain(doc, { patients, since }) {
  const { bytes, mime } = await toRead(doc, null)
  let refused = null
  const result = await extractAll({
    invoke: invokeExtract, profile: 'medical_receipt', data: toBase64(bytes), mime,
    context: contextFor(patients), maxCalls: 1,
    onPart: async (body) => {
      if (!(body.profile_version >= since)) throw new Error('The reader is still being updated. Read kept again in a minute.')
      if (!body.complete || body.expenses.length) refused = 'Read again, it shows a payment. It stays as it was.'
      else if (body.no_payment.length < (doc.no_payment?.length ?? 0)) refused = 'Read again, it found fewer visits than before. It stays as it was.'
      else {
        try {
          await rpc('read_again', { p_document_id: doc.id, p_result: body })
        } catch (e) {
          // The document's own refusal (deleted in another tab, too many visits); anything else stops the line.
          if (e.code !== 'P0001' && e.code !== '23514') throw e
          refused = `Couldn't keep the new reading: ${e.message}`
        }
      }
      if (refused) {
        // Unrecorded (deleted meanwhile, the connection), the document is only
        // offered again after a reload.
        try { await rpc('refuse_read_again', { p_document_id: doc.id, p_profile_version: body.profile_version, p_reason: refused }) } catch { /* see above */ }
      }
      return null
    },
  })
  return refused ? { ok: false, refused: true, retryable: false, error: refused } : result
}

// Save a read document: `items` from saveItems() in medical-model.js, each
// visit saved as a new expense, merged into a saved one, or discarded.
// One transaction: all or nothing. Returns [{ draft_id, expense_id }] for
// the saved and the merged visits, in document order.
export async function saveDocument(documentId, items) {
  return rpc('save_document', { p_document_id: documentId, p_items: items })
}

// Attach a kept document (read in full, nothing paid: an EOB) to saved
// expenses, each at its next seq; all or nothing. It then leaves the
// inbox. Returns [{ expense_id, seq }].
export async function attachDocument(documentId, expenseIds) {
  return rpc('attach_document', { p_document_id: documentId, p_expense_ids: expenseIds })
}
