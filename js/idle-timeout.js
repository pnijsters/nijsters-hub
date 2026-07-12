// Idle session timeout. Calls supabase.auth.signOut() after N ms of no user
// activity, then invokes the caller's onTimeout callback so the page can
// respond (redirect to sign-in, hide auth-only UI, etc.).
//
// Tab visibility intentionally doesn't reset the timer — switching away counts
// as idle. Only direct interaction (mouse, key, touch, scroll) keeps the
// session alive.

import { supabase } from './supabase-client.js'

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes
const CHECK_INTERVAL_MS  = 15 * 1000      // check 4× per minute — cheap

const EVENTS = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'wheel']

let lastActivity = Date.now()
let intervalId   = null
let onTimeoutFn  = null
let started      = false

function markActive() {
  lastActivity = Date.now()
}

async function check() {
  if (Date.now() - lastActivity < DEFAULT_TIMEOUT_MS) return
  // Stop first to avoid double-firing during the async signOut
  stop()
  try {
    await supabase.auth.signOut()
  } catch (e) {
    console.warn('idle signOut failed', e)
    // Network revoke failed (e.g. a transient auth error) — force-clear the
    // local session anyway so the redirect still lands logged-out.
    try { await supabase.auth.signOut({ scope: 'local' }) } catch (e2) { console.warn('idle local signOut failed', e2) }
  }
  try { onTimeoutFn?.() } catch (e) { console.warn('onTimeout callback threw', e) }
}

export function startIdleTimeout(onTimeout) {
  if (started) return
  started = true
  onTimeoutFn = onTimeout
  lastActivity = Date.now()
  for (const ev of EVENTS) {
    window.addEventListener(ev, markActive, { passive: true })
  }
  intervalId = setInterval(check, CHECK_INTERVAL_MS)
}

export function stop() {
  if (!started) return
  started = false
  if (intervalId) clearInterval(intervalId)
  intervalId = null
  for (const ev of EVENTS) {
    window.removeEventListener(ev, markActive)
  }
}
