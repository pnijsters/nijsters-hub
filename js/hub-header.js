/* ============================================================================
   Shared Hub header — the ONE page framework every app inherits.
   Renders the four zones (DESIGN_SYSTEM.md §1) from a small per-app
   config. No app hand-writes header markup; tweak here + css/hub.css
   and every app inherits with no per-app refactor.

   mountHubHeader(config) -> controller

   config = {
     app:      'Utilities',                 // ribbon title
     eyebrow:  'Family Hub · Utilities',    // optional, defaults from app
     grace:    'four years on the grid.',   // optional italic note
     gear:     { label, href } | { label, onClick } | null,
                                            // optional app config entry:
                                            // a link (href) or an in-app
                                            // action (onClick, e.g. a
                                            // Settings view)
     tabs:     [{ id, label }],             // 1+; first is active by default
     onTab:    (id) => {},                  // fires on tab change
   }

   controller = {
     el,                       // the <header> element
     signoutBtn,               // #signoutBtn (apps wire + unhide it)
     crLeft,                   // Zone-4 left slot (legend / summary)
     activeTab,                // current tab id
     setTab(id),               // programmatic tab change (no onTab refire)
     setStrip({ hero, stats }) // Zone-3 content; call on load + tab change
   }                            //   hero  = { value, label, delta? }
                                //   stats = [{ label, value, context? }]
   ========================================================================= */

export function mountHubHeader(config) {
  const eyebrow = config.eyebrow || `Family Hub · ${config.app}`;
  const tabs = config.tabs && config.tabs.length ? config.tabs : [{ id: 'main', label: config.app }];

  const header = document.createElement('header');
  header.className = 'hub-shell';
  header.innerHTML = `
    <div class="brand">
      <a href="/" class="wordmark">Nijsters</a>
      <div class="hub-jump">
        <a href="hub.html" class="locator">Family Hub</a>
        <div class="hub-jump__menu" role="menu" aria-label="Jump to a Hub app"></div>
      </div>
    </div>
    <div class="shell-actions">
      ${config.gear
        ? (config.gear.href
            ? `<a class="shell-cog" id="hubGear" href="${config.gear.href}" aria-label="${config.gear.label}" title="${config.gear.label}" hidden>&#9881;</a>`
            : `<button type="button" class="shell-cog" id="hubGear" aria-label="${config.gear.label}" title="${config.gear.label}" aria-current="false" hidden>&#9881;</button>`)
        : ''}
      <button class="signout" id="signoutBtn" hidden>Sign out</button>
    </div>`;

  const head = document.createElement('div');
  head.className = 'hub-head';
  head.innerHTML = `
    <div class="page-head">
      <p class="eyebrow">${eyebrow}</p>
      <h1 class="title">${config.app}</h1>
      ${config.grace ? `<span class="grace">${config.grace}</span>` : ''}
    </div>
    <div class="hub-strip" id="hubStrip" hidden>
      <div class="strip-hero">
        <span class="hero-value" id="stripHeroValue">&mdash;</span>
        <span class="hero-label" id="stripHeroLabel"></span>
        <span class="hero-delta" id="stripHeroDelta" hidden></span>
      </div>
      <div class="strip-stats" id="stripStats"></div>
    </div>
    <div class="control-row">
      <div class="cr-left" id="crLeft"></div>
      <nav class="view-switch" id="viewSwitch" role="tablist" aria-label="${config.app} views">
        ${tabs.map((t, i) => `<button type="button" role="tab" data-view="${t.id}" aria-current="${i === 0 ? 'true' : 'false'}">${t.label}</button>`).join('')}
      </nav>
    </div>`;

  document.body.prepend(head);
  document.body.prepend(header);

  mountJumpMenu(header);

  const stripEl  = head.querySelector('#hubStrip');
  const heroV    = head.querySelector('#stripHeroValue');
  const heroL    = head.querySelector('#stripHeroLabel');
  const heroD    = head.querySelector('#stripHeroDelta');
  const statsEl  = head.querySelector('#stripStats');
  const switchEl = head.querySelector('#viewSwitch');

  let active = tabs[0].id;

  function paintTabs() {
    for (const b of switchEl.querySelectorAll('button')) {
      b.setAttribute('aria-current', b.dataset.view === active ? 'true' : 'false');
    }
  }
  switchEl.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (!b || b.dataset.view === active) return;
    active = b.dataset.view;
    paintTabs();
    if (typeof config.onTab === 'function') config.onTab(active);
  });

  const gearEl = header.querySelector('#hubGear');
  if (gearEl && config.gear && typeof config.gear.onClick === 'function') {
    gearEl.addEventListener('click', () => config.gear.onClick());
  }

  // Every app that mounts the header inherits the stale-tab watcher with no
  // per-page wiring. Dynamic + guarded so a notify-subsystem failure can
  // never stop the header from rendering.
  import('./stale-tab.js').then(m => m.startStaleTabWatch()).catch(() => {})

  const controller = {
    el: header,
    signoutBtn: header.querySelector('#signoutBtn'),
    gearEl,
    crLeft: head.querySelector('#crLeft'),
    get activeTab() { return active; },
    setTab(id) {
      if (!tabs.some(t => t.id === id)) return;
      active = id;
      paintTabs();
    },
    // No data lens active (e.g. an app showing a shell-level
    // destination like Settings). The tab bar stays, none highlighted.
    clearActive() {
      active = null;
      paintTabs();
    },
    setGrace(text) {
      const g = head.querySelector('.grace');
      if (g) g.textContent = text;
    },
    setStrip({ hero, stats } = {}) {
      if (hero) {
        heroV.textContent = hero.value;
        heroL.textContent = hero.label || '';
        if (hero.delta) { heroD.innerHTML = hero.delta; heroD.hidden = false; }
        else { heroD.hidden = true; }
      }
      statsEl.innerHTML = (stats || []).map(s => `
        <div class="strip-stat">
          <span class="ss-label">${s.label}</span>
          <span class="ss-value">${s.value}</span>
          ${s.context ? `<span class="ss-context">${s.context}</span>` : ''}
        </div>`).join('');
      stripEl.hidden = !hero && !(stats && stats.length);
    },
  };
  return controller;
}

/* ----------------------------------------------------------------------------
   Family Hub jump menu — a hover-revealed contents list of the live Hub
   apps, so a signed-in member can cross from one app to another without
   returning to the dashboard. Desktop only (no hover on touch); on touch
   the "Family Hub" label stays a plain link to hub.html. Clicking the
   label always goes to hub.html regardless. The list is derived here, not
   passed per-app; the Members row appears only for admins.
   ------------------------------------------------------------------------- */

const HUB_APPS = [
  { file: 'photos.html',    name: 'Photos',    tag: 'archive' },
  { file: 'utilities.html', name: 'Utilities', tag: 'bills'   },
  { file: 'airbnb.html',    name: 'AirBnB',    tag: 'rental'  },
  { file: 'fx.html',        name: 'Exchange Rates', tag: 'currency' },
];
const HUB_ADMIN_APP = { file: 'members.html', name: 'Members', tag: 'people' };

function mountJumpMenu(header) {
  const fine = window.matchMedia('(hover:hover) and (pointer:fine)');
  const wrap    = header.querySelector('.hub-jump');
  const locator = wrap.querySelector('.locator');
  const menu    = wrap.querySelector('.hub-jump__menu');

  // Touch / no-hover: the menu is unreachable by design — drop it and
  // leave "Family Hub" as the plain hub.html link.
  if (!fine.matches) { menu.remove(); return; }

  const here = (location.pathname.split('/').pop() || '').toLowerCase();

  function rowMarkup(app) {
    if (app.file === here) {
      return `<span class="hub-jump__row is-current" aria-current="page">
        <span class="hj-name">${app.name}</span><span class="hj-tag">you are here</span></span>`;
    }
    return `<a class="hub-jump__row" role="menuitem" tabindex="-1" href="${app.file}">
      <span class="hj-name">${app.name}</span><span class="hj-tag">${app.tag}</span></a>`;
  }
  const render = (apps) => { menu.innerHTML = apps.map(rowMarkup).join(''); };
  render(HUB_APPS);

  // Members is admin-only. The role check is async; the menu renders
  // immediately without it and gains the row if the check resolves admin.
  import('./supabase-client.js')
    .then(m => m.getCurrentRole())
    .then(role => { if (role === 'admin') render([...HUB_APPS, HUB_ADMIN_APP]); })
    .catch(() => {});

  wrap.dataset.open = 'false';
  locator.setAttribute('aria-haspopup', 'menu');
  locator.setAttribute('aria-expanded', 'false');

  let openT, closeT;
  const items = () => [...menu.querySelectorAll('a.hub-jump__row')];

  function open() {
    clearTimeout(closeT);
    if (wrap.dataset.open === 'true') return;
    wrap.dataset.open = 'true';
    locator.setAttribute('aria-expanded', 'true');
  }
  function close() {
    clearTimeout(openT);
    wrap.dataset.open = 'false';
    locator.setAttribute('aria-expanded', 'false');
  }
  // Hover-intent: a short open delay so a cursor passing through the
  // masthead doesn't flash the menu; a longer close delay so diagonal
  // travel from the label onto a row doesn't dismiss it.
  const openSoon  = () => { clearTimeout(closeT); openT  = setTimeout(open, 120); };
  const closeSoon = () => { clearTimeout(openT);  closeT = setTimeout(close, 220); };

  wrap.addEventListener('pointerenter', openSoon);
  wrap.addEventListener('pointerleave', closeSoon);
  locator.addEventListener('focus', open);
  wrap.addEventListener('focusout', (e) => {
    if (!wrap.contains(e.relatedTarget)) close();
  });

  function focusItem(i) {
    const list = items();
    if (!list.length) return;
    list[(i + list.length) % list.length].focus();
  }
  wrap.addEventListener('keydown', (e) => {
    const opened = wrap.dataset.open === 'true';
    const idx = items().indexOf(document.activeElement);
    if (e.key === 'Escape') {
      if (opened) { close(); locator.focus(); e.preventDefault(); }
    } else if (e.key === 'ArrowDown') {
      open(); focusItem(idx < 0 ? 0 : idx + 1); e.preventDefault();
    } else if (e.key === 'ArrowUp' && opened) {
      focusItem(idx < 0 ? -1 : idx - 1); e.preventDefault();
    } else if (e.key === 'Home' && opened) {
      focusItem(0); e.preventDefault();
    } else if (e.key === 'End' && opened) {
      focusItem(-1); e.preventDefault();
    }
  });
}
