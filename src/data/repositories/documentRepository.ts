import type { DocumentMeta } from '../../domain/types'
import { db } from '../db'
import type { DocumentRepository } from './types'

export const dexieDocumentRepository: DocumentRepository = {
  listByTrip: (tripId) =>
    db.documents.where('tripId').equals(tripId).toArray(),
  listByBooking: (bookingId) =>
    db.documents.where('bookingId').equals(bookingId).toArray(),
  listByItineraryItem: (itineraryItemId) =>
    db.documents.where('itineraryItemId').equals(itineraryItemId).toArray(),
  getById: (id) => db.documents.get(id),
  put: async (meta: DocumentMeta, blob: Blob) => {
    await db.transaction('rw', db.documents, db.documentBlobs, async () => {
      await db.documents.put(meta)
      await db.documentBlobs.put({ id: meta.id, tripId: meta.tripId, blob })
    })
  },
  putMeta: async (meta: DocumentMeta) => {
    await db.documents.put(meta)
  },
  getBlob: (id) => db.documentBlobs.get(id),
  delete: async (id) => {
    await db.transaction('rw', db.documents, db.documentBlobs, async () => {
      await db.documents.delete(id)
      await db.documentBlobs.delete(id)
    })
  },
}
