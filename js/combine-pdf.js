// Several receipts as one PDF, made in the browser to read them in one go.
// It is never stored: each original stays the record.
//
// pdf-lib is loaded on first use. A PDF's pages are copied as they are,
// each keeping its rotation. A photo goes through normalizeImage, so it is
// upright whatever its EXIF says (a HEIC arrives as its readable JPEG),
// and gets a page of its own.

import { normalizeImage } from './normalize-image.js'

export const PDF_LIB = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm'
const LETTER = [612, 792]   // US Letter, in points
const MARGIN = 18           // a quarter inch on every side

// Where a width × height photo goes: a Letter page turned the photo's way
// (portrait or landscape), the photo scaled to fit inside the margin and
// centred.
export function placeImage(width, height) {
  const page = width > height ? [LETTER[1], LETTER[0]] : LETTER
  const scale = Math.min((page[0] - 2 * MARGIN) / width, (page[1] - 2 * MARGIN) / height)
  const w = width * scale, h = height * scale
  return { page, x: (page[0] - w) / 2, y: (page[1] - h) / 2, width: w, height: h }
}

// [{ bytes, mime, name, open }] in order → { bytes, pages, skipped, open }:
// the PDF, its page count, the names of the PDFs left out because they are
// encrypted or can't be read (never combined as garbage), and the page it
// opens at: where the first file with an `open` ({ page, top }: a page of
// its own and a height there) lands, or null.
export async function combinePdf(files) {
  const { PDFDocument, PDFName } = await import(PDF_LIB)
  const out = await PDFDocument.create()
  const skipped = []
  let open = null
  for (const f of files) {
    const start = out.getPageCount()
    if (f.mime === 'application/pdf') {
      let pages
      try {
        const src = await PDFDocument.load(f.bytes)
        pages = await out.copyPages(src, src.getPageIndices())
      } catch {
        skipped.push(f.name)
        continue
      }
      for (const p of pages) out.addPage(p)
    } else {
      const img = await normalizeImage(f.bytes, f.mime)
      const at = placeImage(img.width, img.height)
      out.addPage(at.page).drawImage(await out.embedJpg(img.bytes), { x: at.x, y: at.y, width: at.width, height: at.height })
    }
    if (!open && f.open) open = { page: start + f.open.page, top: f.open.top }
  }
  if (open) openAt(out, PDFName, open)
  return { bytes: await out.save(), pages: out.getPageCount(), skipped, open: open?.page ?? null }
}

// A PDF (pdf-lib's) opening at a page, scrolled to `top` (points from the
// page's foot).
export function openAt(pdf, PDFName, { page, top }) {
  pdf.catalog.set(PDFName.of('OpenAction'), pdf.context.obj([pdf.getPage(page - 1).ref, PDFName.of('XYZ'), null, top, null]))
}
