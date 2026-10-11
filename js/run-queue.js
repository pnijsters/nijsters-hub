// Run queue — a first-in, first-out line that runs at most `slots` items
// at a time.
//
// Pure ES module: no DOM, no Supabase, no imports. Items are compared
// with ===. run(item) is the caller's work and handles its own failures:
// whether it returns a promise or a value, rejects or throws, its slot
// frees when it settles and the next waiting item starts. onIdle() is
// called once each time the queue goes from busy to nothing running and
// nothing waiting.
export function runQueue(slots, run, onIdle) {
  const waiting = []
  const running = new Set()
  const idlers = []
  const settle = (item) => {
    running.delete(item)
    start()
    if (running.size || waiting.length) return
    for (const resolve of idlers.splice(0)) resolve()
    onIdle?.()
  }
  const start = () => {
    while (running.size < slots && waiting.length) {
      const item = waiting.shift()
      running.add(item)
      let p
      try { p = Promise.resolve(run(item)) } catch (e) { p = Promise.reject(e) }
      p.catch(() => {}).then(() => settle(item))
    }
  }
  const state = (item) => (running.has(item) ? 'running' : waiting.includes(item) ? 'waiting' : null)
  return {
    // Join the end of the line, starting now when a slot is free. An item
    // already running or waiting keeps its place.
    add(item) {
      if (state(item)) return
      waiting.push(item)
      start()
    },
    // Leave the line before starting: true if it was waiting.
    drop(item) {
      const i = waiting.indexOf(item)
      if (i >= 0) waiting.splice(i, 1)
      return i >= 0
    },
    // Empty the line; the running items finish. Returns what was waiting.
    clear: () => waiting.splice(0),
    // Places ahead of it (0 = next), or -1 when it isn't waiting.
    ahead: (item) => waiting.indexOf(item),
    // 'running' | 'waiting' | null
    state,
    // Resolves once nothing runs or waits (at once when that is now).
    idle: () => (running.size || waiting.length ? new Promise((r) => idlers.push(r)) : Promise.resolve()),
    get running() { return running.size },
    get size() { return running.size + waiting.length },
  }
}
