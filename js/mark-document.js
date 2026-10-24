// A copy of a document with visits' rows marked for whoever reviews the
// claim: yellow, as a highlighter would, inside a thin red frame that a
// black-and-white printout still shows. Made in the browser when the
// document is shown or downloaded and never stored: the original stays the
// record.
//
// Which rows comes from marks-model.js, given the document's words:
// - a PDF page's own text, where it is drawn visibly;
// - OCR (tesseract.js) of a page with no text, or with only a scanner's own
//   OCR (text drawn invisibly over the scan, too poor to trust), and of a
//   photo;
// - OCR of every page of a PDF whose visible text holds no payment line
//   (fonts that map to no letters print fine but read as nonsense);
// - OCR at 300 dpi of a document whose payment line OCR at 200 dpi missed
//   (small print on receipts).
//
// pdf.js, tesseract.js (with its English model) and pdf-lib load from
// jsDelivr on first use, about 9 MB, then come from the browser's cache.
// What OCR read is kept for the page's lifetime (by the document's hash),
// so a statement on many expenses is read once; where the rows are is kept
// in the browser (see kept rows), so a scan opened again isn't read again.
// A marked PDF opens at its first mark.

import { rowsOf, locate } from './marks-model.js'
import { normalizeImage } from './normalize-image.js'
import { PDF_LIB, openAt } from './combine-pdf.js'

const PDFJS_DIST = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.5.136'
const PDFJS = `${PDFJS_DIST}/build/pdf.min.mjs`
const PDFJS_WORKER = `${PDFJS_DIST}/build/pdf.worker.min.mjs`
const TESSERACT = 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.esm.min.js'
const TESSERACT_PATHS = {
  workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/worker.min.js',
  corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@7.0.0',
  langPath: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int',
}
const DPI = 200        // OCR reads print well at 200 dpi
const DPI_SMALL = 300  // and small print better at 300
const PAD = [2, 1.5]   // a mark reaches this far past its words (points), across and up and down
const OPEN_ABOVE = 36  // a marked PDF opens with its first mark this far below the top (points)

// The look, in pdf-lib's and a canvas's terms.
const YELLOW = [1, 0.9, 0.2]
const RED = [0.85, 0.1, 0.1]
const FRAME = 0.75     // points

// One of each library, loaded once; a failed load is tried again next time.
const once = (load) => {
  let p = null
  return () => {
    if (!p) { p = load(); p.catch(() => { p = null }) }
    return p
  }
}
const pdfjs = once(async () => {
  const lib = await import(PDFJS)
  // A module worker from a blob: a worker script must come from the page's own origin.
  const src = URL.createObjectURL(new Blob([`import '${PDFJS_WORKER}'`], { type: 'text/javascript' }))
  lib.GlobalWorkerOptions.workerPort = new Worker(src, { type: 'module' })
  return lib
})
// OCR reads pages side by side, a worker to a core but the one this page
// runs on, up to 3. The first worker fetches the English model; tesseract.js
// keeps it in the browser (IndexedDB), where the others find it.
const OCR_WORKERS = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1))
const ocr = once(async () => {
  const { createScheduler, createWorker } = (await import(TESSERACT)).default
  const scheduler = createScheduler()
  scheduler.addWorker(await createWorker('eng', 1, TESSERACT_PATHS))
  for (let i = 1; i < OCR_WORKERS; i++) {
    createWorker('eng', 1, TESSERACT_PATHS).then((w) => scheduler.addWorker(w), () => {})
  }
  return scheduler
})
const pdfLib = once(() => import(PDF_LIB))

// What OCR read: key → a promise of words.
const read = new Map()
function remember(key, words) {
  if (!read.has(key)) {
    const p = words()
    read.set(key, p)
    p.catch(() => read.delete(key))
  }
  return read.get(key)
}

// OCR of an image (a canvas or a bitmap) as words on `page`, in units of
// `scale` pixels.
async function ocrWords(image, page, scale) {
  const { data } = await (await ocr()).addJob('recognize', image, {}, { blocks: true })
  return data.blocks.flatMap((b) => b.paragraphs.flatMap((p) => p.lines.flatMap((l) => l.words)))
    .map((w) => ({ page, text: w.text, box: [w.bbox.x0 / scale, w.bbox.y0 / scale, w.bbox.x1 / scale, w.bbox.y1 / scale] }))
}

// ── PDFs ──────────────────────────────────────────────────────────────────

// pdf.js's operators that draw text.
const SHOWS = (OPS) => new Set([OPS.showText, OPS.showSpacedText, OPS.nextLineShowText, OPS.nextLineSetSpacingShowText])

// Whether a page draws any text a reader can see (rendering mode 3 draws
// none: a scanner's OCR under its scan).
async function drawsText(lib, page) {
  const { fnArray, argsArray } = await page.getOperatorList()
  const shows = SHOWS(lib.OPS)
  let mode = 0
  for (let i = 0; i < fnArray.length; i++) {
    if (fnArray[i] === lib.OPS.setTextRenderingMode) mode = argsArray[i][0]
    else if (shows.has(fnArray[i]) && (mode & 3) !== 3) return true
  }
  return false
}

// A page's own text as words, in the units of its viewport at scale 1.
async function textWords(lib, page, n, viewport) {
  const words = []
  for (const it of (await page.getTextContent()).items) {
    if (!it.str?.trim()) continue
    const tx = lib.Util.transform(viewport.transform, it.transform)
    const h = Math.hypot(tx[2], tx[3])
    if (Math.abs(tx[1]) > h / 1000) continue   // turned text: never a line to mark
    words.push({ page: n, text: it.str, box: [tx[4], tx[5] - h * 0.85, tx[4] + it.width, tx[5] + h * 0.2] })
  }
  return words
}

// A page rendered at `dpi` and read by OCR, in the units of its viewport at scale 1.
async function pageOcr(page, n, dpi) {
  const scale = dpi / 72
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  try {
    await page.render({ canvasContext: ctx, viewport }).promise
    return await ocrWords(canvas, n, scale)
  } finally {
    canvas.width = canvas.height = 0
  }
}

// A PDF's pages ({ n, page, viewport }) and the readings of its words, in
// the order they are tried (see the head of this file). ocrOf(p, dpi)
// reads one of the pages by OCR, as words in the units of its viewport at
// scale 1: pageOcr() here; scripts/regress_marks.ts brings its own.
export async function pdfReadings(lib, doc, ocrOf) {
  const pages = []
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n)
    pages.push({ n, page, viewport: page.getViewport({ scale: 1 }), text: await drawsText(lib, page) })
  }
  const all = (read) => async () => (await Promise.all(pages.map(read))).flat()
  const readings = [
    all((p) => (p.text ? textWords(lib, p.page, p.n, p.viewport) : ocrOf(p, DPI))),
    pages.some((p) => p.text) && all((p) => ocrOf(p, DPI)),
    all((p) => ocrOf(p, DPI_SMALL)),
  ].filter(Boolean)
  return { pages, readings }
}

// Each visit located in the first reading that finds its payment line; a
// later reading is made only for the visits still missing one.
export async function locateAll(readings, visits) {
  const found = visits.map(() => ({ marks: [], found: { paid: false } }))
  for (const words of readings) {
    const rows = rowsOf(await words())
    visits.forEach((v, i) => { if (!found[i].found.paid) found[i] = locate(rows, v) })
    if (found.every((f) => f.found.paid)) break
  }
  return found
}

// Where a PDF's rows are: { rects: [{ page, rect, kinds }], found, open },
// each rect [x, y, width, height] in the page's own points (pdf-lib's
// terms); found, per visit, whether its payment line is marked; open
// { page, top }, where the copy opens: at the first date of service marked
// (its visit's rows are there, while an amount can be printed in a summary
// too), else the first mark; null with none.
async function pdfRows(bytes, sha256, visits) {
  const lib = await pdfjs()
  // pdf.js takes the buffer it is given. Fonts a PDF names but doesn't
  // carry come from pdf.js's own font data; no font program runs as code.
  const doc = await lib.getDocument({
    data: bytes.slice(), isEvalSupported: false,
    standardFontDataUrl: `${PDFJS_DIST}/standard_fonts/`, cMapUrl: `${PDFJS_DIST}/cmaps/`, cMapPacked: true,
  }).promise
  try {
    const ocrOf = (p, dpi) => remember(`${sha256}:${p.n}:${dpi}`, () => pageOcr(p.page, p.n, dpi))
    const { pages, readings } = await pdfReadings(lib, doc, ocrOf)
    const found = await locateAll(readings, visits)
    const rects = found.flatMap((f) => f.marks).map((m) => {
      const { viewport } = pages[m.page - 1]
      const [x0, y0] = viewport.convertToPdfPoint(m.box[0] - PAD[0], m.box[1] - PAD[1])
      const [x1, y1] = viewport.convertToPdfPoint(m.box[2] + PAD[0], m.box[3] + PAD[1])
      return { page: m.page, rect: [Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)], kinds: m.kinds }
    })
    // The first of some marks: on the first page marked, the highest there.
    const firstOf = (rs) => rs.reduce((a, b) => (!a || b.page < a.page || (b.page === a.page && b.rect[1] > a.rect[1]) ? b : a), null)
    const at = firstOf(rects.filter((r) => r.kinds.includes('date'))) ?? firstOf(rects)
    const open = at && { page: at.page, top: at.rect[1] + at.rect[3] + OPEN_ABOVE }
    return { rects, found: found.map((f) => f.found.paid), open }
  } finally {
    await doc.destroy()
  }
}

// The PDF with its rows marked, opening at the first mark.
async function drawPdf(bytes, { rects, open }) {
  const { PDFDocument, PDFName, rgb, BlendMode } = await pdfLib()
  const pdf = await PDFDocument.load(bytes)
  for (const { page, rect: [x, y, width, height] } of rects) {
    pdf.getPage(page - 1).drawRectangle({ x, y, width, height,
      color: rgb(...YELLOW), borderColor: rgb(...RED), borderWidth: FRAME, blendMode: BlendMode.Multiply })
  }
  if (open) openAt(pdf, PDFName, open)
  return pdf.save()
}

// ── photos ────────────────────────────────────────────────────────────────

// A photo upright as a bitmap; to be closed.
async function uprightBitmap(bytes, mime) {
  const upright = await normalizeImage(bytes, mime)
  return createImageBitmap(new Blob([upright.bytes], { type: 'image/jpeg' }))
}

// Where a photo's rows are, as for a PDF, each rect in the upright photo's
// pixels. OCR reads it as it is, then once more at 1.5 times its size for
// small print.
async function imageRows(bitmap, sha256, visits) {
  const scaled = (k) => () => remember(`${sha256}:${k}`, async () => {
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * k)
    canvas.height = Math.round(bitmap.height * k)
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    try { return await ocrWords(canvas, 1, k) } finally { canvas.width = canvas.height = 0 }
  })
  const found = await locateAll([scaled(1), scaled(DPI_SMALL / DPI)], visits)
  // The pad in the photo's pixels: points at the size it would print on a Letter page.
  const unit = Math.max(bitmap.width, bitmap.height) / 792
  const rects = found.flatMap((f) => f.marks).map((m) => ({ page: 1, rect: [m.box[0] - PAD[0] * unit,
    m.box[1] - PAD[1] * unit, m.box[2] - m.box[0] + 2 * PAD[0] * unit, m.box[3] - m.box[1] + 2 * PAD[1] * unit] }))
  return { rects, found: found.map((f) => f.found.paid), open: null }
}

// The photo with its rows marked, as a JPEG.
async function drawImage(bitmap, { rects }) {
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const ctx = canvas.getContext('2d')
  ctx.drawImage(bitmap, 0, 0)
  const unit = Math.max(bitmap.width, bitmap.height) / 792
  for (const { rect: [x, y, w, h] } of rects) {
    ctx.globalCompositeOperation = 'multiply'
    ctx.fillStyle = `rgb(${YELLOW.map((c) => c * 255).join(',')})`
    ctx.fillRect(x, y, w, h)
    ctx.globalCompositeOperation = 'source-over'
    ctx.strokeStyle = `rgb(${RED.map((c) => c * 255).join(',')})`
    ctx.lineWidth = FRAME * unit
    ctx.strokeRect(x, y, w, h)
  }
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92))
  canvas.width = canvas.height = 0
  return new Uint8Array(await blob.arrayBuffer())
}

// ── kept rows ─────────────────────────────────────────────────────────────

// Where a document's rows are, kept in this browser (IndexedDB) by the
// document's hash, what was looked for and ROWS_VERSION, so a scan is read
// by OCR once, not each time it is opened. Only positions are kept, never
// what the document says. A browser that keeps nothing finds them again.
const ROWS_VERSION = '2026-10-17.2'   // move it with any change to how rows are found
const store = once(() => new Promise((resolve, reject) => {
  const req = indexedDB.open('medical-marks', 1)
  req.onupgradeneeded = () => req.result.createObjectStore('rows')
  req.onsuccess = () => resolve(req.result)
  req.onerror = () => reject(req.error)
}))
const asPromise = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error) })
async function keptRows(key) {
  try {
    return (await asPromise((await store()).transaction('rows').objectStore('rows').get(key))) ?? null
  } catch {
    return null
  }
}
async function keepRows(key, rows) {
  try {
    await asPromise((await store()).transaction('rows', 'readwrite').objectStore('rows').put(rows, key))
  } catch { /* not kept: found again next time */ }
}
async function rowsKey(sha256, visits) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(visits)))
  return `${ROWS_VERSION}:${sha256}:${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')}`
}

// ── the copy ──────────────────────────────────────────────────────────────

// A document as a browser shows it ({ bytes, mime, sha256 }: a PDF, or a
// photo; a HEIC photo as its JPEG copy) with the rows of `visits` (as
// marks-model.js locate() takes them) marked: { bytes, mime, marked, open },
// marked how many of the visits had their payment line marked, open
// { page, top } where a marked PDF opens (its first mark), else null. With
// none marked, the document comes back as it is. Throws when the document
// can't be read (an encrypted or damaged PDF) or a library doesn't load.
export async function markedCopy({ bytes, mime, sha256 }, visits) {
  if (!visits.length) return { bytes, mime, marked: 0, open: null }
  const pdf = mime === 'application/pdf'
  const key = await rowsKey(sha256, visits)
  const bitmap = pdf ? null : await uprightBitmap(bytes, mime)
  try {
    let rows = await keptRows(key)
    if (!rows) {
      rows = pdf ? await pdfRows(bytes, sha256, visits) : await imageRows(bitmap, sha256, visits)
      await keepRows(key, rows)
    }
    if (!rows.rects.length) return { bytes, mime, marked: 0, open: null }
    return {
      bytes: pdf ? await drawPdf(bytes, rows) : await drawImage(bitmap, rows),
      mime: pdf ? 'application/pdf' : 'image/jpeg',
      marked: rows.found.filter(Boolean).length,
      open: rows.open,
    }
  } finally {
    bitmap?.close()
  }
}
