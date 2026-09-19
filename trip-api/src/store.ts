import type pg from 'pg'
import type {
  Booking,
  ChecklistItem,
  ItineraryItem,
  Note,
  PackageImport,
  Reminder,
  TravelOption,
  Trip,
} from './domainTypes.ts'
import { DEFAULT_WORKSPACE } from './schema.ts'

type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient

function asUpdatedAt(iso: string): string {
  // Accept both timestamptz and ISO strings from clients.
  return iso
}

export class ConflictError extends Error {
  constructor(message = 'conflict: resource was modified') {
    super(message)
    this.name = 'ConflictError'
  }
}

export class NotFoundError extends Error {
  constructor(message = 'not found') {
    super(message)
    this.name = 'NotFoundError'
  }
}

async function getPayload<T>(
  db: Queryable,
  table: string,
  id: string,
  workspace = DEFAULT_WORKSPACE,
): Promise<T | undefined> {
  const res = await db.query<{ payload: T }>(
    `SELECT payload FROM ${table} WHERE id = $1 AND workspace = $2`,
    [id, workspace],
  )
  return res.rows[0]?.payload
}

async function listByTrip<T>(
  db: Queryable,
  table: string,
  tripId: string,
  workspace = DEFAULT_WORKSPACE,
): Promise<T[]> {
  const res = await db.query<{ payload: T }>(
    `SELECT payload FROM ${table} WHERE trip_id = $1 AND workspace = $2 ORDER BY id`,
    [tripId, workspace],
  )
  return res.rows.map((r) => r.payload)
}

async function putEntity(
  db: Queryable,
  table: string,
  id: string,
  tripId: string,
  payload: unknown,
  updatedAt: string,
  extra?: { packageId?: string | null; itineraryItemId?: string | null },
  workspace = DEFAULT_WORKSPACE,
  expectUpdatedAt?: string,
): Promise<void> {
  if (expectUpdatedAt) {
    const existing = await db.query<{ updated_at: Date }>(
      `SELECT updated_at FROM ${table} WHERE id = $1 AND workspace = $2`,
      [id, workspace],
    )
    if (existing.rows[0]) {
      const current = existing.rows[0].updated_at.toISOString()
      const expected = new Date(expectUpdatedAt).toISOString()
      if (current !== expected) {
        throw new ConflictError()
      }
    }
  }

  if (table === 'travel_options') {
    await db.query(
      `INSERT INTO travel_options (id, workspace, trip_id, package_id, payload, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::timestamptz)
       ON CONFLICT (id) DO UPDATE SET
         trip_id = EXCLUDED.trip_id,
         package_id = EXCLUDED.package_id,
         payload = EXCLUDED.payload,
         updated_at = EXCLUDED.updated_at`,
      [
        id,
        workspace,
        tripId,
        extra?.packageId ?? null,
        JSON.stringify(payload),
        asUpdatedAt(updatedAt),
      ],
    )
    return
  }

  if (table === 'reminders') {
    await db.query(
      `INSERT INTO reminders (id, workspace, trip_id, itinerary_item_id, payload, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::timestamptz)
       ON CONFLICT (id) DO UPDATE SET
         trip_id = EXCLUDED.trip_id,
         itinerary_item_id = EXCLUDED.itinerary_item_id,
         payload = EXCLUDED.payload,
         updated_at = EXCLUDED.updated_at`,
      [
        id,
        workspace,
        tripId,
        extra?.itineraryItemId ?? null,
        JSON.stringify(payload),
        asUpdatedAt(updatedAt),
      ],
    )
    return
  }

  await db.query(
    `INSERT INTO ${table} (id, workspace, trip_id, payload, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz)
     ON CONFLICT (id) DO UPDATE SET
       trip_id = EXCLUDED.trip_id,
       payload = EXCLUDED.payload,
       updated_at = EXCLUDED.updated_at`,
    [id, workspace, tripId, JSON.stringify(payload), asUpdatedAt(updatedAt)],
  )
}

async function deleteEntity(
  db: Queryable,
  table: string,
  id: string,
  workspace = DEFAULT_WORKSPACE,
): Promise<boolean> {
  const res = await db.query(
    `DELETE FROM ${table} WHERE id = $1 AND workspace = $2`,
    [id, workspace],
  )
  return (res.rowCount ?? 0) > 0
}

export const store = {
  listTrips: async (db: Queryable, workspace = DEFAULT_WORKSPACE) => {
    const res = await db.query<{ payload: Trip }>(
      `SELECT payload FROM trips WHERE workspace = $1 ORDER BY (payload->>'startDate') ASC`,
      [workspace],
    )
    return res.rows.map((r) => r.payload)
  },

  getTrip: (db: Queryable, id: string) =>
    getPayload<Trip>(db, 'trips', id),

  putTrip: async (
    db: Queryable,
    trip: Trip,
    opts?: { expectUpdatedAt?: string; workspace?: string },
  ) => {
    const workspace = opts?.workspace ?? DEFAULT_WORKSPACE
    const synced: Trip = { ...trip, syncStatus: 'synced' }
    if (opts?.expectUpdatedAt) {
      const existing = await db.query<{ updated_at: Date }>(
        `SELECT updated_at FROM trips WHERE id = $1 AND workspace = $2`,
        [trip.id, workspace],
      )
      if (existing.rows[0]) {
        const current = existing.rows[0].updated_at.toISOString()
        const expected = new Date(opts.expectUpdatedAt).toISOString()
        if (current !== expected) throw new ConflictError()
      }
    }
    await db.query(
      `INSERT INTO trips (id, workspace, payload, updated_at)
       VALUES ($1, $2, $3::jsonb, $4::timestamptz)
       ON CONFLICT (id) DO UPDATE SET
         payload = EXCLUDED.payload,
         updated_at = EXCLUDED.updated_at`,
      [synced.id, workspace, JSON.stringify(synced), synced.updatedAt],
    )
    return synced
  },

  deleteTrip: async (db: Queryable, id: string) => {
    return deleteEntity(db, 'trips', id)
  },

  listBookings: (db: Queryable, tripId: string) =>
    listByTrip<Booking>(db, 'bookings', tripId),
  getBooking: (db: Queryable, id: string) =>
    getPayload<Booking>(db, 'bookings', id),
  putBooking: async (
    db: Queryable,
    booking: Booking,
    opts?: { expectUpdatedAt?: string },
  ) => {
    const synced = { ...booking, syncStatus: 'synced' as const }
    await putEntity(
      db,
      'bookings',
      synced.id,
      synced.tripId,
      synced,
      synced.updatedAt,
      undefined,
      DEFAULT_WORKSPACE,
      opts?.expectUpdatedAt,
    )
    return synced
  },
  deleteBooking: (db: Queryable, id: string) =>
    deleteEntity(db, 'bookings', id),

  listTravelOptions: (db: Queryable, tripId: string) =>
    listByTrip<TravelOption>(db, 'travel_options', tripId),
  getTravelOption: (db: Queryable, id: string) =>
    getPayload<TravelOption>(db, 'travel_options', id),
  listTravelOptionsByPackage: async (db: Queryable, packageId: string) => {
    const res = await db.query<{ payload: TravelOption }>(
      `SELECT payload FROM travel_options WHERE package_id = $1 AND workspace = $2 ORDER BY id`,
      [packageId, DEFAULT_WORKSPACE],
    )
    return res.rows.map((r) => r.payload)
  },
  putTravelOption: async (
    db: Queryable,
    option: TravelOption,
    opts?: { expectUpdatedAt?: string },
  ) => {
    const synced = { ...option, syncStatus: 'synced' as const }
    await putEntity(
      db,
      'travel_options',
      synced.id,
      synced.tripId,
      synced,
      synced.updatedAt,
      { packageId: synced.packageId ?? null },
      DEFAULT_WORKSPACE,
      opts?.expectUpdatedAt,
    )
    return synced
  },
  deleteTravelOption: (db: Queryable, id: string) =>
    deleteEntity(db, 'travel_options', id),

  listItineraryItems: (db: Queryable, tripId: string) =>
    listByTrip<ItineraryItem>(db, 'itinerary_items', tripId),
  getItineraryItem: (db: Queryable, id: string) =>
    getPayload<ItineraryItem>(db, 'itinerary_items', id),
  putItineraryItem: async (
    db: Queryable,
    item: ItineraryItem,
    opts?: { expectUpdatedAt?: string },
  ) => {
    const synced = { ...item, syncStatus: 'synced' as const }
    await putEntity(
      db,
      'itinerary_items',
      synced.id,
      synced.tripId,
      synced,
      synced.updatedAt,
      undefined,
      DEFAULT_WORKSPACE,
      opts?.expectUpdatedAt,
    )
    return synced
  },
  deleteItineraryItem: (db: Queryable, id: string) =>
    deleteEntity(db, 'itinerary_items', id),

  listReminders: (db: Queryable, tripId: string) =>
    listByTrip<Reminder>(db, 'reminders', tripId),
  listRemindersByItem: async (db: Queryable, itineraryItemId: string) => {
    const res = await db.query<{ payload: Reminder }>(
      `SELECT payload FROM reminders WHERE itinerary_item_id = $1 AND workspace = $2 ORDER BY id`,
      [itineraryItemId, DEFAULT_WORKSPACE],
    )
    return res.rows.map((r) => r.payload)
  },
  getReminder: (db: Queryable, id: string) =>
    getPayload<Reminder>(db, 'reminders', id),
  putReminder: async (
    db: Queryable,
    reminder: Reminder,
    opts?: { expectUpdatedAt?: string },
  ) => {
    const synced = { ...reminder, syncStatus: 'synced' as const }
    await putEntity(
      db,
      'reminders',
      synced.id,
      synced.tripId,
      synced,
      synced.updatedAt,
      { itineraryItemId: synced.itineraryItemId },
      DEFAULT_WORKSPACE,
      opts?.expectUpdatedAt,
    )
    return synced
  },
  deleteReminder: (db: Queryable, id: string) =>
    deleteEntity(db, 'reminders', id),

  listChecklist: (db: Queryable, tripId: string) =>
    listByTrip<ChecklistItem>(db, 'checklist_items', tripId),
  getChecklistItem: (db: Queryable, id: string) =>
    getPayload<ChecklistItem>(db, 'checklist_items', id),
  putChecklistItem: async (
    db: Queryable,
    item: ChecklistItem,
    opts?: { expectUpdatedAt?: string },
  ) => {
    const synced = { ...item, syncStatus: 'synced' as const }
    await putEntity(
      db,
      'checklist_items',
      synced.id,
      synced.tripId,
      synced,
      synced.updatedAt,
      undefined,
      DEFAULT_WORKSPACE,
      opts?.expectUpdatedAt,
    )
    return synced
  },
  deleteChecklistItem: (db: Queryable, id: string) =>
    deleteEntity(db, 'checklist_items', id),

  listNotes: (db: Queryable, tripId: string) =>
    listByTrip<Note>(db, 'notes', tripId),
  getNote: (db: Queryable, id: string) => getPayload<Note>(db, 'notes', id),
  putNote: async (
    db: Queryable,
    note: Note,
    opts?: { expectUpdatedAt?: string },
  ) => {
    const synced = { ...note, syncStatus: 'synced' as const }
    await putEntity(
      db,
      'notes',
      synced.id,
      synced.tripId,
      synced,
      synced.updatedAt,
      undefined,
      DEFAULT_WORKSPACE,
      opts?.expectUpdatedAt,
    )
    return synced
  },
  deleteNote: (db: Queryable, id: string) => deleteEntity(db, 'notes', id),

  listPackageImports: (db: Queryable, tripId: string) =>
    listByTrip<PackageImport>(db, 'package_imports', tripId),
  getPackageImport: (db: Queryable, id: string) =>
    getPayload<PackageImport>(db, 'package_imports', id),
  putPackageImport: async (db: Queryable, record: PackageImport) => {
    await putEntity(
      db,
      'package_imports',
      record.id,
      record.tripId,
      record,
      record.importedAt,
    )
    return record
  },
  deletePackageImport: (db: Queryable, id: string) =>
    deleteEntity(db, 'package_imports', id),
}
