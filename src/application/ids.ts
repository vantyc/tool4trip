/** Shared ID helpers and timestamps for entities. */

export function newId(): string {
  return crypto.randomUUID()
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function touchTimestamps(existing?: {
  createdAt: string
}): { createdAt: string; updatedAt: string } {
  const updatedAt = nowIso()
  return {
    createdAt: existing?.createdAt ?? updatedAt,
    updatedAt,
  }
}
