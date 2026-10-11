// A photo as an upright JPEG, made in the browser: to show a HEIC photo
// (only Safari can), to read a photo too big for extract-document, and to
// put a photo on a PDF page.
//
// The browser decodes JPEG and PNG itself, and createImageBitmap turns the
// photo by its EXIF orientation, so the result is upright. A HEIC photo
// the browser can't decode is decoded by heic-to (libheif, which applies
// the photo's rotation the same way), loaded only when one comes along.
// The pixels go onto a white canvas, so a transparent PNG comes out on
// white, not black.

const HEIC_TO = 'https://cdn.jsdelivr.net/npm/heic-to@1.6.5/dist/csp/heic-to.js'
const HEIF = ['image/heic', 'image/heif']

// width × height made to fit maxEdge on its longer side, never made larger.
export function fitSize(width, height, maxEdge) {
  const scale = maxEdge ? Math.min(1, maxEdge / Math.max(width, height)) : 1
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

// The next try when a JPEG came out over maxBytes: a lower quality first,
// down to 0.7, then a fifth smaller each time.
export function smaller({ width, height, quality }) {
  if (quality > 0.7) return { width, height, quality: Math.max(0.7, Math.round((quality - 0.1) * 100) / 100) }
  return { ...fitSize(width, height, Math.floor(Math.max(width, height) * 0.8)), quality }
}

async function decode(input, mime) {
  const blob = input instanceof Blob ? input : new Blob([input], { type: mime })
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' })
  } catch {
    if (!HEIF.includes(mime)) throw new Error("This image can't be opened.")
  }
  let heicTo
  try {
    ({ heicTo } = await import(HEIC_TO))
  } catch {
    throw new Error("Couldn't load what opens HEIC photos. Check the connection and try again.")
  }
  try {
    return await heicTo({ blob, type: 'bitmap' })
  } catch {
    throw new Error("This HEIC photo can't be opened.")
  }
}

// bytes (or a Blob) of a JPEG, PNG or HEIC photo → { bytes, mime:
// 'image/jpeg', width, height }: upright, scaled to fit maxEdge when given,
// and stepped down until it is at most maxBytes when given.
export async function normalizeImage(input, mime, { maxEdge, maxBytes, quality = 0.92 } = {}) {
  const bitmap = await decode(input, mime)
  try {
    let at = { ...fitSize(bitmap.width, bitmap.height, maxEdge), quality }
    for (;;) {
      const canvas = new OffscreenCanvas(at.width, at.height)
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = 'white'
      ctx.fillRect(0, 0, at.width, at.height)
      ctx.drawImage(bitmap, 0, 0, at.width, at.height)
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: at.quality })
      if (!maxBytes || blob.size <= maxBytes) {
        return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/jpeg', width: at.width, height: at.height }
      }
      at = smaller(at)
    }
  } finally {
    bitmap.close()
  }
}

// A photo's upright width and height.
export async function imageSize(input, mime) {
  const bitmap = await decode(input, mime)
  const { width, height } = bitmap
  bitmap.close()
  return { width, height }
}
