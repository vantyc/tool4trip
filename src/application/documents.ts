import type { DocumentType } from '../domain/types'

/** Soft cap per file for personal offline use (IndexedDB). */
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024

export const ALLOWED_DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
] as const

export type AllowedDocumentMime = (typeof ALLOWED_DOCUMENT_MIME_TYPES)[number]

const EXT_MIME: Record<string, AllowedDocumentMime> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
}

export class DocumentValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DocumentValidationError'
  }
}

export function isAllowedMime(mime: string): mime is AllowedDocumentMime {
  return (ALLOWED_DOCUMENT_MIME_TYPES as readonly string[]).includes(mime)
}

export function isImageMime(mime: string): boolean {
  return mime.startsWith('image/')
}

export function isPdfMime(mime: string): boolean {
  return mime === 'application/pdf'
}

/** Resolve MIME from File (browser type or extension fallback). */
export function resolveFileMime(file: { name: string; type: string }): string {
  if (file.type && isAllowedMime(file.type)) return file.type
  const ext = file.name.split('.').pop()?.toLowerCase()
  if (ext && EXT_MIME[ext]) return EXT_MIME[ext]
  return file.type || 'application/octet-stream'
}

export function assertAttachableFile(file: {
  name: string
  type: string
  size: number
}): { mimeType: string } {
  if (file.size <= 0) {
    throw new DocumentValidationError('El archivo está vacío.')
  }
  if (file.size > MAX_DOCUMENT_BYTES) {
    throw new DocumentValidationError(
      `El archivo supera el límite de ${formatBytes(MAX_DOCUMENT_BYTES)}.`,
    )
  }
  const mimeType = resolveFileMime(file)
  if (!isAllowedMime(mimeType)) {
    throw new DocumentValidationError(
      'Formato no permitido. Usa PDF, JPG, PNG, WEBP o GIF.',
    )
  }
  return { mimeType }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function documentTypeLabel(type: DocumentType): string {
  const map: Record<DocumentType, string> = {
    reservation: 'Reservación',
    boarding_pass: 'Pase de abordar',
    ticket: 'Boleto',
    receipt: 'Comprobante',
    insurance: 'Seguro',
    id_scan: 'Identificación',
    photo: 'Foto',
    other: 'Otro',
  }
  return map[type]
}

/** Short action label for quick links from Booking / Itinerary. */
export function documentActionLabel(type: DocumentType): string {
  const map: Record<DocumentType, string> = {
    reservation: 'Ver reservación',
    boarding_pass: 'Ver pase de abordar',
    ticket: 'Ver boleto',
    receipt: 'Ver comprobante',
    insurance: 'Ver seguro',
    id_scan: 'Ver identificación',
    photo: 'Ver foto',
    other: 'Ver documento',
  }
  return map[type]
}

export function guessDocumentType(
  mimeType: string,
  fileName: string,
): DocumentType {
  const lower = fileName.toLowerCase()
  if (lower.includes('pase') || lower.includes('boarding')) return 'boarding_pass'
  if (lower.includes('boleto') || lower.includes('ticket')) return 'ticket'
  if (lower.includes('seguro') || lower.includes('insurance')) return 'insurance'
  if (lower.includes('comprobante') || lower.includes('receipt')) return 'receipt'
  if (isImageMime(mimeType) && (lower.includes('foto') || lower.includes('photo')))
    return 'photo'
  if (lower.includes('reserva') || lower.includes('confirm')) return 'reservation'
  if (isPdfMime(mimeType)) return 'reservation'
  if (isImageMime(mimeType)) return 'photo'
  return 'other'
}

/**
 * Create a temporary Object URL for a Blob.
 * Caller MUST revoke via revokeObjectUrl when finished.
 */
export function createObjectUrl(blob: Blob): string {
  return URL.createObjectURL(blob)
}

export function revokeObjectUrl(url: string): void {
  URL.revokeObjectURL(url)
}
