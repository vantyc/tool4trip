import type { Note } from '../../domain/types'
import { db } from '../db'
import type { NoteRepository } from './types'

export const dexieNoteRepository: NoteRepository = {
  listByTrip: (tripId) => db.notes.where('tripId').equals(tripId).toArray(),
  getById: (id) => db.notes.get(id),
  put: (note: Note) => db.notes.put(note).then(() => undefined),
  delete: (id) => db.notes.delete(id),
}
