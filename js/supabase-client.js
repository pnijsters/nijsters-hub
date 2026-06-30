// Initializes the Supabase client from window.NIJSTERS_SUPABASE.
// The config object is written by the deploy workflow into js/supabase-config.js,
// loaded as a regular script tag before this module. No values live in source.

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'

const cfg = window.NIJSTERS_SUPABASE
if (!cfg || !cfg.url || !cfg.anonKey) {
  throw new Error('Supabase config missing: js/supabase-config.js was not loaded')
}

export const supabase = createClient(cfg.url, cfg.anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
})

export async function signInWithPassword(email, password) {
  return supabase.auth.signInWithPassword({ email, password })
}

export async function getAAL() {
  return supabase.auth.mfa.getAuthenticatorAssuranceLevel()
}

export async function listFactors() {
  return supabase.auth.mfa.listFactors()
}

export async function enrollTOTP(friendlyName = 'Nijsters Hub') {
  return supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName })
}

export async function challengeAndVerify(factorId, code) {
  const { data: challenge, error: ce } = await supabase.auth.mfa.challenge({ factorId })
  if (ce) return { data: null, error: ce }
  return supabase.auth.mfa.verify({
    factorId,
    challengeId: challenge.id,
    code,
  })
}

export async function signOut() {
  return supabase.auth.signOut()
}

// ──────────────────────────────────────────────────────────────────────────
// Storage helpers — bucket: family-photos
// Paths: full/{uuid}.webp and thumb/{uuid}.webp (flat namespace per variant)
// ──────────────────────────────────────────────────────────────────────────

const BUCKET = 'family-photos'

export async function uploadPhoto(path, blob) {
  return supabase.storage.from(BUCKET).upload(path, blob, {
    contentType: 'image/webp',
    upsert: false,
    cacheControl: '31536000', // 1 year — UUID paths are immutable
  })
}

export async function removePhoto(paths) {
  return supabase.storage.from(BUCKET).remove(paths)
}

// Clears all downvote rows for a photo (vote = -1). Lets the family
// "rescue" a photo from approaching auto-delete. Requires aal2; the
// SQL function does the actual DELETE with SECURITY DEFINER so it can
// remove other users' downvote rows that RLS would normally protect.
export async function clearDownvotes(photoId) {
  return supabase.rpc('clear_downvotes', { p_photo_id: photoId })
}

// Full photo deletion via the delete_photo SQL function (SECURITY DEFINER,
// aal2-gated). One server-side transaction removes both storage variants
// AND wipes the photo's vote rows. The function also sets the
// storage.allow_delete_query GUC to defeat Supabase's BEFORE DELETE protect
// trigger on storage.objects — without that, supabase.storage.remove() and
// any direct DELETE on storage.objects silently no-op (resolves with
// data: [] and no error). See docs/AGENT.md §6 and mistake #11.
export async function deletePhoto(photoId) {
  const { data: removed, error } = await supabase.rpc('delete_photo', { p_photo_id: photoId })
  if (error) throw new Error(`delete_photo failed: ${error.message}`)
  if (removed < 2) throw new Error(`delete_photo removed ${removed}/2 storage rows`)
  return { removed }
}

export function publicUrl(path) {
  return supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl
}

// Lists files in a variant folder ('full' or 'thumb') and returns rich
// entries { id, url } where id is the UUID portion (same across variants
// for the same photo). Returns null on error so callers can fall back to
// bundled photos during the transition window.
export async function listVariant(variant) {
  try {
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .list(variant, { limit: 1000, sortBy: { column: 'name', order: 'desc' } })
    if (error) throw error
    if (!data || data.length === 0) return []
    return data
      .filter(o => o.name && o.name.endsWith('.webp'))
      .map(o => ({
        id:  o.name.replace(/\.webp$/, ''),
        url: publicUrl(`${variant}/${o.name}`),
      }))
  } catch (e) {
    console.warn(`Supabase listVariant("${variant}") failed`, e)
    return null
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Voting — anonymous visitors can read aggregate scores (used for rotation
// bias); only authenticated aal2 users can read their own votes or cast.
// ──────────────────────────────────────────────────────────────────────────

// Aggregate scores across all photos. Public — RLS via the photo_score view.
// Returns a map keyed by photo_id: { ups, downs, score }. Returns {} on error.
export async function getPhotoScores() {
  const { data, error } = await supabase
    .from('photo_score')
    .select('photo_id, ups, downs, score')
  if (error) { console.warn('getPhotoScores failed', error); return {} }
  return Object.fromEntries(data.map(r => [r.photo_id, r]))
}

// Current user's votes. Returns a map keyed by photo_id: 1 | -1. {} on error
// or when not signed in.
export async function getMyVotes() {
  const { data, error } = await supabase
    .from('photo_votes')
    .select('photo_id, vote')
  if (error) { console.warn('getMyVotes failed', error); return {} }
  return Object.fromEntries(data.map(r => [r.photo_id, r.vote]))
}

// Upsert or delete a vote for the current user.
//   vote === 1   → like
//   vote === -1  → dislike
//   vote === null → remove
export async function castVote(photoId, vote) {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')
  if (vote === null) {
    return supabase.from('photo_votes')
      .delete().eq('photo_id', photoId).eq('user_id', user.id)
  }
  return supabase.from('photo_votes').upsert({
    photo_id: photoId,
    user_id: user.id,
    vote,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'photo_id,user_id' })
}

// Lightweight auth check for the landing page. Returns 'aal2' if the user
// is signed in AND has passed TOTP; 'aal1' if password-only; null if anon
// or on any error.
export async function getCurrentAAL() {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return null
  const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
  if (error || !data) return null
  return data.currentLevel
}

// ──────────────────────────────────────────────────────────────────────────
// RBAC — role is carried in the JWT as the `user_role` claim, populated
// server-side by the custom_access_token_hook. Reading it from the JWT
// avoids a round-trip per page load. Falls back to 'child' (least
// privilege) if the claim is absent (e.g. hook not yet enabled).
// ──────────────────────────────────────────────────────────────────────────

const ROLE_RANK = { child: 0, parent: 1, admin: 2 }

function decodeJwtPayload(token) {
  try {
    const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    return JSON.parse(atob(padded))
  } catch { return null }
}

// Returns 'admin' | 'parent' | 'child' | null. Null = not signed in.
export async function getCurrentRole() {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) return null
  const payload = decodeJwtPayload(session.access_token)
  return payload?.user_role || 'child'
}

// True if the current user's role is at least `min` (admin>parent>child).
export async function hasMinRole(min) {
  const role = await getCurrentRole()
  if (!role) return false
  return ROLE_RANK[role] >= ROLE_RANK[min]
}

// Admin: list family members + their roles.
export async function listMembers() {
  const { data, error } = await supabase.rpc('list_members')
  if (error) throw new Error(`list_members failed: ${error.message}`)
  return data
}

// Admin: assign a role to a user. Role is 'child' | 'parent' | 'admin'.
// The new role takes effect on that user's NEXT token refresh — typically
// when they next sign in, or within the autorefresh window.
export async function setUserRole(userId, role) {
  const { error } = await supabase.rpc('set_user_role', { p_user_id: userId, p_role: role })
  if (error) throw new Error(`set_user_role failed: ${error.message}`)
}

// ──────────────────────────────────────────────────────────────────────────
// Utilities — gas, water, electric bills + outdoor avg temperature.
// Reads open to any authenticated user; writes gated on aal2 + parent role
// at the RLS layer.
// ──────────────────────────────────────────────────────────────────────────

// Returns every bill, oldest first, lightweight projection for charts.
export async function listBills() {
  const { data, error } = await supabase
    .from('utility_bills')
    .select('id, meter, period_start, period_end, usage, invoice, water_amt, sewer_amt, city_amt, fire_amt, statement_mime, wx_deg_f, wx_hdd, wx_cdd, wx_precip_in')
    .order('period_end', { ascending: true })
  if (error) throw new Error(`listBills failed: ${error.message}`)
  return data
}

// Returns monthly outdoor weather keyed 'YYYY-MM':
//   { deg_f, hdd, cdd, precip }  (degree-days base 65°F, precip inches)
// Any field may be null for an older row not yet refreshed.
export async function listTemps() {
  const { data, error } = await supabase
    .from('monthly_avg_temp')
    .select('year, month, deg_f, hdd, cdd, precip_in')
  if (error) { console.warn('listTemps failed', error); return {} }
  const num = v => (v == null ? null : Number(v))
  return Object.fromEntries(
    data.map(r => [`${r.year}-${String(r.month).padStart(2,'0')}`, {
      deg_f:  num(r.deg_f),
      hdd:    num(r.hdd),
      cdd:    num(r.cdd),
      precip: num(r.precip_in),
    }])
  )
}

// Insert or update a bill. `bill` shape:
//   { id?, meter, period_start, period_end, usage, invoice,
//     water_amt?, sewer_amt?, city_amt?, fire_amt? }
// Returns the persisted row.
export async function upsertBill(bill) {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')
  const row = { ...bill, created_by: bill.id ? undefined : user.id }
  Object.keys(row).forEach(k => row[k] === undefined && delete row[k])
  const q = bill.id
    ? supabase.from('utility_bills').update(row).eq('id', bill.id).select().single()
    : supabase.from('utility_bills').insert(row).select().single()
  const { data, error } = await q
  if (error) throw new Error(`upsertBill failed: ${error.message}`)
  return data
}

export async function deleteBill(id) {
  const { error } = await supabase.from('utility_bills').delete().eq('id', id)
  if (error) throw new Error(`deleteBill failed: ${error.message}`)
}

// ──────────────────────────────────────────────────────────────────────────
// Bill statements — the source document (PDF/photo) for a bill, stored in
// Cloudflare R2 at statements/{bill_id}. The static site can't hold R2
// credentials, so the `statement-url` Edge Function mints short-lived
// presigned URLs. functions.invoke attaches the user's JWT automatically;
// the function re-enforces aal2 + parent/admin for uploads.
// ──────────────────────────────────────────────────────────────────────────

// Presigned GET for an existing statement. Returns { url, mime }. Only call
// when the bill is known to have one (statement_mime set / mark shown).
export async function getStatementUrl(billId) {
  const { data, error } = await supabase.functions.invoke('statement-url', {
    body: { bill_id: billId, op: 'get' },
  })
  if (error) throw new Error(`Couldn't open the statement: ${error.message}`)
  return data // { url, mime }
}

// Presigned PUT for attaching/replacing a statement. aal2 + parent/admin,
// enforced server-side. Returns { url, mime }.
export async function getStatementUploadUrl(billId, contentType) {
  const { data, error } = await supabase.functions.invoke('statement-url', {
    body: { bill_id: billId, op: 'put', content_type: contentType },
  })
  if (error) throw new Error(`Couldn't start the upload: ${error.message}`)
  return data // { url, mime, filename }
}

// PUT the file straight to R2 via the presigned URL. XHR (not fetch) so the
// drawer can show real upload progress. onProgress receives 0..1.
export function uploadStatement(putUrl, file, contentType, onProgress, metaFilename) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', putUrl)
    xhr.setRequestHeader('Content-Type', contentType)
    // Must match the x-amz-meta-filename the Edge Function signed, or R2
    // rejects the signature. Stored as the object's custom metadata.
    if (metaFilename) xhr.setRequestHeader('x-amz-meta-filename', metaFilename)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total)
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve()
      else reject(new Error(`Upload failed (${xhr.status})`))
    }
    xhr.onerror = () => reject(new Error('Upload failed: network error'))
    xhr.send(file)
  })
}

// Reads a utility-bill PDF without storing anything: the file goes to the
// stateless parse-utility-bill Edge Function (aal2 + parent/admin), which
// returns { ok, bill?, provider?, error? }. The drawer pre-fills its review
// form from this, then persists via upsertBill + the statement-upload path.
export async function parseBillPdf(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('Could not read the file'))
    r.readAsDataURL(file)
  })
  const { data, error } = await supabase.functions.invoke('parse-utility-bill', {
    body: { pdf_base64: dataUrl },
  })
  if (error) throw new Error(`Couldn't read the bill: ${error.message}`)
  return data // { ok, bill?, provider?, error? }
}

// Records that a statement now exists for a bill. This is the RLS-gated
// write (aal2 + parent/admin); Postgres re-checks it independently of the
// Edge Function. Call only after a successful uploadStatement().
export async function setBillStatementMime(billId, mime) {
  const { error } = await supabase
    .from('utility_bills')
    .update({ statement_mime: mime })
    .eq('id', billId)
  if (error) throw new Error(`Couldn't record the statement: ${error.message}`)
}

// ──────────────────────────────────────────────────────────────────────────
// Mortgage — one loan, its monthly statement snapshots, the per-statement
// transaction lines, and modeling scenarios. Reads open to any authenticated
// user; writes gated aal2 + parent at the RLS layer. Statement PDFs live in
// R2 at statements/{mortgage_statement_id} via the shared statement-url broker
// (table: 'mortgage_statements').
// ──────────────────────────────────────────────────────────────────────────

// The single loan row (terms). Returns null if not seeded yet.
export async function getMortgageLoan() {
  const { data, error } = await supabase
    .from('mortgage_loans')
    .select('*')
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`getMortgageLoan failed: ${error.message}`)
  return data
}

// Every statement for a loan, oldest first, each with its transaction lines.
export async function listStatements(loanId) {
  const { data, error } = await supabase
    .from('mortgage_statements')
    .select('*, mortgage_transactions(*)')
    .eq('loan_id', loanId)
    .order('statement_date', { ascending: true })
  if (error) throw new Error(`listStatements failed: ${error.message}`)
  // Normalise the joined relation to a sorted `transactions` array.
  return (data || []).map(s => {
    const { mortgage_transactions, ...rest } = s
    const transactions = (mortgage_transactions || []).slice().sort((a, b) => a.seq - b.seq)
    return { ...rest, transactions }
  })
}

// Insert or update a statement AND replace its transaction children in one
// call. `statement` carries scalar fields + a `transactions` array. Returns
// the persisted statement row. The unique (loan_id, statement_date) key makes
// re-importing the same statement (or a reissue) an idempotent upsert.
export async function upsertStatement(statement) {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')
  const { transactions = [], ...fields } = statement
  const row = { ...fields, created_by: fields.id ? undefined : user.id }
  Object.keys(row).forEach(k => row[k] === undefined && delete row[k])

  const saved = fields.id
    ? (await supabase.from('mortgage_statements').update(row).eq('id', fields.id).select().single())
    : (await supabase.from('mortgage_statements')
        .upsert(row, { onConflict: 'loan_id,statement_date' }).select().single())
  if (saved.error) throw new Error(`upsertStatement failed: ${saved.error.message}`)
  const stmt = saved.data

  // Replace children: delete-by-statement_id then insert the parsed lines.
  const del = await supabase.from('mortgage_transactions').delete().eq('statement_id', stmt.id)
  if (del.error) throw new Error(`replace transactions failed: ${del.error.message}`)
  if (transactions.length) {
    const rows = transactions.map((t, i) => ({
      statement_id: stmt.id,
      txn_date: t.txn_date,
      description: t.description,
      kind: t.kind,
      total: t.total, principal: t.principal, interest: t.interest,
      escrow: t.escrow, fees: t.fees, unapplied: t.unapplied,
      seq: t.seq ?? i,
      created_by: user.id,
    }))
    const ins = await supabase.from('mortgage_transactions').insert(rows)
    if (ins.error) throw new Error(`insert transactions failed: ${ins.error.message}`)
  }
  return stmt
}

export async function deleteStatement(id) {
  const { error } = await supabase.from('mortgage_statements').delete().eq('id', id)
  if (error) throw new Error(`deleteStatement failed: ${error.message}`)
}

// Modeling scenarios (extra-payment rule sets).
export async function listScenarios(loanId) {
  const { data, error } = await supabase
    .from('mortgage_scenarios')
    .select('*')
    .eq('loan_id', loanId)
    .order('created_at', { ascending: true })
  if (error) throw new Error(`listScenarios failed: ${error.message}`)
  return data || []
}

export async function upsertScenario(scenario) {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')
  const row = { ...scenario, created_by: scenario.id ? undefined : user.id }
  Object.keys(row).forEach(k => row[k] === undefined && delete row[k])
  const q = scenario.id
    ? supabase.from('mortgage_scenarios').update(row).eq('id', scenario.id).select().single()
    : supabase.from('mortgage_scenarios').insert(row).select().single()
  const { data, error } = await q
  if (error) throw new Error(`upsertScenario failed: ${error.message}`)
  return data
}

export async function deleteScenario(id) {
  const { error } = await supabase.from('mortgage_scenarios').delete().eq('id', id)
  if (error) throw new Error(`deleteScenario failed: ${error.message}`)
}

// Reads a Chase mortgage statement PDF without storing anything: the file goes
// to the stateless parse-mortgage-statement Edge Function (aal2 + parent), which
// returns { ok, statement?, error? }. The drawer/importer pre-fill from this.
export async function parseMortgagePdf(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('Could not read the file'))
    r.readAsDataURL(file)
  })
  const { data, error } = await supabase.functions.invoke('parse-mortgage-statement', {
    body: { pdf_base64: dataUrl },
  })
  if (error) throw new Error(`Couldn't read the statement: ${error.message}`)
  return data // { ok, statement?, error? }
}

// Presigned GET / PUT for a mortgage statement's PDF in R2. Thin wrappers over
// the shared broker with table='mortgage_statements'.
export async function getMortgageStatementUrl(statementId) {
  const { data, error } = await supabase.functions.invoke('statement-url', {
    body: { bill_id: statementId, op: 'get', table: 'mortgage_statements' },
  })
  if (error) throw new Error(`Couldn't open the statement: ${error.message}`)
  return data // { url, mime }
}

export async function getMortgageStatementUploadUrl(statementId, contentType) {
  const { data, error } = await supabase.functions.invoke('statement-url', {
    body: { bill_id: statementId, op: 'put', content_type: contentType, table: 'mortgage_statements' },
  })
  if (error) throw new Error(`Couldn't start the upload: ${error.message}`)
  return data // { url, mime, filename }
}

export async function setStatementMime(statementId, mime) {
  const { error } = await supabase
    .from('mortgage_statements')
    .update({ statement_mime: mime })
    .eq('id', statementId)
  if (error) throw new Error(`Couldn't record the statement: ${error.message}`)
}
