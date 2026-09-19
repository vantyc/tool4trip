import http from 'node:http'
import { createPool, withTransaction, type Db } from './db.ts'
import {
  importPackage,
  PackageValidationImportError,
  upsertTripBundle,
  type TripBundle,
} from './importPackage.ts'
import { migrate } from './schema.ts'
import { ConflictError, NotFoundError, store } from './store.ts'
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

const addr = process.env.LISTEN_ADDR || ':8080'

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
) {
  const raw = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(raw)
}

function sendNoContent(res: http.ServerResponse) {
  res.writeHead(204, { 'Cache-Control': 'no-store' })
  res.end()
}

async function parseJson(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<unknown | null> {
  const raw = await readBody(req)
  try {
    return JSON.parse(raw || '{}')
  } catch {
    sendJson(res, 400, { error: 'invalid JSON body' })
    return null
  }
}

function expectUpdatedAt(
  req: http.IncomingMessage,
  body: { updatedAt?: string },
): string | undefined {
  const match = req.headers['if-match']
  if (typeof match === 'string' && match.trim()) {
    return match.replace(/^W\//, '').replaceAll('"', '').trim()
  }
  return body.updatedAt
}

function auditUser(req: http.IncomingMessage): string | undefined {
  const h = req.headers['x-forwarded-user']
  return typeof h === 'string' ? h : undefined
}

type RouteMatch = {
  kind:
    | 'health'
    | 'trips'
    | 'trip'
    | 'collection'
    | 'entity'
    | 'import'
    | 'migrate'
    | 'byId'
  tripId?: string
  collection?: string
  entityId?: string
}

const COLLECTIONS = new Set([
  'bookings',
  'travel-options',
  'itinerary-items',
  'reminders',
  'checklist-items',
  'notes',
  'package-imports',
])

const BY_ID_TABLES = new Map<
  string,
  | 'bookings'
  | 'travel-options'
  | 'itinerary-items'
  | 'reminders'
  | 'checklist-items'
  | 'notes'
  | 'package-imports'
>([
  ['bookings', 'bookings'],
  ['travel-options', 'travel-options'],
  ['itinerary-items', 'itinerary-items'],
  ['reminders', 'reminders'],
  ['checklist-items', 'checklist-items'],
  ['notes', 'notes'],
  ['package-imports', 'package-imports'],
])

function matchRoute(urlPath: string): RouteMatch | null {
  if (urlPath === '/healthz') return { kind: 'health' }
  if (urlPath === '/api/trips/import-package') return { kind: 'import' }
  if (urlPath === '/api/trips/migrate') return { kind: 'migrate' }
  if (urlPath === '/api/trips') return { kind: 'trips' }

  let m = /^\/api\/trips\/([^/]+)\/import-package$/.exec(urlPath)
  if (m) return { kind: 'import', tripId: decodeURIComponent(m[1]!) }

  m = /^\/api\/trips\/([^/]+)$/.exec(urlPath)
  if (m) return { kind: 'trip', tripId: decodeURIComponent(m[1]!) }

  m = /^\/api\/trips\/([^/]+)\/([^/]+)$/.exec(urlPath)
  if (m && COLLECTIONS.has(m[2]!)) {
    return {
      kind: 'collection',
      tripId: decodeURIComponent(m[1]!),
      collection: m[2]!,
    }
  }

  m = /^\/api\/trips\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(urlPath)
  if (m && COLLECTIONS.has(m[2]!)) {
    return {
      kind: 'entity',
      tripId: decodeURIComponent(m[1]!),
      collection: m[2]!,
      entityId: decodeURIComponent(m[3]!),
    }
  }

  m = /^\/api\/(bookings|travel-options|itinerary-items|reminders|checklist-items|notes|package-imports)\/([^/]+)$/.exec(
    urlPath,
  )
  if (m) {
    return {
      kind: 'byId',
      collection: m[1]!,
      entityId: decodeURIComponent(m[2]!),
    }
  }

  // reminders by itinerary item
  m = /^\/api\/itinerary-items\/([^/]+)\/reminders$/.exec(urlPath)
  if (m) {
    return {
      kind: 'collection',
      collection: 'reminders-by-item',
      entityId: decodeURIComponent(m[1]!),
    }
  }

  // travel-options by package
  m = /^\/api\/package-imports\/([^/]+)\/travel-options$/.exec(urlPath)
  if (m) {
    return {
      kind: 'collection',
      collection: 'options-by-package',
      entityId: decodeURIComponent(m[1]!),
    }
  }

  return null
}

async function handleCollectionList(
  pool: Db,
  res: http.ServerResponse,
  tripId: string,
  collection: string,
) {
  switch (collection) {
    case 'bookings':
      return sendJson(res, 200, await store.listBookings(pool, tripId))
    case 'travel-options':
      return sendJson(res, 200, await store.listTravelOptions(pool, tripId))
    case 'itinerary-items':
      return sendJson(res, 200, await store.listItineraryItems(pool, tripId))
    case 'reminders':
      return sendJson(res, 200, await store.listReminders(pool, tripId))
    case 'checklist-items':
      return sendJson(res, 200, await store.listChecklist(pool, tripId))
    case 'notes':
      return sendJson(res, 200, await store.listNotes(pool, tripId))
    case 'package-imports':
      return sendJson(res, 200, await store.listPackageImports(pool, tripId))
    default:
      return sendJson(res, 404, { error: 'unknown collection' })
  }
}

async function handleEntityPut(
  pool: Db,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  tripId: string,
  collection: string,
  entityId: string,
  body: unknown,
) {
  const expected = expectUpdatedAt(
    req,
    body as { updatedAt?: string },
  )

  try {
    switch (collection) {
      case 'bookings': {
        const booking = { ...(body as Booking), id: entityId, tripId }
        const saved = await store.putBooking(pool, booking, {
          expectUpdatedAt: expected,
        })
        return sendJson(res, 200, saved)
      }
      case 'travel-options': {
        const option = { ...(body as TravelOption), id: entityId, tripId }
        const saved = await store.putTravelOption(pool, option, {
          expectUpdatedAt: expected,
        })
        return sendJson(res, 200, saved)
      }
      case 'itinerary-items': {
        const item = { ...(body as ItineraryItem), id: entityId, tripId }
        const saved = await store.putItineraryItem(pool, item, {
          expectUpdatedAt: expected,
        })
        return sendJson(res, 200, saved)
      }
      case 'reminders': {
        const reminder = { ...(body as Reminder), id: entityId, tripId }
        const saved = await store.putReminder(pool, reminder, {
          expectUpdatedAt: expected,
        })
        return sendJson(res, 200, saved)
      }
      case 'checklist-items': {
        const item = { ...(body as ChecklistItem), id: entityId, tripId }
        const saved = await store.putChecklistItem(pool, item, {
          expectUpdatedAt: expected,
        })
        return sendJson(res, 200, saved)
      }
      case 'notes': {
        const note = { ...(body as Note), id: entityId, tripId }
        const saved = await store.putNote(pool, note, {
          expectUpdatedAt: expected,
        })
        return sendJson(res, 200, saved)
      }
      case 'package-imports': {
        const record = { ...(body as PackageImport), id: entityId, tripId }
        const saved = await store.putPackageImport(pool, record)
        return sendJson(res, 200, saved)
      }
      default:
        return sendJson(res, 404, { error: 'unknown collection' })
    }
  } catch (err) {
    if (err instanceof ConflictError) {
      return sendJson(res, 409, { error: err.message })
    }
    throw err
  }
}

async function handleEntityDelete(
  pool: Db,
  res: http.ServerResponse,
  collection: string,
  entityId: string,
) {
  let ok = false
  switch (collection) {
    case 'bookings':
      ok = await store.deleteBooking(pool, entityId)
      break
    case 'travel-options':
      ok = await store.deleteTravelOption(pool, entityId)
      break
    case 'itinerary-items':
      ok = await store.deleteItineraryItem(pool, entityId)
      break
    case 'reminders':
      ok = await store.deleteReminder(pool, entityId)
      break
    case 'checklist-items':
      ok = await store.deleteChecklistItem(pool, entityId)
      break
    case 'notes':
      ok = await store.deleteNote(pool, entityId)
      break
    case 'package-imports':
      ok = await store.deletePackageImport(pool, entityId)
      break
    default:
      return sendJson(res, 404, { error: 'unknown collection' })
  }
  if (!ok) return sendJson(res, 404, { error: 'not found' })
  return sendNoContent(res)
}

async function handleByIdGet(
  pool: Db,
  res: http.ServerResponse,
  collection: string,
  entityId: string,
) {
  let row: unknown
  switch (BY_ID_TABLES.get(collection)) {
    case 'bookings':
      row = await store.getBooking(pool, entityId)
      break
    case 'travel-options':
      row = await store.getTravelOption(pool, entityId)
      break
    case 'itinerary-items':
      row = await store.getItineraryItem(pool, entityId)
      break
    case 'reminders':
      row = await store.getReminder(pool, entityId)
      break
    case 'checklist-items':
      row = await store.getChecklistItem(pool, entityId)
      break
    case 'notes':
      row = await store.getNote(pool, entityId)
      break
    case 'package-imports':
      row = await store.getPackageImport(pool, entityId)
      break
    default:
      return sendJson(res, 404, { error: 'unknown collection' })
  }
  if (!row) return sendJson(res, 404, { error: 'not found' })
  return sendJson(res, 200, row)
}

async function handleRequest(
  pool: Db,
  req: http.IncomingMessage,
  res: http.ServerResponse,
) {
  const url = new URL(req.url || '/', 'http://localhost')
  const route = matchRoute(url.pathname)
  if (!route) {
    sendJson(res, 404, { error: 'not found' })
    return
  }

  const method = req.method || 'GET'
  // Optional audit header (set by ForwardAuth); shared workspace for v1.
  void auditUser(req)

  try {
    if (route.kind === 'health') {
      if (method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      await pool.query('SELECT 1')
      sendJson(res, 200, { ok: true })
      return
    }

    if (route.kind === 'import') {
      if (method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      const body = await parseJson(req, res)
      if (body === null) return
      try {
        const result = await withTransaction(pool, (client) =>
          importPackage(client, body, { tripId: route.tripId }),
        )
        sendJson(res, 200, result)
      } catch (err) {
        if (err instanceof PackageValidationImportError) {
          sendJson(res, 400, { error: err.message, details: err.errors })
          return
        }
        throw err
      }
      return
    }

    if (route.kind === 'migrate') {
      if (method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      const body = await parseJson(req, res)
      if (body === null) return
      const bundles = Array.isArray(body)
        ? (body as TripBundle[])
        : ((body as { trips?: TripBundle[] }).trips ?? [])
      if (!Array.isArray(bundles)) {
        sendJson(res, 400, { error: 'expected { trips: TripBundle[] }' })
        return
      }
      const tripIds: string[] = []
      await withTransaction(pool, async (client) => {
        for (const bundle of bundles) {
          const { tripId } = await upsertTripBundle(client, bundle)
          tripIds.push(tripId)
        }
      })
      sendJson(res, 200, { ok: true, tripIds, count: tripIds.length })
      return
    }

    if (route.kind === 'trips') {
      if (method === 'GET') {
        sendJson(res, 200, await store.listTrips(pool))
        return
      }
      if (method === 'POST') {
        const body = await parseJson(req, res)
        if (body === null) return
        const trip = body as Trip
        if (!trip?.id || !trip.title) {
          sendJson(res, 400, { error: 'trip.id and trip.title required' })
          return
        }
        const saved = await store.putTrip(pool, {
          ...trip,
          goals: trip.goals ?? [],
          syncStatus: 'synced',
        })
        sendJson(res, 201, saved)
        return
      }
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }

    if (route.kind === 'trip' && route.tripId) {
      if (method === 'GET') {
        const trip = await store.getTrip(pool, route.tripId)
        if (!trip) {
          sendJson(res, 404, { error: 'not found' })
          return
        }
        sendJson(res, 200, trip)
        return
      }
      if (method === 'PATCH' || method === 'PUT') {
        const body = await parseJson(req, res)
        if (body === null) return
        const incoming = body as Trip
        const expected = expectUpdatedAt(req, incoming)
        try {
          const existing = await store.getTrip(pool, route.tripId)
          if (!existing && method === 'PATCH') {
            throw new NotFoundError()
          }
          const saved = await store.putTrip(
            pool,
            {
              ...existing,
              ...incoming,
              id: route.tripId,
              goals: incoming.goals ?? existing?.goals ?? [],
              syncStatus: 'synced',
            },
            { expectUpdatedAt: expected },
          )
          sendJson(res, 200, saved)
        } catch (err) {
          if (err instanceof ConflictError) {
            sendJson(res, 409, { error: err.message })
            return
          }
          if (err instanceof NotFoundError) {
            sendJson(res, 404, { error: 'not found' })
            return
          }
          throw err
        }
        return
      }
      if (method === 'DELETE') {
        const ok = await store.deleteTrip(pool, route.tripId)
        if (!ok) {
          sendJson(res, 404, { error: 'not found' })
          return
        }
        sendNoContent(res)
        return
      }
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }

    if (route.kind === 'collection') {
      if (route.collection === 'reminders-by-item' && route.entityId) {
        if (method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        sendJson(
          res,
          200,
          await store.listRemindersByItem(pool, route.entityId),
        )
        return
      }
      if (route.collection === 'options-by-package' && route.entityId) {
        if (method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        sendJson(
          res,
          200,
          await store.listTravelOptionsByPackage(pool, route.entityId),
        )
        return
      }
      if (method === 'GET' && route.tripId && route.collection) {
        await handleCollectionList(pool, res, route.tripId, route.collection)
        return
      }
      // PUT without entity id → use body.id
      if (
        (method === 'PUT' || method === 'POST') &&
        route.tripId &&
        route.collection
      ) {
        const body = await parseJson(req, res)
        if (body === null) return
        const id = (body as { id?: string }).id
        if (!id) {
          sendJson(res, 400, { error: 'body.id required' })
          return
        }
        await handleEntityPut(
          pool,
          req,
          res,
          route.tripId,
          route.collection,
          id,
          body,
        )
        return
      }
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }

    if (route.kind === 'entity' && route.tripId && route.collection && route.entityId) {
      if (method === 'PUT' || method === 'PATCH') {
        const body = await parseJson(req, res)
        if (body === null) return
        await handleEntityPut(
          pool,
          req,
          res,
          route.tripId,
          route.collection,
          route.entityId,
          body,
        )
        return
      }
      if (method === 'DELETE') {
        await handleEntityDelete(pool, res, route.collection, route.entityId)
        return
      }
      if (method === 'GET') {
        await handleByIdGet(pool, res, route.collection, route.entityId)
        return
      }
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }

    if (route.kind === 'byId' && route.collection && route.entityId) {
      if (method === 'GET') {
        await handleByIdGet(pool, res, route.collection, route.entityId)
        return
      }
      if (method === 'DELETE') {
        await handleEntityDelete(pool, res, route.collection, route.entityId)
        return
      }
      if (method === 'PUT' || method === 'PATCH') {
        const body = await parseJson(req, res)
        if (body === null) return
        const tripId = (body as { tripId?: string }).tripId
        if (!tripId) {
          sendJson(res, 400, { error: 'body.tripId required' })
          return
        }
        await handleEntityPut(
          pool,
          req,
          res,
          tripId,
          route.collection,
          route.entityId,
          body,
        )
        return
      }
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }

    sendJson(res, 404, { error: 'not found' })
  } catch (err) {
    console.error('[trip-api]', err)
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : 'internal error',
    })
  }
}

async function main() {
  const pool = createPool()
  await migrate(pool)
  console.log('[trip-api] schema ready')

  const host = addr.startsWith(':') ? '0.0.0.0' : undefined
  const port = Number(addr.replace(/^:/, '') || 8080)

  const server = http.createServer((req, res) => {
    void handleRequest(pool, req, res)
  })

  server.listen(port, host, () => {
    console.log(`[trip-api] listening on ${addr}`)
  })

  const shutdown = async () => {
    server.close()
    await pool.end()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown())
  process.on('SIGINT', () => void shutdown())
}

main().catch((err) => {
  console.error('[trip-api] fatal', err)
  process.exit(1)
})
