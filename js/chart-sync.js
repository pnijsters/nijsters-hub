// Shared chart-sync controller. ONE implementation of the synchronized
// month-guide for the whole Hub (utilities + airbnb), extracted verbatim
// from the proven utilities controller so its mistake-#12 safety is kept:
//
//   Every effect here is a DOM overlay OUTSIDE the chart SVG, or an
//   attribute/inline-style change on existing nodes. It never adds or
//   removes nodes inside a chart SVG on pointer move, never uses a Plot
//   pointer mark. That is what froze the tab before; do not regress it.
//
// What it does, given a set of Plot figures that share a categorical
// x-scale (e.g. Jan..Dec, or a 24-month band):
//   - draws a hairline guide at the hovered category on EVERY chart,
//     placed from each chart's own Plot x-scale (charts can differ in
//     width/margins and still line up),
//   - resolves the hovered category from whichever chart the pointer is
//     over, OR (reverse leg) from a caller-supplied list of row elements,
//   - cues the matching row element with .is-cued,
//   - optionally recolours the hovered category's bars,
//   - optionally shows one floating readout box with the caller's HTML.
//
// One document pointermove, rAF-throttled, torn down and rebuilt on
// refresh(). The caller owns content (what a category means, the readout
// HTML, which rows map to keys); this module owns geometry + lifecycle.

// Left edge (intrinsic SVG px) of a category's band on a Plot band
// x-scale, plus half a band so the guide sits on the band centre. Falls
// back to index math if the pinned Plot build lacks scale.apply.
function bandCenter(sx, key) {
  if (typeof sx.apply === 'function') {
    const a = sx.apply(key)
    if (a != null && !Number.isNaN(a)) return a + (sx.bandwidth ? sx.bandwidth / 2 : 0)
  }
  const dom = sx.domain || []
  const i = dom.indexOf(key)
  if (i < 0 || !sx.range) return null
  const [r0, r1] = sx.range
  const step = (r1 - r0) / dom.length
  return r0 + step * (i + 0.5)
}

const intrinsicW = svg =>
  parseFloat(svg.getAttribute('width')) || svg.getBoundingClientRect().width

/**
 * @param {object} cfg
 * @param {() => SVGElement[]} cfg.svgs       Plot figure <svg>s to guide.
 * @param {() => {key:string,el:HTMLElement}[]} [cfg.reverse]
 *        Row elements that map to keys: hovering one drives the guide,
 *        and the matching one is cued with .is-cued.
 * @param {(key:string) => void} [cfg.onEnter]  Category active/changed.
 * @param {() => void}            [cfg.onLeave]  Pointer left everything.
 * @param {(key:string) => string|null} [cfg.readout]
 *        HTML for the floating .chart-readout box (null = no box).
 * @param {(rect:SVGRectElement, rankIndex:number, ranks:Map) => string} [cfg.barRamp]
 *        If present, the hovered category's bar rects are recoloured.
 */
// Read a resolved CSS custom property (design token) off :root. Shared by every
// chart page for series colours -- no per-page duplication.
export const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

// Standard chart colour tokens read off :root. Shared by every chart page.
export function chartTokens() {
  return {
    ink:    cssVar('--text'),
    soft:   cssVar('--text-secondary'),
    mute:   cssVar('--text-muted'),
    faint:  cssVar('--text-faint'),
    rule:   cssVar('--line'),
    accent: cssVar('--accent'),
    warn:   cssVar('--warn'),
    ground: cssVar('--ground'),
  }
}

// Style Observable-Plot tooltips to the brand (dark tip, DM Sans, tabular nums)
// and keep them styled as Plot re-renders. Shared by every Plot page.
const _tipObservers = new WeakMap()
function _styleTipNode(g, observer) {
  if (observer) observer.disconnect()
  const groundUp = cssVar('--ground-up'), ink = cssVar('--text')
  g.querySelectorAll('path').forEach(p => {
    p.setAttribute('fill', groundUp); p.setAttribute('stroke', ink); p.setAttribute('stroke-opacity', '0.85')
  })
  g.querySelectorAll('text, tspan').forEach(t => {
    t.setAttribute('fill', ink); t.style.fontFamily = 'var(--font-body)'
    t.style.fontVariantNumeric = 'tabular-nums'; t.style.fontSize = '11px'
  })
  if (observer) observer.observe(observer.__root, { childList: true, subtree: true })
}
export function styleChartSvg(figure) {
  const prior = _tipObservers.get(figure); if (prior) prior.disconnect()
  const observer = new MutationObserver(muts => {
    for (const m of muts) for (const node of m.addedNodes) {
      if (node.nodeType !== 1) continue
      if (node.getAttribute && node.getAttribute('aria-label') === 'tip') _styleTipNode(node, observer)
      else if (node.querySelectorAll) node.querySelectorAll('g[aria-label="tip"]').forEach(g => _styleTipNode(g, observer))
    }
  })
  observer.__root = figure
  observer.observe(figure, { childList: true, subtree: true })
  _tipObservers.set(figure, observer)
  figure.querySelectorAll('g[aria-label="tip"]').forEach(g => _styleTipNode(g, observer))
}

export function mountChartSync(cfg) {
  let st = null

  function teardown() {
    if (!st) return
    document.removeEventListener('pointermove', st.onMove)
    if (st.raf) cancelAnimationFrame(st.raf)
    st.entries.forEach(e => e.line.remove())
    st.readoutEl?.remove()
    if (st.shownKey !== null) cfg.onLeave?.()
    st.cued?.classList.remove('is-cued')
    clearBars(st)
    st = null
  }

  function clearBars(s) {
    if (s.barCols) for (const c of s.barCols) for (const rt of c.rs) rt.style.fill = ''
    s.barCur = null
  }

  // Group an svg's bar rects into category columns by on-screen x, so a
  // hovered category can be recoloured. Built lazily (bars exist only
  // after Plot lays the figure out) and rebuilt if the layout shifts.
  function barColumns(svg) {
    const rects = [...svg.querySelectorAll('g[aria-label="bar"] rect')]
    if (!rects.length) return null
    const m = new Map()
    for (const rt of rects) {
      const k = Math.round(rt.getBoundingClientRect().left)
      if (!m.has(k)) m.set(k, [])
      m.get(k).push(rt)
    }
    const ranks = new Map()
    if (cfg.barRamp) {
      const lum = c => {
        const n = c.match(/[\d.]+/g) || [0, 0, 0]
        return 0.2126 * +n[0] + 0.7152 * +n[1] + 0.0722 * +n[2]
      }
      const fills = [...new Set(rects.map(r => getComputedStyle(r).fill))]
        .sort((a, b) => lum(a) - lum(b))
      fills.forEach((f, i) => ranks.set(f, Math.min(i, fills.length - 1)))
    }
    const cols = [...m.values()].map(rs => ({
      cx: rs[0].getBoundingClientRect().left + rs[0].getBoundingClientRect().width / 2,
      rs,
    })).sort((a, b) => a.cx - b.cx)
    return { cols, ranks }
  }

  function refresh() {
    teardown()
    cfg.onRefresh?.()   // caller may snapshot idle state (e.g. legend HTML)
    const svgs = cfg.svgs().filter(
      s => s && typeof s.scale === 'function' && s.scale('x') && s.scale('x').domain)
    if (!svgs.length) return
    const entries = svgs.map(svg => {
      const sx = svg.scale('x')
      const line = document.createElement('div')
      line.className = 'month-guide'
      svg.parentElement.appendChild(line)
      return { svg, sx, line }
    })

    const reverse = cfg.reverse ? cfg.reverse() : []
    const rowByKey = new Map(reverse.map(r => [r.key, r.el]))

    let readoutEl = null
    if (cfg.readout) {
      readoutEl = document.createElement('div')
      readoutEl.className = 'chart-readout'
      readoutEl.hidden = true
      document.body.appendChild(readoutEl)
    }

    const place = (e, key) => {
      const sr = e.svg.getBoundingClientRect()
      const pr = e.line.parentElement.getBoundingClientRect()
      const c = bandCenter(e.sx, key)
      if (c == null) { e.line.classList.remove('show'); return }
      const ratio = sr.width / intrinsicW(e.svg)
      e.line.style.transform = `translateX(${(sr.left - pr.left) + c * ratio}px)`
      e.line.style.top = (sr.top - pr.top) + 'px'
      e.line.style.height = sr.height + 'px'
      e.line.classList.add('show')
    }

    const nearest = (e, clientX) => {
      const sr = e.svg.getBoundingClientRect()
      const ix = (clientX - sr.left) / (sr.width / intrinsicW(e.svg))
      let best = null, bd = Infinity
      for (const key of e.sx.domain) {
        const c = bandCenter(e.sx, key)
        if (c == null) continue
        const d = Math.abs(ix - c)
        if (d < bd) { bd = d; best = key }
      }
      return best
    }

    let cx = 0, cy = 0
    const rowKeyUnder = () => {
      for (const [key, el] of rowByKey) {
        const r = el.getBoundingClientRect()
        if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) return key
      }
      return null
    }

    const paintBars = (activeEntry, key) => {
      if (!cfg.barRamp || !st) return
      if (!activeEntry) { clearBars(st); return }
      if (!st.barSvg || st.barSvg !== activeEntry.svg) {
        clearBars(st)
        st.bar = barColumns(activeEntry.svg)
        st.barSvg = activeEntry.svg
      }
      if (!st.bar) return
      st.barCols = st.bar.cols
      const sr = activeEntry.svg.getBoundingClientRect()
      const ratio = sr.width / intrinsicW(activeEntry.svg)
      const target = sr.left + bandCenter(activeEntry.sx, key) * ratio
      let best = null, bd = Infinity
      for (const c of st.bar.cols) {
        const d = Math.abs(target - c.cx)
        if (d < bd) { bd = d; best = c }
      }
      if (best === st.barCur) return
      if (st.barCur) for (const rt of st.barCur.rs) rt.style.fill = ''
      if (best) for (const rt of best.rs) {
        rt.style.fill = cfg.barRamp(
          rt, st.bar.ranks.get(getComputedStyle(rt).fill) ?? 0, st.bar.ranks)
      }
      st.barCur = best
    }

    const showReadout = (activeEntry, key) => {
      if (!readoutEl) return
      const html = cfg.readout(key)
      if (!html || !activeEntry) { readoutEl.hidden = true; return }
      readoutEl.innerHTML = html
      readoutEl.hidden = false
      const sr = activeEntry.svg.getBoundingClientRect()
      const ratio = sr.width / intrinsicW(activeEntry.svg)
      const bx = sr.left + bandCenter(activeEntry.sx, key) * ratio
      const rr = readoutEl.getBoundingClientRect()
      let left = bx - rr.width / 2
      left = Math.max(8, Math.min(left, window.innerWidth - rr.width - 8))
      let top = sr.top - rr.height - 8
      if (top < 8) top = sr.bottom + 8
      readoutEl.style.left = left + 'px'
      readoutEl.style.top = top + 'px'
    }

    const onMove = ev => {
      cx = ev.clientX; cy = ev.clientY
      if (st.raf) return
      st.raf = requestAnimationFrame(() => {
        st.raf = 0
        const active = entries.find(e => {
          const r = e.svg.getBoundingClientRect()
          return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom
        })
        const key = active ? nearest(active, cx) : rowKeyUnder()
        if (!key) {
          entries.forEach(e => e.line.classList.remove('show'))
          clearBars(st)
          if (readoutEl) readoutEl.hidden = true
          if (st.shownKey !== null) {
            cfg.onLeave?.()
            st.cued?.classList.remove('is-cued')
            st.cued = null
            st.shownKey = null
          }
          return
        }
        entries.forEach(e => place(e, key))
        paintBars(active, key)
        showReadout(active, key)
        if (key !== st.shownKey) {
          st.shownKey = key
          cfg.onEnter?.(key)
          const row = rowByKey.get(key) || null
          if (row !== st.cued) {
            st.cued?.classList.remove('is-cued')
            row?.classList.add('is-cued')
            st.cued = row
          }
        }
      })
    }

    st = {
      entries, onMove, raf: 0, readoutEl,
      cued: null, shownKey: null,
      bar: null, barSvg: null, barCols: null, barCur: null,
    }
    document.addEventListener('pointermove', onMove, { passive: true })
  }

  return { refresh, destroy: teardown }
}
