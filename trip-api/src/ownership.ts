import { DEFAULT_WORKSPACE } from './schema.ts'

/**
 * Workspace a request may act on. `X-Viajes-User` is set by ForwardAuth
 * (client values are overwritten); the configured account owns the default
 * workspace and any other user only reaches its own (empty) workspace.
 */
export function requestWorkspace(
  userHeader: string | string[] | undefined,
  ownerUser: string | undefined,
): string | null {
  const user = typeof userHeader === 'string' ? userHeader.trim() : ''
  if (!user) return null
  const owner = ownerUser?.trim()
  return owner && user === owner ? DEFAULT_WORKSPACE : `user:${user}`
}

/** A read-only guest and the trips the owner shared with them. */
export type GuestAccess = { user: string; trips: Set<string> }

/**
 * The guest account, when the request comes from it. The auth service
 * already refuses the guest anything but reads; this is the second wall.
 */
export function guestAccess(
  userHeader: string | string[] | undefined,
  guestUser: string | undefined,
  guestTrips: string | undefined,
): GuestAccess | null {
  const user = typeof userHeader === 'string' ? userHeader.trim() : ''
  const guest = guestUser?.trim()
  if (!user || !guest || user !== guest) return null
  const trips = new Set(
    (guestTrips ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
  )
  return { user, trips }
}

export type GuestRoute = { kind: string; tripId?: string }

/** Why the guest may not make this request, or null when it is a read they can see. */
export function guestDenial(
  guest: GuestAccess,
  method: string,
  route: GuestRoute,
): { status: 403 | 404; error: string } | null {
  if (route.kind === 'health') return null
  if (method !== 'GET' && method !== 'HEAD') {
    return { status: 403, error: 'Acceso de solo lectura' }
  }
  if (route.kind === 'import' || route.kind === 'migrate' || route.kind === 'compile-preview') {
    return { status: 403, error: 'Acceso de solo lectura' }
  }
  if (route.tripId !== undefined && !guest.trips.has(route.tripId)) {
    return { status: 404, error: 'not found' }
  }
  return null
}

/** Rows the guest may see: only those of the shared trips. */
export function guestVisible<T>(guest: GuestAccess | null, rows: T[]): T[] {
  if (!guest) return rows
  return rows.filter((r) => {
    const tripId = (r as { tripId?: unknown; id?: unknown }).tripId
    return typeof tripId === 'string' && guest.trips.has(tripId)
  })
}
