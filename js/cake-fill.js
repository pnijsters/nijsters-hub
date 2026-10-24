// Fills the editable parts of the cake.boutique pages from the Hub's content.
//
// A page marks each editable part as <!--slot:name-->…<!--/slot--> and keeps
// its current content between the markers, so a filled page can be filled
// again. The site's build fills the pages from the published content and the
// Hub's preview fills the live pages from what is saved; both use this module,
// so the preview shows what Publish will put live. Pure: no DOM, no fetch.
//
// `content` is what cake.site_content() returns: { details, places, photos,
// testimonials }. Anything not known yet renders as its bracketed
// placeholder ($[X]), which the launch check refuses, so no made-up value
// reaches the site. `photos` is the bucket's public URL, ending in
// /cake-photos.

const SLOT = /<!--slot:([\w.-]+)-->[\s\S]*?<!--\/slot-->/g
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const THUMB_EDGE = 600 // js/photo-processor.js's thumb variant

// How wide each kind of photo shows, for the browser to pick a file
// (css/site.css: a 1200px measure, columns, and their breakpoints).
const SIZES = {
  half: '(max-width: 900px) 100vw, (max-width: 1280px) 50vw, 568px',
  door: '(max-width: 720px) 100vw, (max-width: 1280px) 33vw, 379px',
  grid: '(max-width: 560px) 100vw, (max-width: 900px) 50vw, (max-width: 1280px) 33vw, 384px',
  wall: '(max-width: 720px) 100vw, (max-width: 1280px) 58vw, 690px',
}

// The single photos. `first` photos lead their page and load at once.
const PLACES = {
  'hero':              { sizes: 'half', first: true, missing: '[The main photo]' },
  'door-weddings':     { sizes: 'door', missing: '[A wedding cake photo]' },
  'door-celebrations': { sizes: 'door', missing: '[A celebration cake photo]' },
  'door-dessert':      { sizes: 'door', missing: '[A dessert table photo]' },
  'home-about':        { sizes: 'half', missing: '[A photo for Meet Chef Ellah]' },
  'weddings-lead':     { sizes: 'half', first: true, missing: '[A wedding cake photo]' },
  'celebrations-lead': { sizes: 'half', first: true, missing: '[A celebration cake photo]' },
  'about-portrait':    { sizes: 'half', first: true, missing: '[A photo of Ellah]' },
  'about-work':        { sizes: 'half', missing: "[A photo of Ellah's hands at work]" },
}

// The galleries: three-column grids of at most six, and the portfolio wall.
// An empty grid shows three placeholders.
const GRIDS = {
  home:         '[A cake photo from Ellah]',
  weddings:     '[A wedding cake photo from Ellah]',
  celebrations: '[A celebration cake photo from Ellah]',
}
const GRID_MAX = 6

const TEXT = {
  'price.celebration':     d => money(d.celebration_from) ?? '$[X]',
  'price.wedding':         d => money(d.wedding_serving_from) ?? '$[X]',
  'price.minimum':         d => money(d.minimum_order) ?? '$[X]',
  // Dessert tables have a starting price, or are quoted per event. The door
  // says it as a line of its own, the price list after its label.
  'price.dessert':         d => dessert(d) ?? '[Quoted per event]',
  'price.dessert-row':     d => lowerFirst(dessert(d)) ?? '[quoted per event]',
  'price.wedding-typical': d => d.wedding_typical_low != null && d.wedding_typical_high != null
    ? `${money(d.wedding_typical_low)} and ${money(d.wedding_typical_high)}` : '$[X] and $[X]',
  'notice.wedding':        d => count(d.wedding_notice_weeks, 'week') ?? '[X] weeks',
  'notice.celebration':    d => count(d.celebration_notice_weeks, 'week') ?? '[X] weeks',
  'deposit':               d => d.deposit_percent != null ? `${d.deposit_percent}%` : '[X]',
  'reply-time':            d => count(d.reply_business_days, 'business day') ?? '[X]',
  'delivery-area':         d => d.delivery_area != null ? esc(d.delivery_area) : '[X]',
}

export function fill(html, content, { photos }) {
  const base = photos.replace(/\/+$/, '')
  const details = content.details ?? {}
  const byId = new Map((content.photos ?? []).map(p => [p.id, p]))
  return html.replace(SLOT, (whole, name, offset) => {
    const lineStart = html.lastIndexOf('\n', offset) + 1
    const indent = html.slice(lineStart, offset).match(/^[ \t]*/)[0]
    return `<!--slot:${name}-->${render(name, indent)}<!--/slot-->`
  })

  function render(name, indent) {
    if (TEXT[name]) return TEXT[name](details)
    const [kind, key] = name.split('.')
    if (kind === 'photo' && PLACES[key]) return place(key)
    if (kind === 'work' && GRIDS[key]) return block(indent, grid(key))
    if (name === 'work.portfolio') return block(indent, wall())
    if (name === 'testimonials') return block(indent, testimonials())
    if (name === 'budget-ranges') return block(indent, budgets())
    throw new Error(`cake-fill: unknown slot "${name}"`)
  }

  function place(key) {
    const spec = PLACES[key]
    const photo = byId.get(content.places?.[key])
    if (!photo) return `<div class="photo-missing">${spec.missing}</div>`
    return img(photo, { cls: 'photo photo--tall', sizes: spec.sizes, eager: spec.first })
  }

  function grid(key) {
    const shown = (content.photos ?? []).filter(p => p.galleries?.includes(key)).slice(0, GRID_MAX)
    if (!shown.length) return Array(3).fill(`<li><div class="photo-missing">${GRIDS[key]}</div></li>`)
    return shown.map(p =>
      `<li><figure class="work">${img(p, { cls: 'photo photo--square', sizes: 'grid' })}${caption(p)}</figure></li>`)
  }

  // Rows of two: the wide photo swaps sides each row, every other row sits
  // lower. js/site.js redoes this for each filter; this is the "All" layout,
  // for the first paint and for browsers without the script.
  function wall() {
    return (content.photos ?? []).filter(p => p.galleries?.includes('portfolio')).map((p, i) => {
      const row = Math.floor(i / 2)
      const cls = ['wall__item', i % 2 === row % 2 && 'wall__item--wide', row % 2 === 1 && 'wall__item--low']
        .filter(Boolean).join(' ')
      return `<li class="${cls}" data-occasion="${esc(p.kind ?? '')}"><figure><div class="wall__frame">` +
        `${img(p, { sizes: 'wall', eager: i < 2 })}</div>${caption(p)}</figure></li>`
    })
  }

  function testimonials() {
    const quotes = content.testimonials ?? []
    if (!quotes.length) {
      return [
        ['[Client quote, with their permission: a wedding couple, two or three sentences]', '[Name], wedding at [Venue]'],
        ['[Client quote, with their permission: a birthday or shower order]', '[Name], birthday'],
        ['[Client quote, with their permission: a repeat customer]', '[Name], anniversary'],
      ].map(([q, by]) => quote(q, by))
    }
    return quotes.map(t => quote(esc(t.quote), esc(t.name) + (t.occasion ? `, ${esc(t.occasion)}` : '')))
  }

  function budgets() {
    const steps = details.budget_steps
    if (!steps?.length) return ['$[X] to $[X]', '$[X] to $[X]', '$[X] and up'].map(o => `<option>${o}</option>`)
    return steps.map((s, i) => `<option>${money(s)}${i + 1 < steps.length ? ` to ${money(steps[i + 1])}` : ' and up'}</option>`)
  }

  // The full file is the src; the thumb joins it in srcset when it is smaller.
  function img(photo, { cls, sizes, eager = false }) {
    if (!UUID.test(photo.id)) throw new Error(`cake-fill: not a photo id: ${photo.id}`)
    const full = `${base}/full/${photo.id}.webp`
    const w = photo.width, h = photo.height
    const tw = Math.max(1, Math.round(w * Math.min(1, THUMB_EDGE / Math.max(w, h))))
    const srcset = tw < w ? ` srcset="${base}/thumb/${photo.id}.webp ${tw}w, ${full} ${w}w" sizes="${SIZES[sizes]}"` : ''
    return `<img${cls ? ` class="${cls}"` : ''} src="${full}"${srcset} alt="${photo.alt ? esc(photo.alt) : '[What the photo shows]'}"` +
      ` width="${w}" height="${h}"${eager ? ' fetchpriority="high"' : ' loading="lazy"'}>`
  }
}

function caption(p) {
  const title = p.title ? esc(p.title) : '[Title]'
  return `<figcaption><span class="work__title">${title}</span>${p.occasion ? `, ${esc(p.occasion)}` : ''}</figcaption>`
}

function quote(text, by) {
  return `<figure class="quote"><span class="quote__mark" aria-hidden="true">&ldquo;</span>` +
    `<blockquote><p>${text}</p></blockquote><figcaption>${by}</figcaption></figure>`
}

// Multi-line slots: one item per line at the markers' indent.
function block(indent, items) {
  return items.map(item => `\n${indent}${item}`).join('') + `\n${indent}`
}

function dessert(d) {
  if (d.dessert_quoted) return 'Quoted per event'
  if (d.dessert_from != null) return `From ${money(d.dessert_from)}`
  return null
}

const lowerFirst = s => s && s[0].toLowerCase() + s.slice(1)

// $150, $6.50, $1,500
function money(n) {
  if (n == null) return null
  const cents = Math.round(Number(n) * 100)
  const whole = String(Math.floor(cents / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `$${whole}${cents % 100 ? `.${String(cents % 100).padStart(2, '0')}` : ''}`
}

function count(n, unit) {
  return n == null ? null : `${n} ${unit}${n === 1 ? '' : 's'}`
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
