export type TripDeletionState = {
  pending: { id: string; title: string } | null
  deleting: boolean
  deletedIds: string[]
  error: string | null
}

export const initialTripDeletion: TripDeletionState = {
  pending: null,
  deleting: false,
  deletedIds: [],
  error: null,
}

export function requestTripDeletion(
  state: TripDeletionState,
  trip: { id: string; title: string },
): TripDeletionState {
  return { ...state, pending: { id: trip.id, title: trip.title }, error: null }
}

export function cancelTripDeletion(state: TripDeletionState): TripDeletionState {
  return state.deleting ? state : { ...state, pending: null }
}

export async function confirmTripDeletion(
  state: TripDeletionState,
  remove: (id: string) => Promise<void>,
): Promise<TripDeletionState> {
  const pending = state.pending
  if (!pending) return state
  try {
    await remove(pending.id)
    return {
      ...state,
      pending: null,
      deleting: false,
      deletedIds: [...state.deletedIds, pending.id],
      error: null,
    }
  } catch (err) {
    const detail = err instanceof Error && err.message ? ` (${err.message})` : ''
    return {
      ...state,
      pending: null,
      deleting: false,
      error: `No se pudo eliminar "${pending.title}"${detail}. El viaje sigue guardado.`,
    }
  }
}

export function visibleTrips<T extends { id: string }>(
  trips: T[],
  state: TripDeletionState,
): T[] {
  return trips.filter((t) => !state.deletedIds.includes(t.id))
}
