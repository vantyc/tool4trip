/**
 * Session access level as reported by trip-api (`X-Tool4trip-Access`).
 * Only ever flips to read-only: owner responses never carry the header,
 * and a guest session cannot become the owner without a new login.
 */

let readOnly = false
const listeners = new Set<() => void>()

export function markReadOnly(): void {
  if (readOnly) return
  readOnly = true
  for (const listener of listeners) listener()
}

export function isReadOnly(): boolean {
  return readOnly
}

export function subscribeAccess(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
