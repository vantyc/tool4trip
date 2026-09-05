import type { Booking } from '../../domain/types'
import { db } from '../db'
import type { BookingRepository } from './types'

export const dexieBookingRepository: BookingRepository = {
  listByTrip: (tripId) => db.bookings.where('tripId').equals(tripId).toArray(),
  getById: (id) => db.bookings.get(id),
  put: (booking: Booking) => db.bookings.put(booking).then(() => undefined),
  delete: (id) => db.bookings.delete(id),
}
