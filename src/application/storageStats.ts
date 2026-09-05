import type { DocumentMeta } from '../domain/types'
import { formatBytes } from './documents'

export interface DocumentStorageStats {
  count: number
  totalBytes: number
  totalLabel: string
  /** Browser estimate when available (entire origin). */
  originUsageBytes?: number
  originQuotaBytes?: number
}

export function summarizeDocumentStorage(
  docs: DocumentMeta[],
): Pick<DocumentStorageStats, 'count' | 'totalBytes' | 'totalLabel'> {
  const totalBytes = docs.reduce((sum, d) => sum + (d.sizeBytes || 0), 0)
  return {
    count: docs.length,
    totalBytes,
    totalLabel: formatBytes(totalBytes),
  }
}

export async function getOriginStorageEstimate(): Promise<{
  usage?: number
  quota?: number
}> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) {
    return {}
  }
  try {
    const est = await navigator.storage.estimate()
    return { usage: est.usage, quota: est.quota }
  } catch {
    return {}
  }
}

export async function buildDocumentStorageStats(
  docs: DocumentMeta[],
): Promise<DocumentStorageStats> {
  const base = summarizeDocumentStorage(docs)
  const { usage, quota } = await getOriginStorageEstimate()
  return {
    ...base,
    originUsageBytes: usage,
    originQuotaBytes: quota,
  }
}

export function isQuotaExceededError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { name?: string; code?: number; inner?: { name?: string } }
  if (e.name === 'QuotaExceededError' || e.code === 22) return true
  if (e.inner?.name === 'QuotaExceededError') return true
  const msg = err instanceof Error ? err.message : String(err)
  return /quota/i.test(msg)
}

export function humanStorageError(err: unknown): string {
  if (isQuotaExceededError(err)) {
    return 'No hay espacio suficiente en este dispositivo para guardar el documento. Libera espacio o elimina documentos antiguos.'
  }
  if (err instanceof Error && err.message) return err.message
  return 'No se pudo guardar el documento en el almacenamiento local.'
}
