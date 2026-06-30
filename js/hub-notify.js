// Shared notification primitive. The ONE non-blocking message surface for
// every Hub app, on the same tier as the shared header: an app raises a
// short message by calling notify(), it never hand-writes the markup.
//
//   import { notify } from './hub-notify.js'
//   const handle = notify({
//     tone,       // 'info' | 'success' | 'warn' | 'error'  (default 'info')
//     label,      // optional eyebrow override; defaults per tone
//     message,    // the short line (required)
//     action,     // optional { label, onClick }
//     key,        // optional; same key updates in place, never stacks
//     timeout,    // optional ms; omit = sticky (the default)
//     onDismiss,  // optional; fires only on a USER dismiss (x or Esc)
//   })
//   handle.dismiss()   // programmatic close; does NOT fire onDismiss
//
// Styling lives in css/hub.css (.hub-notify-stack / .hub-note). The module
// reads colour/space/motion from whatever palette the host page defines via
// the shared tokens, so it carries no palette assumptions and is not
// duplicated per app or per page.

const MAX_VISIBLE = 3
const EYEBROW = { info: 'UPDATE', success: 'DONE', warn: 'HEADS UP', error: 'ERROR' }

const reduced = () =>
  window.matchMedia && window.matchMedia('(prefers-reduced-motion:reduce)').matches

let stackEl = null
const byKey = new Map()      // key -> entry, for in-place update / dedupe
const order = []             // entries oldest -> newest (DOM order)

function ensureStack() {
  if (stackEl && document.body.contains(stackEl)) return stackEl
  stackEl = document.createElement('div')
  stackEl.className = 'hub-notify-stack'
  stackEl.setAttribute('role', 'region')
  stackEl.setAttribute('aria-label', 'Notifications')
  document.body.appendChild(stackEl)
  return stackEl
}

function renderInto(entry) {
  const { note, opts } = entry
  const tone = opts.tone || 'info'
  note.dataset.tone = tone
  // Error speaks assertively; everything else politely.
  note.setAttribute('role', tone === 'error' ? 'alert' : 'status')

  const eyebrow = opts.label || EYEBROW[tone] || EYEBROW.info
  note.innerHTML = `
    <span class="hub-note-mark" aria-hidden="true"></span>
    <div class="hub-note-body">
      <p class="hub-note-eyebrow"></p>
      <p class="hub-note-msg"></p>
    </div>
    <button type="button" class="hub-note-x" aria-label="Dismiss notification">&times;</button>`
  note.querySelector('.hub-note-eyebrow').textContent = eyebrow
  note.querySelector('.hub-note-msg').textContent = opts.message || ''

  if (opts.action && opts.action.label) {
    const wrap = document.createElement('div')
    wrap.className = 'hub-note-actions'
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'btn'
    btn.textContent = opts.action.label
    btn.addEventListener('click', () => {
      try { opts.action.onClick && opts.action.onClick() } catch (e) { console.warn(e) }
    })
    wrap.appendChild(btn)
    note.querySelector('.hub-note-body').appendChild(wrap)
  }

  note.querySelector('.hub-note-x')
    .addEventListener('click', () => dismiss(entry, true))

  if (opts.timeout > 0) {
    const bar = document.createElement('span')
    bar.className = 'hub-note-timer'
    bar.setAttribute('aria-hidden', 'true')
    bar.style.setProperty('--note-timer', opts.timeout + 'ms')
    note.appendChild(bar)
    clearTimeout(entry.timer)
    entry.timer = setTimeout(() => dismiss(entry, false), opts.timeout)
  }
}

function dismiss(entry, userInitiated) {
  if (entry.leaving) return
  entry.leaving = true
  clearTimeout(entry.timer)
  if (userInitiated && typeof entry.opts.onDismiss === 'function') {
    try { entry.opts.onDismiss() } catch (e) { console.warn(e) }
  }
  entry.slot.classList.add('is-leaving')
  entry.note.classList.add('is-leaving')
  const done = () => {
    entry.slot.remove()
    const i = order.indexOf(entry)
    if (i !== -1) order.splice(i, 1)
    if (entry.key && byKey.get(entry.key) === entry) byKey.delete(entry.key)
    if (stackEl && !order.length) { stackEl.remove(); stackEl = null }
  }
  setTimeout(done, reduced() ? 20 : 300)
}

function enforceMax() {
  // Evicting to make room is not a user dismiss: never fires onDismiss.
  // dismiss() removes from `order` asynchronously, so drive this off the
  // live (not-yet-leaving) entries and call each at most once.
  const live = order.filter(e => !e.leaving)
  for (let i = 0; i < live.length - MAX_VISIBLE; i++) dismiss(live[i], false)
}

export function notify(opts = {}) {
  if (opts.key && byKey.has(opts.key)) {
    const entry = byKey.get(opts.key)
    entry.opts = opts
    entry.key = opts.key
    renderInto(entry)            // refresh content in place, no re-stack
    return { dismiss: () => dismiss(entry, false) }
  }

  const slot = document.createElement('div')
  slot.className = 'hub-note-slot'
  const note = document.createElement('div')
  note.className = 'hub-note'
  slot.appendChild(note)

  const entry = { slot, note, opts, key: opts.key || null, timer: 0, leaving: false }
  renderInto(entry)

  note.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); dismiss(entry, true) }
  })

  ensureStack().appendChild(slot)   // newest at the bottom, nearest the anchor
  order.push(entry)
  if (entry.key) byKey.set(entry.key, entry)
  enforceMax()

  // Two frames so the entrance transition runs from the hidden state.
  requestAnimationFrame(() => requestAnimationFrame(() => note.classList.add('is-in')))

  return { dismiss: () => dismiss(entry, false) }
}
