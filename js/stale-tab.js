// Stale-tab watcher. A tab left open across a deploy keeps running the old
// bundle until a manual refresh. It raises a quiet non-blocking notice with
// a Reload action when a deploy has happened SINCE this tab loaded. It never
// auto-reloads: a reload would discard in-progress work (a half-filled
// drawer, an upload queue). First consumer of js/hub-notify.js.
//
// Why not compare a baked-in BUILD_ID constant: GitHub Pages serves js/ with
// Cache-Control max-age=600 and gives no way to override it. After a deploy
// the browser keeps running a CACHED old module (old baked id) while
// version.json is fetched no-store (fresh), so the two never match for ~10
// min and the Reload button re-serves the same cached module: an unbreakable
// nag loop. Instead the running build is taken to be the FIRST no-store
// version.json read in this page load. That value is cache-proof and, after
// a reload, re-baselines to whatever the server now serves, so the loop
// cannot form. A tab still open across a later deploy sees live drift from
// its baseline and prompts exactly once per deploy.

import { notify } from './hub-notify.js'

const POLL_MS = 20 * 60 * 1000   // every ~20 min while the tab lives
const KEY = 'stale-tab'          // one slot: re-checks update in place

let started = false
let inFlight = false
let tabBuild = null              // server build observed when this tab loaded
let dismissedBuild = null        // server build the user chose to ignore

async function check() {
  if (inFlight || document.visibilityState !== 'visible') return
  inFlight = true
  try {
    const res = await fetch(`version.json?ts=${Date.now()}`, { cache: 'no-store' })
    if (!res.ok) return
    const live = (await res.json()).build
    // Unstamped (source / local dev): nothing meaningful to compare.
    if (typeof live !== 'string' || !live || live === '__BUILD_ID__') return
    // First observation in this page load is the baseline, not an update.
    if (tabBuild === null) { tabBuild = live; return }
    if (live === tabBuild || live === dismissedBuild) return
    notify({
      tone: 'info',
      label: 'UPDATE',
      message: 'A new version of the Hub is available.',
      action: { label: 'Reload', onClick: () => window.location.reload() },
      key: KEY,
      onDismiss: () => { dismissedBuild = live },   // quiet until the next deploy
    })
  } catch {
    // Offline or a transient blip: stay silent. Offline is a separate
    // future consumer, not an error to nag about here.
  } finally {
    inFlight = false
  }
}

export function startStaleTabWatch() {
  if (started) return
  started = true
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check()
  })
  setInterval(check, POLL_MS)
  check()
}
