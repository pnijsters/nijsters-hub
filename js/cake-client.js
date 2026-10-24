// The data surface for cake.html: Ellah's cake.boutique content in the cake
// schema, its photos in the cake-photos bucket, the preview, Publish, and the
// inquiries the quote form sends (their photos in the private bucket
// cake-inquiries).
//
// Every call runs as the signed-in member; the database refuses anyone but
// a parent or an admin at aal2, reads included. Photos are made by
// js/photo-processor.js (full/ and thumb/ WebP, no EXIF) and stored before
// their row, which the database checks. A photo is deleted row first, then
// files through the Storage API, so their bytes go too; while the live site
// shows a photo, the database keeps both.

import { supabase } from './supabase-client.js'
import { processOne, newPhotoId } from './photo-processor.js'
import { normalizeImage } from './normalize-image.js'

// The published site.
export const SITE = 'https://cake.boutique/'
export const PAGES = [
  ['index.html', 'Home'], ['weddings.html', 'Weddings'], ['celebration-cakes.html', 'Celebration cakes'],
  ['portfolio.html', 'Portfolio'], ['about.html', 'About'], ['request-a-quote.html', 'Request a quote'],
  ['terms.html', 'Terms and conditions'],
]

const BUCKET = 'cake-photos'
const INQUIRIES = 'cake-inquiries'
const cake = () => supabase.schema('cake')

function check({ data, error }, what) {
  if (error) throw new Error(`Couldn't ${what}. ${error.message}`)
  return data
}

// Everything the editor shows, in gallery order.
export async function loadAll() {
  const [details, places, photos, testimonials, published, inquiries] = await Promise.all([
    cake().from('details').select('*').single(),
    cake().from('places').select('place, photo_id'),
    cake().from('photos').select('*').order('position').order('created_at').order('id'),
    cake().from('testimonials').select('*').order('position').order('created_at').order('id'),
    cake().from('published').select('hash, published_at, content').maybeSingle(),
    loadInquiries(),
  ])
  return {
    details: check(details, 'load the details'),
    places: Object.fromEntries(check(places, 'load the photo spots').map(p => [p.place, p.photo_id])),
    photos: check(photos, 'load the photos'),
    testimonials: check(testimonials, 'load the testimonials'),
    published: check(published, 'load what is published'),
    inquiries,
  }
}

// What the pages are filled with now, and its hash: what Publish would put live.
export async function siteContent() {
  return check(await cake().rpc('site_content').single(), 'read the site content')
}

export async function saveDetails(patch) {
  return check(await cake().from('details').update(patch).eq('id', true).select().single(), 'save')
}

export function photoUrl(id, variant = 'thumb') {
  return supabase.storage.from(BUCKET).getPublicUrl(`${variant}/${id}.webp`).data.publicUrl
}

// The bucket's public address, which the filled pages link.
export const photoBase = () => photoUrl('x', 'full').replace(/\/full\/x\.webp$/, '')

// Only Safari opens a HEIC photo itself; elsewhere it becomes a JPEG first.
async function openable(file) {
  const heic = /^image\/hei[cf]$/i.test(file.type) || /\.hei[cf]$/i.test(file.name)
  if (!heic) return file
  try {
    (await createImageBitmap(file)).close()
    return file.type ? file : new File([file], file.name, { type: 'image/heic' })
  } catch {
    const { bytes } = await normalizeImage(file, file.type || 'image/heic')
    return new File([bytes], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' })
  }
}

// One photo: made into its two files, stored, then its row. `position`
// puts it first in every gallery. onPhase gets 'preparing' and 'uploading'.
export async function addPhoto(file, position, onPhase) {
  onPhase?.('preparing')
  const { variants } = await processOne(await openable(file))
  const id = newPhotoId()
  onPhase?.('uploading')
  for (const v of ['full', 'thumb']) {
    const { error } = await supabase.storage.from(BUCKET).upload(`${v}/${id}.webp`, variants[v].blob, {
      contentType: 'image/webp', upsert: false, cacheControl: '31536000',
    })
    if (error) {
      await removeFiles(id).catch(() => {})
      throw new Error(`Couldn't upload it. ${error.message}`)
    }
  }
  const { data, error } = await cake().from('photos')
    .insert({ id, width: variants.full.width, height: variants.full.height, position }).select().single()
  if (error) {
    await removeFiles(id).catch(() => {})
    throw new Error(`Couldn't save it. ${error.message}`)
  }
  return data
}

export async function savePhoto(id, patch) {
  return check(await cake().from('photos').update(patch).eq('id', id).select().single(), 'save the photo')
}

// Deleted for good. The database refuses while the live site shows it.
export async function deletePhoto(id) {
  const rows = check(await cake().from('photos').delete().eq('id', id).select('id'), 'delete the photo')
  if (!rows.length) throw new Error('Your live site still shows this photo. Take it off every page and publish first.')
  const files = await removeFiles(id)
  if (files !== 2) throw new Error(`The photo is deleted, but ${2 - files} of its files couldn't be.`)
}

async function removeFiles(id) {
  const { data, error } = await supabase.storage.from(BUCKET).remove([`full/${id}.webp`, `thumb/${id}.webp`])
  if (error) throw new Error(error.message)
  return data.length
}

export async function setPlace(place, photoId) {
  return check(await cake().from('places').update({ photo_id: photoId }).eq('place', place).select().single(),
    'change the photo')
}

export async function orderPhotos(ids) {
  check(await cake().rpc('order_photos', { p_ids: ids }), 'move the photo')
}

export async function saveTestimonial(id, fields) {
  const q = id ? cake().from('testimonials').update(fields).eq('id', id) : cake().from('testimonials').insert(fields)
  return check(await q.select().single(), 'save the testimonial')
}

export async function deleteTestimonial(id) {
  check(await cake().from('testimonials').delete().eq('id', id), 'delete the testimonial')
}

export async function orderTestimonials(ids) {
  check(await cake().rpc('order_testimonials', { p_ids: ids }), 'move the testimonial')
}

// Publish: what is saved becomes what the site shows. Returns the hash the
// site's version.json carries once the build is live.
export async function publish() {
  const { data, error } = await supabase.functions.invoke('cake-publish')
  if (!error) return data.hash
  let said = {}
  try { said = await error.context.json() } catch {}
  if (said.hash) throw new Error('Your changes are published, but the site build did not start. Press Publish again.')
  throw new Error(`Couldn't publish. ${said.error || error.message}`)
}

// The inquiries, newest first.
export async function loadInquiries() {
  return check(await cake().from('inquiries').select('*').order('created_at', { ascending: false }), 'load the inquiries')
}

const inquiryPaths = (q) => Array.from({ length: q.photos }, (_, i) => `${q.id}/${i + 1}.webp`)

// Links to an inquiry's photos, in order, that work for an hour.
export async function inquiryPhotos(q) {
  if (!q.photos) return []
  const { data, error } = await supabase.storage.from(INQUIRIES).createSignedUrls(inquiryPaths(q), 3600)
  if (error) throw new Error(`Couldn't load the photos. ${error.message}`)
  return data.map(d => d.signedUrl)
}

export async function setReplied(id, replied) {
  return check(await cake().from('inquiries').update({ replied_at: replied ? new Date().toISOString() : null })
    .eq('id', id).select().single(), 'save')
}

// Deleted for good: its photos first, through the Storage API so their bytes
// go too, then the row. While a photo is left, the inquiry stays, so trying
// again finishes the job.
export async function deleteInquiry(q) {
  if (q.photos) {
    const { error } = await supabase.storage.from(INQUIRIES).remove(inquiryPaths(q))
    if (error) throw new Error(`Couldn't delete its photos. ${error.message}`)
    const { data: left, error: listed } = await supabase.storage.from(INQUIRIES).list(q.id)
    if (listed) throw new Error(`Couldn't check its photos. ${listed.message}`)
    if (left.length) throw new Error("Its photos couldn't all be deleted, so the inquiry is kept. Try again.")
  }
  const rows = check(await cake().from('inquiries').delete().eq('id', q.id).select('id'), 'delete the inquiry')
  if (!rows.length) throw new Error("The inquiry couldn't be deleted.")
}

// The hash of what the site shows now, or null when it can't be read.
export async function liveHash() {
  try {
    const res = await fetch(`${SITE}version.json`, { cache: 'no-store' })
    return res.ok ? (await res.json()).content ?? null : null
  } catch {
    return null
  }
}

// A page of the published site as HTML, for the preview to fill again.
export async function pageHtml(page) {
  const res = await fetch(SITE + page, { cache: 'no-store' })
  if (!res.ok) throw new Error(`Couldn't load the page (${res.status}).`)
  return res.text()
}
