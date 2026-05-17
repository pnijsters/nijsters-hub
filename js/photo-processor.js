// Client-side image processing pipeline.
//
// Re-encodes each uploaded photo to web-friendly WebP at two sizes, preserving
// aspect ratio. The whole point of routing through Canvas is that the output
// is built from raw pixel data — EXIF, ICC, color profiles, and any other
// metadata or embedded payload that came with the original file are dropped
// in transit. That's the primary defense against malicious uploads.
//
// Validation here is *user-facing*: surface a clear error before the user
// wastes time uploading. The authoritative checks live on the Supabase
// Storage bucket (allowed_mime_types, file_size_limit) and on RLS policies
// — those run regardless of what this code does.

const VARIANTS = {
  full:  { maxEdge: 2000, quality: 0.82 },
  thumb: { maxEdge: 600,  quality: 0.78 },
}

const MAX_FILE_BYTES = 30 * 1024 * 1024 // 30 MB input cap (output will be ≪)
const MAX_BATCH = 20

export const limits = Object.freeze({ MAX_FILE_BYTES, MAX_BATCH })

export function formatBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function validateInput(file) {
  if (!file || file.size === 0) throw new Error('Empty file')
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`Too large (${formatBytes(file.size)}). Max is ${formatBytes(MAX_FILE_BYTES)}.`)
  }
  // file.type is browser-reported MIME — easy to spoof. We rely on decode
  // succeeding in the next step for the real "is this actually an image" check.
  if (!file.type || !file.type.startsWith('image/')) {
    throw new Error('Not an image file')
  }
}

async function decodeFile(file) {
  // createImageBitmap natively decodes JPEG/PNG/WebP/GIF/AVIF in modern browsers.
  // HEIC works only in Safari. If decoding fails for any reason — corrupt file,
  // unsupported format, or a payload masquerading as an image — we abort here
  // and the raw bytes never reach the upload step.
  try {
    return await createImageBitmap(file)
  } catch {
    throw new Error('Could not decode image. HEIC files only decode in Safari; convert to JPEG or PNG first.')
  }
}

function computeTargetSize(srcW, srcH, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(srcW, srcH))
  return {
    w: Math.max(1, Math.round(srcW * scale)),
    h: Math.max(1, Math.round(srcH * scale)),
  }
}

// Multi-step downscale: halve dimensions iteratively, then a final pass to
// exact size. Single-pass drawImage from 4000px to 600px produces noticeable
// aliasing/moire on detailed photos. Halving each step keeps the resampler in
// its sweet spot and the visible result is markedly cleaner.
function downscaleHighQuality(bitmap, targetW, targetH) {
  let curW = bitmap.width, curH = bitmap.height
  let canvas = new OffscreenCanvas(curW, curH)
  let ctx = canvas.getContext('2d')
  ctx.drawImage(bitmap, 0, 0)

  while (curW * 0.5 > targetW && curH * 0.5 > targetH) {
    const nextW = Math.round(curW / 2)
    const nextH = Math.round(curH / 2)
    const next = new OffscreenCanvas(nextW, nextH)
    const nctx = next.getContext('2d')
    nctx.imageSmoothingEnabled = true
    nctx.imageSmoothingQuality = 'high'
    nctx.drawImage(canvas, 0, 0, nextW, nextH)
    canvas = next
    curW = nextW; curH = nextH
  }

  if (curW !== targetW || curH !== targetH) {
    const final = new OffscreenCanvas(targetW, targetH)
    const fctx = final.getContext('2d')
    fctx.imageSmoothingEnabled = true
    fctx.imageSmoothingQuality = 'high'
    fctx.drawImage(canvas, 0, 0, targetW, targetH)
    canvas = final
  }
  return canvas
}

export async function processOne(file, { onPhase } = {}) {
  validateInput(file)
  const report = (p) => onPhase && onPhase(p)

  report('decoding')
  const bitmap = await decodeFile(file)
  const variants = {}
  const original = { w: bitmap.width, h: bitmap.height }

  try {
    for (const [name, cfg] of Object.entries(VARIANTS)) {
      report(`resizing ${name}`)
      const { w, h } = computeTargetSize(bitmap.width, bitmap.height, cfg.maxEdge)
      const canvas = downscaleHighQuality(bitmap, w, h)
      report(`encoding ${name}`)
      const blob = await canvas.convertToBlob({ type: 'image/webp', quality: cfg.quality })
      variants[name] = { blob, width: w, height: h }
    }
  } finally {
    bitmap.close?.()
  }

  return { variants, original }
}

// Generates an upload identity the user cannot influence. The original filename
// is dropped on the floor — only a random UUID. No path traversal vectors, no
// XSS-via-filename. Storage paths become `full/{id}.webp` and `thumb/{id}.webp`
// — flat namespace per variant so listing for the rotator is one call.
export function newPhotoId() {
  return crypto.randomUUID()
}
