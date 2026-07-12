/* ============================================================================
   Shared Hub shell — the ONE frame every app inherits.

   The frame is a dual-sidebar model (DESIGN_SYSTEM.md §1):
     - a thin global ICON RAIL (far left) that switches between apps. Shell
       owned, identical on every app.
     - an adjacent collapsible APP-NAV PANEL: the active app's own vertical
       menu (its sections). App owned (the app supplies the items via config).
     - a slim TOP BAR: global chrome only (wordmark + account menu). No app
       menus live here.
     - the CONTENT HEADER + body: the app's stat strip, an optional context
       line, the module-actions disclosure, then the app's own content.

   No app hand-writes shell markup; tweak here + css/hub.css and every app
   inherits with no per-app refactor.

   mountHubHeader(config) -> controller

   config = {
     app:      'Utilities',                 // panel title + wordmark home
     eyebrow:  'Family Hub · Utilities',    // optional (kept for compat)
     grace:    'four years on the grid.',   // optional italic note (panel head)
     gear:     { label, href } | { label, onClick } | null,
                                            // optional app config/setup entry,
                                            // pinned to the panel footer
     tabs:     [{ id, label }],             // 1+; first is active by default.
                                            // Rendered as the vertical menu.
     onTab:    (id) => {},                  // fires on menu selection
   }

   controller = {
     el,                       // the top bar element
     signoutBtn,               // #signoutBtn (apps wire + unhide it)
     gearEl,                   // #hubGear (or null)
     crLeft,                   // content-header context slot (legend / summary)
     navTop,                   // app-nav panel top slot (app-scoped context,
                               //   e.g. the Financials entity picker)
     activeTab,                // current menu id
     setTab(id),               // programmatic menu change (no onTab refire)
     clearActive(),            // no menu item highlighted (e.g. a Settings view)
     setGrace(text),           // update the panel grace note
     setStrip({ hero, stats }),// content-header stat strip
     setActions(items),        // module-level commands disclosure
   }
   ========================================================================= */

export function mountHubHeader(config) {
  const tabs = config.tabs && config.tabs.length ? config.tabs : [{ id: 'main', label: config.app }];
  const here = (location.pathname.split('/').pop() || '').toLowerCase();

  // --- Icon rail: the shell-owned app switcher (identical everywhere) ------
  const rail = document.createElement('aside');
  rail.className = 'hub-rail';
  rail.setAttribute('aria-label', 'Hub apps');
  rail.innerHTML = `
    <nav class="rail-apps" aria-label="Switch app"></nav>
    <button type="button" class="rail-toggle" id="railToggle" aria-label="Collapse menu" aria-expanded="true">
      <span class="rail-chev" aria-hidden="true"></span>
    </button>`;

  // --- Top bar: shell-owned global chrome (wordmark + account) -------------
  const topbar = document.createElement('header');
  topbar.className = 'hub-topbar';
  topbar.innerHTML = `
    <button type="button" class="nav-menu-btn" id="navMenuBtn" aria-label="Open menu"
            aria-expanded="false" aria-controls="hubNav">
      <span class="nav-toggle__bars" aria-hidden="true"></span>
    </button>
    <a class="wordmark" href="${DEFAULT_APP}">Nijsters</a>
    <div class="acct" id="acct" data-open="false">
      <button type="button" class="acct-toggle" id="acctToggle"
              aria-haspopup="menu" aria-expanded="false" aria-controls="acctMenu">
        <span class="acct-name" id="acctName">Account</span>
        <span class="acct-chev" aria-hidden="true"></span>
      </button>
      <div class="acct-menu" id="acctMenu" role="menu" aria-label="Account">
        <button type="button" class="signout" id="signoutBtn" role="menuitem" hidden>Sign out</button>
      </div>
    </div>`;

  // --- App-nav panel: the app's own vertical menu (app-owned) --------------
  const nav = document.createElement('nav');
  nav.className = 'hub-nav';
  nav.id = 'hubNav';
  nav.setAttribute('aria-label', `${config.app} sections`);
  nav.innerHTML = `
    <div class="hub-nav__inner">
      <div class="hub-nav__head">
        <h1 class="nav-title">${config.app}</h1>
        ${config.grace ? `<span class="grace">${config.grace}</span>` : ''}
      </div>
      <div class="hub-nav__top" id="hubNavTop"></div>
      <ul class="hub-nav__menu" id="viewSwitch" role="tablist" aria-label="${config.app} views">
        ${tabs.map((t, i) => `<li><button type="button" role="tab" data-view="${t.id}" aria-current="${i === 0 ? 'true' : 'false'}">${t.label}</button></li>`).join('')}
      </ul>
      <div class="hub-nav__foot">
        ${config.gear
          ? (config.gear.href
              ? `<a class="shell-cog" id="hubGear" href="${config.gear.href}" aria-label="${config.gear.label}" title="${config.gear.label}" hidden><span class="cog-glyph" aria-hidden="true">&#9881;</span><span class="cog-label">${config.gear.label}</span></a>`
              : `<button type="button" class="shell-cog" id="hubGear" aria-label="${config.gear.label}" title="${config.gear.label}" aria-current="false" hidden><span class="cog-glyph" aria-hidden="true">&#9881;</span><span class="cog-label">${config.gear.label}</span></button>`)
          : ''}
      </div>
    </div>`;

  // --- Content header: strip + context line + module actions ---------------
  const head = document.createElement('div');
  head.className = 'hub-head';
  head.innerHTML = `
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
      <div class="hub-actions" id="hubActions" data-open="false" hidden>
        <button type="button" class="hub-actions-toggle" id="hubActionsToggle"
                aria-expanded="false" aria-haspopup="menu" aria-controls="hubActionsPop">
          <span>Actions</span><span class="hai-chev" aria-hidden="true"></span>
        </button>
        <div class="hub-actions-pop" id="hubActionsPop" role="menu" aria-label="Module actions"></div>
      </div>
    </div>`;

  const scrim = document.createElement('div');
  scrim.className = 'hub-scrim';
  scrim.id = 'hubScrim';

  document.body.classList.add('hub-app');
  const frag = document.createDocumentFragment();
  frag.append(rail, topbar, nav, head, scrim);
  document.body.prepend(frag);

  mountRail(rail, here);
  mountAccount(topbar);
  mountToggles(rail, topbar, scrim);

  const stripEl  = head.querySelector('#hubStrip');
  const heroV    = head.querySelector('#stripHeroValue');
  const heroL    = head.querySelector('#stripHeroLabel');
  const heroD    = head.querySelector('#stripHeroDelta');
  const statsEl  = head.querySelector('#stripStats');
  const switchEl = nav.querySelector('#viewSwitch');

  let active = tabs[0].id;

  function paintTabs() {
    for (const b of switchEl.querySelectorAll('button')) {
      b.setAttribute('aria-current', b.dataset.view === active ? 'true' : 'false');
    }
  }
  switchEl.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (!b) return;
    // On mobile the panel is an off-canvas drawer; a selection closes it.
    document.body.classList.remove('nav-open');
    if (b.dataset.view === active) return;
    active = b.dataset.view;
    paintTabs();
    if (typeof config.onTab === 'function') config.onTab(active);
  });
  paintTabs();

  const gearEl = nav.querySelector('#hubGear');
  if (gearEl && config.gear && typeof config.gear.onClick === 'function') {
    gearEl.addEventListener('click', () => config.gear.onClick());
  }

  // Module actions disclosure — the shared slot for app-level commands.
  // Lives in the content header; hidden until setActions() is called with a
  // non-empty list. Each app populates this AFTER auth, same as the gear.
  const actionsWrap   = head.querySelector('#hubActions');
  const actionsToggle = head.querySelector('#hubActionsToggle');
  const actionsPop    = head.querySelector('#hubActionsPop');
  let actionItems = [];
  function closeActions() {
    actionsWrap.dataset.open = 'false';
    actionsToggle.setAttribute('aria-expanded', 'false');
  }
  actionsToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = actionsWrap.dataset.open !== 'true';
    actionsWrap.dataset.open = open ? 'true' : 'false';
    actionsToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  document.addEventListener('click', (e) => {
    if (actionsWrap.dataset.open === 'true' && !actionsWrap.contains(e.target)) closeActions();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && actionsWrap.dataset.open === 'true') {
      closeActions(); actionsToggle.focus();
    }
  });
  actionsPop.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-id]');
    if (!btn) return;
    const it = actionItems.find(x => x.id === btn.dataset.id);
    closeActions();
    if (it && typeof it.onClick === 'function') it.onClick();
  });

  // Every app that mounts the shell inherits the stale-tab watcher with no
  // per-page wiring. Dynamic + guarded so a notify-subsystem failure can
  // never stop the shell from rendering.
  import('./stale-tab.js').then(m => m.startStaleTabWatch()).catch(() => {})

  const controller = {
    el: topbar,
    signoutBtn: topbar.querySelector('#signoutBtn'),
    gearEl,
    crLeft: head.querySelector('#crLeft'),
    navTop: nav.querySelector('#hubNavTop'),
    get activeTab() { return active; },
    setTab(id) {
      if (!tabs.some(t => t.id === id)) return;
      active = id;
      paintTabs();
    },
    // No data lens active (e.g. an app showing a shell-level destination
    // like Settings). The menu stays, none highlighted.
    clearActive() {
      active = null;
      paintTabs();
    },
    setGrace(text) {
      const g = nav.querySelector('.grace');
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
    setActions(items) {
      actionItems = Array.isArray(items) ? items : [];
      if (!actionItems.length) {
        actionsPop.innerHTML = '';
        actionsWrap.hidden = true;
        closeActions();
        return;
      }
      actionsPop.innerHTML = actionItems.map(it => `
        <button type="button" class="hub-action-item" data-id="${it.id}" role="menuitem">
          <span class="hai-label">${it.label}</span>
          ${it.meta ? `<span class="hai-meta">${it.meta}</span>` : ''}
        </button>`).join('');
      actionsWrap.hidden = false;
    },
  };
  return controller;
}

/* ----------------------------------------------------------------------------
   The icon rail — the shell's app switcher. A persistent far-left column of
   the live Hub apps; the current page is the active app. Because the Hub is a
   static multi-page site, switching an app is a full-page navigation to that
   app's file (no router). The Members row appears only for admins. Replaces
   the old hover "jump menu"; the app list is the same.
   ------------------------------------------------------------------------- */

// Monoline icons: 24x24, currentColor stroke, no fill — one visual family,
// consistent with the Hub's hairline / no-shadow system. Active app turns
// the icon accent (scarce orange).
const ICON = {
  photos: `<svg class="rail-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="1"/><circle cx="8.5" cy="10" r="1.4"/><path d="M6 18l5-5 3 3 2-2 3 3"/></svg>`,
  utilities: `<svg class="rail-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 3L5 13h6l-1 8 8-11h-6l1-7z"/></svg>`,
  mortgage: `<svg class="rail-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 11l8-7 8 7"/><path d="M6 10v9h12v-9"/><path d="M10 19v-5h4v5"/></svg>`,
  airbnb: `<svg class="rail-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12v6"/><path d="M21 18v-3a3 3 0 0 0-3-3H9v3"/><path d="M3 15h18"/><circle cx="6" cy="12.5" r="1.5"/></svg>`,
  fx: `<svg class="rail-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9h13"/><path d="M14 6l3 3-3 3"/><path d="M20 15H7"/><path d="M10 12l-3 3 3 3"/></svg>`,
  ledger: `<svg class="rail-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h16"/><path d="M7 20v-6"/><path d="M12 20V8"/><path d="M17 20v-9"/></svg>`,
  members: `<svg class="rail-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><path d="M16 5.6a3.2 3.2 0 0 1 0 5.2"/><path d="M17 13.6a5.5 5.5 0 0 1 3.5 5.1"/></svg>`,
};

// The default landing app (there is no separate dashboard; the rail is the
// global menu). The wordmark and the public landing's Hub door point here.
const DEFAULT_APP = 'photos.html';

const HUB_APPS = [
  { file: 'photos.html',    name: 'Photos',    icon: ICON.photos },
  { file: 'utilities.html', name: 'Utilities', icon: ICON.utilities },
  { file: 'mortgage.html',  name: 'Mortgage',  icon: ICON.mortgage },
  { file: 'airbnb.html',    name: 'AirBnB',    icon: ICON.airbnb },
  { file: 'fx.html',        name: 'Exchange Rates', icon: ICON.fx },
  { file: 'ledger.html',    name: 'Financials', icon: ICON.ledger },
];
const HUB_ADMIN_APP = { file: 'members.html', name: 'Members', icon: ICON.members };

function mountRail(rail, here) {
  const apps = rail.querySelector('.rail-apps');
  const row = (app) => {
    const current = app.file === here;
    return `<a class="rail-app${current ? ' is-current' : ''}" href="${app.file}"
      aria-label="${app.name}" title="${app.name}"${current ? ' aria-current="page"' : ''}>
      ${app.icon}
      <span class="rail-name">${app.name}</span></a>`;
  };
  const render = (list) => { apps.innerHTML = list.map(row).join(''); };
  render(HUB_APPS);

  // Members is admin-only; the role check is async. The rail renders
  // immediately and gains the row if the check resolves admin.
  import('./supabase-client.js')
    .then(m => m.getCurrentRole())
    .then(role => { if (role === 'admin') render([...HUB_APPS, HUB_ADMIN_APP]); })
    .catch(() => {});
}

function mountAccount(topbar) {
  const acct = topbar.querySelector('#acct');
  const toggle = topbar.querySelector('#acctToggle');
  const name = topbar.querySelector('#acctName');

  function close() { acct.dataset.open = 'false'; toggle.setAttribute('aria-expanded', 'false'); }
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = acct.dataset.open !== 'true';
    acct.dataset.open = open ? 'true' : 'false';
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  document.addEventListener('click', (e) => {
    if (acct.dataset.open === 'true' && !acct.contains(e.target)) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && acct.dataset.open === 'true') { close(); toggle.focus(); }
  });

  // Fill the account name once the session is known; non-blocking.
  import('./supabase-client.js')
    .then(async m => {
      const { data } = await m.supabase.auth.getUser();
      const u = data?.user;
      const label = u?.user_metadata?.first_name || u?.email?.split('@')[0];
      if (label) name.textContent = label;
    })
    .catch(() => {});
}

// Two context-scoped controls, no floating hamburger over content:
//   - the rail-bottom chevron (#railToggle) collapses/expands the panel on
//     desktop; state persists.
//   - the top-bar menu button (#navMenuBtn) opens the off-canvas drawer on
//     mobile, where the rail itself is hidden.
function mountToggles(rail, topbar, scrim) {
  const railToggle = rail.querySelector('#railToggle');
  const menuBtn = topbar.querySelector('#navMenuBtn');
  const KEY = 'hubNavCollapsed';

  if (localStorage.getItem(KEY) === '1') document.body.classList.add('nav-collapsed');

  function syncRailAria() {
    const collapsed = document.body.classList.contains('nav-collapsed');
    railToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    railToggle.setAttribute('aria-label', collapsed ? 'Expand menu' : 'Collapse menu');
  }
  railToggle.addEventListener('click', () => {
    const collapsed = document.body.classList.toggle('nav-collapsed');
    try { localStorage.setItem(KEY, collapsed ? '1' : '0'); } catch {}
    syncRailAria();
  });
  syncRailAria();

  function closeDrawer() {
    document.body.classList.remove('nav-open');
    menuBtn.setAttribute('aria-expanded', 'false');
  }
  menuBtn.addEventListener('click', () => {
    const open = document.body.classList.toggle('nav-open');
    menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  scrim.addEventListener('click', closeDrawer);
}
