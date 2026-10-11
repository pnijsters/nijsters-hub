// Several receipts as one PDF, made in the browser to read them in one go.
// It is never stored: each original stays the record.
//
// pdf-lib is loaded on first use. A PDF's pages are copied as they are,
// each keeping its rotation. A photo goes through normalizeImage, so it is
// upright whatever its EXIF says (a HEIC arrives as its readable JPEG),
// and gets a page of its own.

import { normalizeImage } from './normalize-image.js'

const PDF_LIB = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm'
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

// [{ bytes, mime, name }] in order → { bytes, pages, skipped }: the PDF,
// its page count, and the names of the PDFs left out because they are
// encrypted or can't be read (never combined as garbage).
export async function combinePdf(files) {
  const { PDFDocument } = await import(PDF_LIB)
  const out = await PDFDocument.create()
  const skipped = []
  for (const f of files) {
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
  }
  return { bytes: await out.save(), pages: out.getPageCount(), skipped }
}
