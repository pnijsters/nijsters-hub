/* ============================================================================
   Shared inline auth gate — the ONE sign-in / MFA / TOTP-enroll flow for the
   whole Hub. Every app calls ensureAuth() before it renders; if the visitor
   is not authenticated at aal2, this mounts a full-bleed overlay ON THE APP'S
   OWN PAGE (no redirect, no separate hub page) and drives the flow to
   completion, then resolves. It replaces the old hub.html launcher entirely.

   The overlay reuses the Flow archetype (.flow-col + .field + .btn from
   css/hub.css) so it reads as a quiet extension of the page, not a modal.

     ensureAuth() -> Promise<true>
       Resolves once the visitor is authenticated at aal2. If already there,
       resolves immediately with no overlay. Otherwise it shows the gate and
       resolves only after a successful sign-in + TOTP verification, so a
       caller can `await ensureAuth()` and then render with confidence.

   Sign-out and idle-timeout re-lock by reloading the page (a fresh
   ensureAuth() then shows the gate) — see the callers.
   ========================================================================= */

import {
  supabase, signInWithPassword, getAAL, listFactors,
  challengeAndVerify, enrollTOTP,
} from './supabase-client.js'

async function isAal2() {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return false
  const { data: aal } = await getAAL()
  return !!aal && aal.currentLevel === 'aal2'
}

export async function ensureAuth() {
  if (await isAal2()) return true
  return runGate()
}

const STATES = ['loading', 'signin', 'challenge', 'enroll']
const FOCUS_BY_STATE = { signin: 'ag-signin-email', challenge: 'ag-challenge-code', enroll: 'ag-enroll-code' }

function runGate() {
  return new Promise((resolve) => {
    const gate = document.createElement('div')
    gate.className = 'auth-gate'
    gate.id = 'authGate'
    gate.setAttribute('role', 'dialog')
    gate.setAttribute('aria-modal', 'true')
    gate.setAttribute('aria-label', 'Sign in to the Family Hub')
    gate.innerHTML = `
      <a class="auth-mark" href="index.html" aria-label="Nijsters home">Nijsters</a>
      <div class="auth-flow">
        <section class="flow-col" data-ag="loading">
          <p class="eyebrow">Checking session&hellip;</p>
        </section>

        <section class="flow-col" data-ag="signin" hidden>
          <p class="eyebrow">Family Hub</p>
          <h1>Welcome <span class="it">back.</span></h1>
          <p class="lede">Private space for the Nijsters. Sign in to continue.</p>
          <form class="stack" data-ag-form="signin" novalidate>
            <div class="field">
              <label for="ag-signin-email">Email</label>
              <input type="email" id="ag-signin-email" name="email" autocomplete="username" required>
            </div>
            <div class="field">
              <label for="ag-signin-password">Password</label>
              <input type="password" id="ag-signin-password" name="password" autocomplete="current-password" required>
            </div>
            <div class="form-error" data-ag-error="signin" hidden></div>
            <button type="submit" class="btn btn--primary" data-ag-submit="signin">Continue</button>
          </form>
        </section>

        <section class="flow-col" data-ag="challenge" hidden>
          <p class="eyebrow">Two-step verification</p>
          <h1>One <span class="it">more step.</span></h1>
          <p class="lede">Enter the six-digit code from your authenticator app.</p>
          <form class="stack" data-ag-form="challenge" novalidate>
            <div class="field">
              <label for="ag-challenge-code">Code</label>
              <input type="text" id="ag-challenge-code" name="otp" inputmode="numeric"
                     autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required>
            </div>
            <div class="form-error" data-ag-error="challenge" hidden></div>
            <button type="submit" class="btn btn--primary" data-ag-submit="challenge">Verify</button>
          </form>
        </section>

        <section class="flow-col" data-ag="enroll" hidden>
          <p class="eyebrow">Enroll authenticator</p>
          <h1>A <span class="it">one-time</span> setup.</h1>
          <p class="lede">Scan this QR with 1Password, Google Authenticator, Authy, or any TOTP app. Then enter the first code it shows you.</p>
          <div class="qr-panel">
            <img data-ag-qr alt="TOTP enrollment QR code">
            <div class="note">Can't scan? Enter this secret manually:</div>
            <div class="mono-secret" data-ag-secret></div>
          </div>
          <form class="stack" data-ag-form="enroll" novalidate>
            <div class="field">
              <label for="ag-enroll-code">First code</label>
              <input type="text" id="ag-enroll-code" name="otp" inputmode="numeric"
                     autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required>
            </div>
            <div class="form-error" data-ag-error="enroll" hidden></div>
            <button type="submit" class="btn btn--primary" data-ag-submit="enroll">Confirm and enroll</button>
          </form>
        </section>
      </div>`
    document.body.appendChild(gate)
    // Fade the gate in on the next frame so the reveal animates from the
    // initial (opacity 0) state.
    requestAnimationFrame(() => gate.classList.add('is-in'))

    const q = (sel) => gate.querySelector(sel)
    let pendingFactorId = null

    function go(state) {
      for (const s of STATES) {
        const sec = q(`[data-ag="${s}"]`)
        sec.hidden = s !== state
      }
      const id = FOCUS_BY_STATE[state]
      if (id) requestAnimationFrame(() => q(`#${id}`)?.focus())
    }
    function showError(which, msg) {
      const el = q(`[data-ag-error="${which}"]`)
      el.textContent = msg; el.hidden = false
    }
    function clearError(which) { q(`[data-ag-error="${which}"]`).hidden = true }

    async function route() {
      go('loading')
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { go('signin'); return }
      const { data: aal } = await getAAL()
      if (!aal) { go('signin'); return }
      if (aal.currentLevel === aal.nextLevel) {
        // No MFA step pending. Either signed in at aal2 (done) or aal1 with no
        // factor -> enroll.
        if (aal.currentLevel === 'aal2') { finish() } else { await startEnroll() }
        return
      }
      // currentLevel < nextLevel -> step up via TOTP
      const { data: factors } = await listFactors()
      const verified = factors?.totp?.find(f => f.status === 'verified')
      if (verified) { pendingFactorId = verified.id; go('challenge') }
      else { await startEnroll() }
    }

    async function startEnroll() {
      go('enroll')
      const { data, error } = await enrollTOTP()
      if (error) { showError('enroll', error.message); return }
      pendingFactorId = data.id
      q('[data-ag-qr]').src = data.totp.qr_code
      q('[data-ag-secret]').textContent = data.totp.secret
    }

    function finish() {
      gate.classList.remove('is-in')
      const done = () => { gate.remove(); resolve(true) }
      // Let the fade-out play; fall back if transitionend never fires.
      const t = setTimeout(done, 320)
      gate.addEventListener('transitionend', () => { clearTimeout(t); done() }, { once: true })
    }

    q('[data-ag-form="signin"]').addEventListener('submit', async (e) => {
      e.preventDefault(); clearError('signin')
      const btn = q('[data-ag-submit="signin"]')
      btn.disabled = true; btn.textContent = 'Signing in…'
      const email = q('#ag-signin-email').value.trim()
      const password = q('#ag-signin-password').value
      const { error } = await signInWithPassword(email, password)
      btn.disabled = false; btn.textContent = 'Continue'
      if (error) { showError('signin', error.message); return }
      await route()
    })

    q('[data-ag-form="challenge"]').addEventListener('submit', async (e) => {
      e.preventDefault(); clearError('challenge')
      const btn = q('[data-ag-submit="challenge"]')
      btn.disabled = true; btn.textContent = 'Verifying…'
      const { error } = await challengeAndVerify(pendingFactorId, q('#ag-challenge-code').value)
      btn.disabled = false; btn.textContent = 'Verify'
      if (error) { showError('challenge', error.message); return }
      await route()
    })

    q('[data-ag-form="enroll"]').addEventListener('submit', async (e) => {
      e.preventDefault(); clearError('enroll')
      const btn = q('[data-ag-submit="enroll"]')
      btn.disabled = true; btn.textContent = 'Confirming…'
      const { error } = await challengeAndVerify(pendingFactorId, q('#ag-enroll-code').value)
      btn.disabled = false; btn.textContent = 'Confirm and enroll'
      if (error) { showError('enroll', error.message); return }
      await route()
    })

    route()
  })
}
