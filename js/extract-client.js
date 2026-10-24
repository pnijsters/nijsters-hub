// extract-document through supabase-js, for doc-extract.js's extractAll().
//
// Shared by every page that reads documents (Medical, Airbnb); the profile
// each one names decides what is read.

import { supabase } from './supabase-client.js'

// extract-document → { status, body }, reading a non-2xx answer's JSON
// body. A network failure is status 0.
export async function invokeExtract(body) {
  const { data, error } = await supabase.functions.invoke('extract-document', { body })
  if (!error) return { status: 200, body: data }
  const res = error.context
  const json = res && typeof res.json === 'function' ? await res.json().catch(() => null) : null
  return { status: typeof res?.status === 'number' ? res.status : 0, body: json || { error: error.message } }
}
