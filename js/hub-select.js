/* ============================================================================
   Hub Select — the shared custom dropdown for the whole Hub.

   Replaces the native <select> popup (the OS-native list that ignores the
   theme) with a styled, accessible listbox that matches the Hub chrome. It is
   PROGRESSIVE ENHANCEMENT, not a rewrite: the real <select> stays in the DOM as
   the source of truth, so `.value`, form submission, and any existing
   `change` listeners keep working untouched. Selecting an option writes the
   native select and dispatches a bubbling `change`, exactly as the OS control
   would.

   Interaction + motion mirror the actions popover in js/hub-header.js
   (hairline menu on --surface, opacity + translateY reveal on --dur-mid /
   --ease-out, chevron rotate). Keyboard + SR: the trigger is a button
   (aria-haspopup=listbox, aria-expanded); the menu is role=listbox with
   role=option children; arrow / Home / End / type-ahead / Enter / Esc all work,
   with aria-activedescendant tracking the highlighted option.

     enhanceSelect(selectEl)   -> controller; idempotent (returns the existing
                                  one if already enhanced). Also stored at
                                  selectEl._hubSelect.
     enhanceWithin(root=document) enhances every <select> under root that is not
                                  opted out with [data-no-enhance].

   controller = { el, refresh(), open(), close(), destroy() }
   Call refresh() after setting selectEl.value programmatically WITHOUT
   replacing its <option>s; replacing innerHTML is picked up automatically.
   ========================================================================== */

let uid = 0

export function enhanceSelect(select) {
  if (!select || select.tagName !== 'SELECT') return null
  if (select._hubSelect) return select._hubSelect

  const id = `hs${++uid}`
  const labelText =
    select.getAttribute('aria-label') ||
    (select.id && document.querySelector(`label[for="${select.id}"]`)?.textContent?.trim()) ||
    ''

  const wrap = document.createElement('div')
  wrap.className = 'hub-select'
  wrap.dataset.open = 'false'
  select.parentNode.insertBefore(wrap, select)
  wrap.appendChild(select)
  select.classList.add('hub-select__native')
  select.tabIndex = -1
  select.setAttribute('aria-hidden', 'true')

  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'hub-select__btn'
  btn.setAttribute('aria-haspopup', 'listbox')
  btn.setAttribute('aria-expanded', 'false')
  btn.setAttribute('aria-controls', `${id}-menu`)
  if (labelText) btn.setAttribute('aria-label', labelText)
  btn.innerHTML = `<span class="hub-select__value"></span><span class="hub-select__chev" aria-hidden="true"></span>`

  const menu = document.createElement('ul')
  menu.className = 'hub-select__menu'
  menu.id = `${id}-menu`
  menu.tabIndex = -1
  menu.setAttribute('role', 'listbox')
  if (labelText) menu.setAttribute('aria-label', labelText)

  wrap.append(btn, menu)

  const valueEl = btn.querySelector('.hub-select__value')
  let isOpen = false
  let activeEl = null
  let typeBuf = ''
  let typeTimer = null

  const opts = () => [...menu.querySelectorAll('.hub-select__opt')]

  function buildOptions() {
    menu.innerHTML = [...select.options].map((o, i) => `
      <li class="hub-select__opt" id="${id}-o${i}" role="option" data-value="${escapeAttr(o.value)}"
          aria-selected="${o.selected ? 'true' : 'false'}"${o.disabled ? ' aria-disabled="true"' : ''}>
        <span class="hub-select__opt-label">${escapeHtml(o.textContent)}</span>
      </li>`).join('')
  }
  const enabled = () => opts().filter(li => li.getAttribute('aria-disabled') !== 'true')
  function updateValue() {
    const o = select.options[select.selectedIndex]
    valueEl.textContent = o ? o.textContent : ''
    // reflect selection state onto the rendered options
    const v = o ? o.value : null
    for (const li of opts()) li.setAttribute('aria-selected', li.dataset.value === v ? 'true' : 'false')
  }
  function refresh() { buildOptions(); updateValue() }

  function setActive(li) {
    if (activeEl) activeEl.classList.remove('is-active')
    activeEl = li || null
    if (activeEl) {
      activeEl.classList.add('is-active')
      menu.setAttribute('aria-activedescendant', activeEl.id)
      activeEl.scrollIntoView({ block: 'nearest' })
    } else {
      menu.removeAttribute('aria-activedescendant')
    }
  }
  function move(delta) {
    const list = enabled(); if (!list.length) return
    let i = activeEl ? list.indexOf(activeEl) : -1
    i = (i + delta + list.length) % list.length
    setActive(list[i])
  }

  function open() {
    if (isOpen || select.disabled) return
    isOpen = true
    wrap.dataset.open = 'true'
    btn.setAttribute('aria-expanded', 'true')
    setActive(menu.querySelector('[aria-selected="true"]:not([aria-disabled="true"])') || enabled()[0] || null)
    menu.focus()
    document.addEventListener('pointerdown', onDocDown, true)
  }
  function close(focusBtn = true) {
    if (!isOpen) return
    isOpen = false
    wrap.dataset.open = 'false'
    btn.setAttribute('aria-expanded', 'false')
    setActive(null)
    document.removeEventListener('pointerdown', onDocDown, true)
    if (focusBtn) btn.focus()
  }
  function choose(li) {
    if (!li || li.getAttribute('aria-disabled') === 'true') return
    if (select.value !== li.dataset.value) {
      select.value = li.dataset.value
      select.dispatchEvent(new Event('change', { bubbles: true }))
    }
    updateValue()
    close()
  }
  function onDocDown(e) { if (!wrap.contains(e.target)) close(false) }

  function typeahead(ch) {
    clearTimeout(typeTimer)
    typeBuf += ch.toLowerCase()
    typeTimer = setTimeout(() => { typeBuf = '' }, 600)
    const match = enabled().find(li => li.textContent.trim().toLowerCase().startsWith(typeBuf))
    if (match) setActive(match)
  }

  btn.addEventListener('click', () => (isOpen ? close() : open()))
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault(); open()
    }
  })
  menu.addEventListener('click', (e) => { const li = e.target.closest('.hub-select__opt'); if (li) choose(li) })
  menu.addEventListener('pointermove', (e) => {
    const li = e.target.closest('.hub-select__opt')
    if (li && li !== activeEl && li.getAttribute('aria-disabled') !== 'true') setActive(li)
  })
  menu.addEventListener('keydown', (e) => {
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); move(1); break
      case 'ArrowUp':   e.preventDefault(); move(-1); break
      case 'Home':      e.preventDefault(); setActive(enabled()[0]); break
      case 'End':       e.preventDefault(); setActive(enabled().at(-1)); break
      case 'Enter':
      case ' ':         e.preventDefault(); choose(activeEl); break
      case 'Escape':    e.preventDefault(); close(); break
      case 'Tab':       close(false); break
      default:
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); typeahead(e.key) }
    }
  })

  // Programmatic option replacement (innerHTML on the native select) re-syncs
  // the rendered list automatically.
  const mo = new MutationObserver(() => refresh())
  mo.observe(select, { childList: true })
  // External `change` (e.g. another control dispatches one) updates the label.
  select.addEventListener('change', updateValue)

  refresh()

  const controller = {
    el: wrap,
    refresh,
    open,
    close: () => close(false),
    destroy() {
      mo.disconnect()
      document.removeEventListener('pointerdown', onDocDown, true)
      select.classList.remove('hub-select__native')
      select.removeAttribute('tabindex'); select.removeAttribute('aria-hidden')
      wrap.replaceWith(select)
      delete select._hubSelect
    },
  }
  select._hubSelect = controller
  return controller
}

export function enhanceWithin(root = document) {
  root.querySelectorAll('select:not([data-no-enhance])').forEach(enhanceSelect)
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
}
function escapeAttr(s) {
  return String(s).replace(/[&"]/g, c => ({ '&': '&amp;', '"': '&quot;' }[c]))
}
