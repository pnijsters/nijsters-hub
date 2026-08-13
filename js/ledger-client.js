// Ledger — the data surface for the Hub's double-entry accounting app.
//
// Mirrors js/fx-client.js: a thin, single-purpose module over the `ledger`
// Postgres schema (2026-06-15c_ledger_module.sql). Structural rows (entities,
// accounts, currencies) are read/written directly through PostgREST with RLS;
// journal entries + postings are written ONLY through the ledger.post_entry
// RPC (the schema grants them no direct INSERT), which enforces the
// double-entry invariants server-side. FX conversion is never duplicated here —
// it rides the shared fx domain via js/fx-client.js / fx.rate_cross.

import { supabase } from './supabase-client.js'

const L = () => supabase.schema('ledger')

// Columns safe to SELECT on account — the encrypted bytea columns are NOT
// granted to the client; account/routing numbers come back only via
// getAccountSecrets() (aal2 + parent).
const ACCOUNT_COLS =
  'id, entity_id, parent_id, name, account_class, subtype, currency_code, ' +
  'institution, account_number_last4, external_url, notes, is_active, created_at'

// ── currencies ─────────────────────────────────────────────────────────────
export async function listCurrencies() {
  const { data, error } = await L().from('currency')
    .select('code, name, minor_unit_scale, is_active')
    .order('code')
  if (error) throw new Error(`listCurrencies failed: ${error.message}`)
  return data || []
}

// ── entities ───────────────────────────────────────────────────────────────
export async function listEntities() {
  const { data, error } = await L().from('entity')
    .select('id, name, type, functional_currency, is_active, created_at')
    .order('name')
  if (error) throw new Error(`listEntities failed: ${error.message}`)
  return data || []
}

export async function upsertEntity(entity) {
  const row = { ...entity }
  Object.keys(row).forEach(k => row[k] === undefined && delete row[k])
  const q = entity.id
    ? L().from('entity').update(row).eq('id', entity.id).select().single()
    : L().from('entity').insert(row).select().single()
  const { data, error } = await q
  if (error) throw new Error(`upsertEntity failed: ${error.message}`)
  return data
}

// ── accounts ───────────────────────────────────────────────────────────────
// Every account for an entity (the chart-of-accounts tree lives in parent_id).
export async function listAccounts(entityId = null) {
  let q = L().from('account').select(ACCOUNT_COLS).order('name')
  if (entityId) q = q.eq('entity_id', entityId)
  const { data, error } = await q
  if (error) throw new Error(`listAccounts failed: ${error.message}`)
  return data || []
}

export async function upsertAccount(account) {
  const row = { ...account }
  // never send ciphertext / secret fields through the table write
  delete row.account_number; delete row.routing_number
  Object.keys(row).forEach(k => row[k] === undefined && delete row[k])
  const q = account.id
    ? L().from('account').update(row).eq('id', account.id).select(ACCOUNT_COLS).single()
    : L().from('account').insert(row).select(ACCOUNT_COLS).single()
  const { data, error } = await q
  if (error) throw new Error(`upsertAccount failed: ${error.message}`)
  return data
}

// Encrypt + store an account's sensitive numbers (aal2 + parent, server-side).
export async function setAccountSecret(accountId, accountNumber, routingNumber) {
  const { error } = await L().rpc('set_account_secret', {
    p_account_id: accountId,
    p_account_number: accountNumber || null,
    p_routing_number: routingNumber || null,
  })
  if (error) throw new Error(`setAccountSecret failed: ${error.message}`)
}

// Decrypt an account's sensitive numbers (aal2 + parent). Returns
// { account_number, routing_number } (either may be null).
export async function getAccountSecrets(accountId) {
  const { data, error } = await L().rpc('account_secrets', { p_account_id: accountId })
  if (error) throw new Error(`getAccountSecrets failed: ${error.message}`)
  return (data && data[0]) || { account_number: null, routing_number: null }
}

// ── journal entries + postings (Activity / General Ledger) ──────────────────
// Recent entries for an entity, each with its postings (+ the account name/class
// for display). Newest first.
export async function listEntries(entityId, { limit = 200 } = {}) {
  const { data, error } = await L().from('journal_entry')
    .select('id, entry_date, description, reference, source, status, group_id, created_at, ' +
            'posting(id, account_id, amount, currency_code, fx_rate_to_functional, memo, ' +
            'account:account_id(name, account_class, subtype))')
    .eq('entity_id', entityId)
    .order('entry_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`listEntries failed: ${error.message}`)
  return (data || []).map(e => {
    const { posting, ...rest } = e
    return { ...rest, postings: posting || [] }
  })
}

// All postings for an entity (flat General-Ledger view), newest first.
// Derived from listEntries so the entity filter + date ordering live on the
// journal_entry header (no fragile embedded-resource filtering).
export async function listPostings(entityId, { limit = 500 } = {}) {
  const entries = await listEntries(entityId, { limit })
  const out = []
  for (const e of entries) {
    for (const p of e.postings) {
      out.push({ ...p, entry: { entry_date: e.entry_date, description: e.description } })
    }
  }
  return out
}

// Post a balanced double-entry transaction through the engine RPC. Raises with
// the engine's message (unbalanced, per-entity closure, currency, etc.) if it
// rejects. Returns the new journal_entry id.
//   entry    = { entity_id, entry_date, description?, reference?, source?, status?, group_id? }
//   postings = [{ account_id, amount, memo?, fx_rate_to_functional? }, ...]
export async function postEntry(entry, postings) {
  const { data, error } = await L().rpc('post_entry', {
    p_entry: entry,
    p_postings: postings,
  })
  if (error) throw new Error(error.message)
  return data
}

// ── trial balance (read-only; for the Trial Balance tab when it lands) ───────
// Per-account net amount (sum of native postings) for an entity. The
// presentation-currency translation is the consumer's job via fx-client.
export async function trialBalance(entityId) {
  const postings = await listPostings(entityId, { limit: 5000 })
  const byAccount = new Map()
  for (const p of postings) {
    const key = p.account?.name || p.account_id
    const cur = byAccount.get(key) || { name: key, currency: p.account?.currency_code, total: 0 }
    cur.total += Number(p.amount)
    byAccount.set(key, cur)
  }
  return [...byAccount.values()]
}
