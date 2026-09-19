import type { Db } from './db.ts'

const WORKSPACE = 'default'

export async function migrate(pool: Db): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trips (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL DEFAULT '${WORKSPACE}',
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS trips_workspace_idx ON trips (workspace);
    CREATE INDEX IF NOT EXISTS trips_updated_at_idx ON trips (updated_at DESC);

    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL DEFAULT '${WORKSPACE}',
      trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS bookings_trip_idx ON bookings (trip_id);

    CREATE TABLE IF NOT EXISTS travel_options (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL DEFAULT '${WORKSPACE}',
      trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      package_id TEXT,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS travel_options_trip_idx ON travel_options (trip_id);
    CREATE INDEX IF NOT EXISTS travel_options_package_idx ON travel_options (package_id);

    CREATE TABLE IF NOT EXISTS itinerary_items (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL DEFAULT '${WORKSPACE}',
      trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS itinerary_items_trip_idx ON itinerary_items (trip_id);

    CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL DEFAULT '${WORKSPACE}',
      trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      itinerary_item_id TEXT,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS reminders_trip_idx ON reminders (trip_id);
    CREATE INDEX IF NOT EXISTS reminders_item_idx ON reminders (itinerary_item_id);

    CREATE TABLE IF NOT EXISTS checklist_items (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL DEFAULT '${WORKSPACE}',
      trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS checklist_items_trip_idx ON checklist_items (trip_id);

    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL DEFAULT '${WORKSPACE}',
      trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS notes_trip_idx ON notes (trip_id);

    CREATE TABLE IF NOT EXISTS package_imports (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL DEFAULT '${WORKSPACE}',
      trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS package_imports_trip_idx ON package_imports (trip_id);
  `)
}

export const DEFAULT_WORKSPACE = WORKSPACE
