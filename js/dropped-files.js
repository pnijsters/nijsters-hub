// Dropped files — what a drop holds, with its folders opened.
//
// No imports, and no DOM beyond the drop's entry API, so it can be tested
// with fake entries. A dropped folder is opened, subfolders too. Hidden
// files and folders (a name starting with '.', like .DS_Store) are
// skipped.

const fileOf = (entry) => new Promise((ok, fail) => entry.file(ok, fail))
const batchOf = (reader) => new Promise((ok, fail) => reader.readEntries(ok, fail))
const pathOf = (entry) => entry.fullPath.replace(/^\//, '')
const byPath = (a, b) => a.localeCompare(b, undefined, { numeric: true })

// A drop's dataTransfer → { files, unreadable }: the files sorted by path
// (2 before 10), and the path of each file or folder that couldn't be
// read. Without the entry API (a synthetic drop, some browsers) the drop's
// files are taken as they are.
export async function droppedFiles(dataTransfer) {
  // Taken now: a drop's items are emptied once the event's turn ends.
  const items = Array.from(dataTransfer.items || [])
  const taken = items.length
    ? items.map((item) => {
      const entry = item.webkitGetAsEntry?.()
      return entry ? { entry } : { file: item.getAsFile() }
    })
    : Array.from(dataTransfer.files || [], (file) => ({ file }))
  const found = [], unreadable = []
  const walk = async (entry) => {
    if (entry.name.startsWith('.')) return
    if (entry.isFile) {
      try { found.push({ path: pathOf(entry), file: await fileOf(entry) }) } catch { unreadable.push(pathOf(entry)) }
      return
    }
    // A folder answers in batches until an empty one.
    const reader = entry.createReader()
    for (;;) {
      let batch
      try { batch = await batchOf(reader) } catch { unreadable.push(pathOf(entry)); return }
      if (!batch.length) return
      for (const e of batch) await walk(e)
    }
  }
  for (const { entry, file } of taken) {
    if (entry) await walk(entry)
    else if (file) found.push({ path: file.name, file })   // null: dragged text, not a file
  }
  return {
    files: found.sort((a, b) => byPath(a.path, b.path)).map((f) => f.file),
    unreadable: unreadable.sort(byPath),
  }
}
