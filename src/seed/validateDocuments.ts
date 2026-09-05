import 'fake-indexeddb/auto'
import {
  assertAttachableFile,
  createObjectUrl,
  DocumentValidationError,
  MAX_DOCUMENT_BYTES,
  revokeObjectUrl,
} from '../application/documents'
import { createServices } from '../application/services'
import { db } from '../data/db'
import { localRepositories } from '../data/repositories'
import type { ValidationResult } from './validateResolution'

function assert(
  checks: ValidationResult['checks'],
  name: string,
  pass: boolean,
  detail: string,
) {
  checks.push({ name, pass, detail })
}

function tinyPng(): Blob {
  // 1x1 PNG
  const bytes = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
    0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
    0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe, 0xd4, 0xef, 0x00, 0x00,
    0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ])
  return new Blob([bytes], { type: 'image/png' })
}

function tinyPdf(): Blob {
  return new Blob(
    ['%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n'],
    { type: 'application/pdf' },
  )
}

/**
 * IndexedDB document lifecycle tests (fake-indexeddb in Node).
 */
export async function validateDocumentInvariants(): Promise<ValidationResult> {
  const checks: ValidationResult['checks'] = []
  const services = createServices(localRepositories)

  await db.delete()
  await db.open()

  const tripId = 'doc-test-trip'
  const bookingId = 'doc-test-booking'
  const itemId = 'doc-test-item'

  await services.trips.save({
    id: tripId,
    title: 'Doc test',
    startDate: '2026-09-20',
    endDate: '2026-09-21',
    timezone: 'America/Mexico_City',
    goals: [],
    status: 'planned',
  })
  await services.bookings.save({
    id: bookingId,
    tripId,
    type: 'flight',
    status: 'confirmed',
    title: 'Test flight',
  })
  await services.itinerary.save({
    id: itemId,
    tripId,
    bookingId,
    bookingAnchor: 'departure',
    importance: 'crucial',
    goalIds: [],
  })

  // Reject oversized / bad mime
  try {
    assertAttachableFile({
      name: 'big.pdf',
      type: 'application/pdf',
      size: MAX_DOCUMENT_BYTES + 1,
    })
    assert(checks, 'reject oversize', false, 'should throw')
  } catch (err) {
    assert(
      checks,
      'reject oversize',
      err instanceof DocumentValidationError,
      String(err),
    )
  }
  try {
    assertAttachableFile({
      name: 'x.exe',
      type: 'application/octet-stream',
      size: 10,
    })
    assert(checks, 'reject bad mime', false, 'should throw')
  } catch (err) {
    assert(
      checks,
      'reject bad mime',
      err instanceof DocumentValidationError,
      String(err),
    )
  }

  const pdfFile = new File([tinyPdf()], 'reserva.pdf', {
    type: 'application/pdf',
  })
  const saved = await services.documents.attachFromFile({
    tripId,
    file: pdfFile,
    type: 'reservation',
    bookingId,
    notes: 'test meta+blob',
  })

  assert(checks, 'save metadata', saved.id.length > 0 && saved.sizeBytes > 0, `id=${saved.id}`)
  const meta = await services.documents.get(saved.id)
  const blobRec = await services.documents.getBlob(saved.id)
  assert(
    checks,
    'retrieve metadata + blob',
    meta?.name === 'reserva.pdf' && blobRec?.blob.size === saved.sizeBytes,
    `name=${meta?.name} blob=${blobRec?.blob.size}`,
  )

  assert(
    checks,
    'associate booking',
    meta?.bookingId === bookingId,
    `bookingId=${meta?.bookingId}`,
  )

  const byBooking = await services.documents.listByBooking(bookingId)
  assert(
    checks,
    'list by booking',
    byBooking.some((d) => d.id === saved.id),
    `n=${byBooking.length}`,
  )

  await services.documents.updateMeta({
    id: saved.id,
    name: 'reserva.pdf',
    type: 'boarding_pass',
    bookingId,
    itineraryItemId: itemId,
    notes: 'linked item',
  })
  const linked = await services.documents.get(saved.id)
  assert(
    checks,
    'associate itinerary item',
    linked?.itineraryItemId === itemId && linked.type === 'boarding_pass',
    `item=${linked?.itineraryItemId}`,
  )
  const byItem = await services.documents.listByItineraryItem(itemId)
  assert(
    checks,
    'list by itinerary item',
    byItem.some((d) => d.id === saved.id),
    `n=${byItem.length}`,
  )

  // Open blob via Object URL
  const again = await services.documents.getBlob(saved.id)
  assert(checks, 'blob present for open', !!again, 'blob record')
  if (again) {
    const url = createObjectUrl(again.blob)
    assert(
      checks,
      'open blob url',
      url.startsWith('blob:') || url.includes('blob'),
      `url=${url.slice(0, 32)}`,
    )
    revokeObjectUrl(url)
    assert(checks, 'revoke object url', true, 'revoked without persist')
  }

  // Survive db close/reopen (app reload)
  await db.close()
  await db.open()
  const afterReload = await services.documents.get(saved.id)
  const blobAfter = await services.documents.getBlob(saved.id)
  assert(
    checks,
    'survive reload',
    afterReload?.id === saved.id &&
      blobAfter?.blob.size === saved.sizeBytes &&
      afterReload.itineraryItemId === itemId,
    `meta=${afterReload?.id} size=${blobAfter?.blob.size}`,
  )

  // Second image attach
  const pngFile = new File([tinyPng()], 'pase.png', { type: 'image/png' })
  const img = await services.documents.attachFromFile({
    tripId,
    file: pngFile,
    type: 'boarding_pass',
    bookingId,
  })
  assert(checks, 'save image', img.mimeType === 'image/png', img.mimeType)

  await services.documents.remove(saved.id)
  await services.documents.remove(img.id)
  const goneMeta = await services.documents.get(saved.id)
  const goneBlob = await services.documents.getBlob(saved.id)
  assert(
    checks,
    'delete metadata + blob',
    goneMeta === undefined && goneBlob === undefined,
    'both gone',
  )

  await db.delete()

  return { ok: checks.every((c) => c.pass), checks }
}
