import type { Services } from '../application/services'
import type {
  AbsoluteReminder,
  Booking,
  ChecklistItem,
  ItineraryItem,
  Note,
  RelativeReminder,
  Trip,
} from '../domain/types'

/**
 * Stable IDs for the FICTICIO / DEMO seed.
 * Re-running seed upserts the same demo trip.
 */
export const DEMO_TRIP_ID = 'demo-sma-2026'

const DEMO_MARK =
  '[FICTICIO / DEMO] Datos de ejemplo para probar el modelo. No son reservaciones reales.'

const goal = {
  fiestas: { id: 'goal-fiestas', label: 'fiestas patronales' },
  socializar: { id: 'goal-socializar', label: 'socializar' },
  gastro: { id: 'goal-gastro', label: 'gastronomía local' },
  tradiciones: { id: 'goal-tradiciones', label: 'tradiciones' },
  sinPrisas: { id: 'goal-sin-prisas', label: 'viajar sin prisas' },
} as const

const ids = {
  flightOut: 'demo-booking-flight-mex-gdl',
  busOut: 'demo-booking-bus-gdl-sma',
  lodging: 'demo-booking-lodging',
  busBack: 'demo-booking-bus-sma-gdl',
  flightBack: 'demo-booking-flight-gdl-mex',
  itemFlightOut: 'demo-item-flight-out',
  itemBusOut: 'demo-item-bus-out',
  itemCheckIn: 'demo-item-checkin',
  itemWalk: 'demo-item-walk',
  itemDinner: 'demo-item-dinner',
  itemEvent: 'demo-item-event',
  itemFree: 'demo-item-free',
  itemBusBack: 'demo-item-bus-back',
  itemFlightBack: 'demo-item-flight-back',
  itemCheckOut: 'demo-item-checkout',
  rem24h: 'demo-rem-flight-24h',
  rem3h: 'demo-rem-flight-3h',
  remAbs: 'demo-rem-absolute',
  docReservation: 'demo-doc-flight-reservation',
  noteResearch: 'demo-note-research',
} as const

const stamp = {
  createdAt: '2026-09-01T12:00:00.000Z',
  updatedAt: '2026-09-01T12:00:00.000Z',
  syncStatus: 'local' as const,
}

export function buildDemoTrip(): Trip {
  return {
    id: DEMO_TRIP_ID,
    title: 'San Miguel el Alto [FICTICIO / DEMO]',
    destination: 'San Miguel el Alto, Jalisco, México',
    startDate: '2026-09-20',
    endDate: '2026-09-30',
    timezone: 'America/Mexico_City',
    goals: Object.values(goal),
    status: 'planned',
    notes: DEMO_MARK,
    ...stamp,
  }
}

export function buildDemoBookings(): Booking[] {
  return [
    {
      id: ids.flightOut,
      tripId: DEMO_TRIP_ID,
      type: 'flight',
      status: 'confirmed',
      title: '[FICTICIO] Vuelo CDMX → GDL',
      provider: 'Aerolínea DEMO',
      confirmationNumber: 'DEMO-MEX-GDL-001',
      // Offset -06:00 = hora local CDMX (no DST en 2026 para este ejemplo)
      startAt: '2026-09-20T07:30:00-06:00',
      endAt: '2026-09-20T08:45:00-06:00',
      startTimeZone: 'America/Mexico_City',
      endTimeZone: 'America/Mexico_City',
      origin: 'MEX — CDMX',
      destination: 'GDL — Guadalajara',
      flightNumber: 'DM100',
      notes: DEMO_MARK,
      ...stamp,
    },
    {
      id: ids.busOut,
      tripId: DEMO_TRIP_ID,
      type: 'bus',
      status: 'booked',
      title: '[FICTICIO] Autobús GDL → San Miguel el Alto',
      provider: 'Autobuses DEMO',
      confirmationNumber: 'DEMO-BUS-OUT',
      startAt: '2026-09-20T11:00:00-06:00',
      endAt: '2026-09-20T14:00:00-06:00',
      startTimeZone: 'America/Mexico_City',
      endTimeZone: 'America/Mexico_City',
      origin: 'Central Nueva, Guadalajara',
      destination: 'San Miguel el Alto',
      terminal: 'Central Nueva',
      phone: '+52-33-0000-0000',
      notes: DEMO_MARK,
      ...stamp,
    },
    {
      id: ids.lodging,
      tripId: DEMO_TRIP_ID,
      type: 'lodging',
      status: 'confirmed',
      title: '[FICTICIO] Hospedaje San Miguel el Alto',
      provider: 'Alojamiento DEMO',
      confirmationNumber: 'DEMO-STAY-001',
      startAt: '2026-09-20T15:00:00-06:00',
      endAt: '2026-09-29T11:00:00-06:00',
      startTimeZone: 'America/Mexico_City',
      endTimeZone: 'America/Mexico_City',
      address: 'Calle DEMO 123, Centro, San Miguel el Alto',
      phone: '+52-345-000-0000',
      notes: DEMO_MARK,
      ...stamp,
    },
    {
      id: ids.busBack,
      tripId: DEMO_TRIP_ID,
      type: 'bus',
      status: 'selected',
      title: '[FICTICIO] Autobús San Miguel el Alto → GDL',
      provider: 'Autobuses DEMO',
      confirmationNumber: 'DEMO-BUS-BACK',
      startAt: '2026-09-29T13:00:00-06:00',
      endAt: '2026-09-29T16:00:00-06:00',
      startTimeZone: 'America/Mexico_City',
      endTimeZone: 'America/Mexico_City',
      origin: 'San Miguel el Alto',
      destination: 'Central Nueva, Guadalajara',
      notes: DEMO_MARK,
      ...stamp,
    },
    {
      id: ids.flightBack,
      tripId: DEMO_TRIP_ID,
      type: 'flight',
      status: 'investigating',
      title: '[FICTICIO] Vuelo GDL → CDMX',
      provider: 'Aerolínea DEMO',
      confirmationNumber: 'DEMO-GDL-MEX-001',
      startAt: '2026-09-30T18:00:00-06:00',
      endAt: '2026-09-30T19:20:00-06:00',
      startTimeZone: 'America/Mexico_City',
      endTimeZone: 'America/Mexico_City',
      origin: 'GDL — Guadalajara',
      destination: 'MEX — CDMX',
      flightNumber: 'DM200',
      notes: DEMO_MARK,
      ...stamp,
    },
  ]
}

export function buildDemoItineraryItems(): ItineraryItem[] {
  return [
    {
      id: ids.itemFlightOut,
      tripId: DEMO_TRIP_ID,
      bookingId: ids.flightOut,
      bookingAnchor: 'departure',
      importance: 'crucial',
      goalIds: [goal.sinPrisas.id],
      notes: 'Ligado al booking — sin copiar horario.',
      ...stamp,
    },
    {
      id: ids.itemBusOut,
      tripId: DEMO_TRIP_ID,
      bookingId: ids.busOut,
      bookingAnchor: 'departure',
      importance: 'crucial',
      goalIds: [],
      ...stamp,
    },
    {
      id: ids.itemCheckIn,
      tripId: DEMO_TRIP_ID,
      bookingId: ids.lodging,
      bookingAnchor: 'check_in',
      title: 'Check-in hospedaje',
      importance: 'crucial',
      goalIds: [],
      ...stamp,
    },
    {
      id: ids.itemWalk,
      tripId: DEMO_TRIP_ID,
      title: '[FICTICIO] Caminata por el centro / plaza',
      startAt: '2026-09-20T18:00:00-06:00',
      endAt: '2026-09-20T20:00:00-06:00',
      startTimeZone: 'America/Mexico_City',
      place: 'Plaza principal (DEMO)',
      importance: 'recommended',
      goalIds: [goal.socializar.id, goal.fiestas.id],
      notes: 'Objetivo: socializar y vivir el ambiente de las fiestas.',
      ...stamp,
    },
    {
      id: ids.itemDinner,
      tripId: DEMO_TRIP_ID,
      title: '[FICTICIO] Cena — gastronomía local',
      startAt: '2026-09-20T20:30:00-06:00',
      endAt: '2026-09-20T22:00:00-06:00',
      startTimeZone: 'America/Mexico_City',
      place: 'Restaurante DEMO',
      importance: 'recommended',
      goalIds: [goal.gastro.id],
      ...stamp,
    },
    {
      id: ids.itemEvent,
      tripId: DEMO_TRIP_ID,
      title: '[FICTICIO] Evento principal — fiestas patronales',
      startAt: '2026-09-21T19:00:00-06:00',
      endAt: '2026-09-21T22:00:00-06:00',
      startTimeZone: 'America/Mexico_City',
      place: 'Atrio / plaza (DEMO)',
      importance: 'crucial',
      goalIds: [goal.fiestas.id, goal.tradiciones.id],
      ...stamp,
    },
    {
      id: ids.itemFree,
      tripId: DEMO_TRIP_ID,
      title: '[FICTICIO] Tarde libre',
      startAt: '2026-09-22T14:00:00-06:00',
      endAt: '2026-09-22T18:00:00-06:00',
      startTimeZone: 'America/Mexico_City',
      importance: 'optional',
      goalIds: [goal.sinPrisas.id],
      notes: 'Tiempo libre deliberado — sin agenda.',
      ...stamp,
    },
    {
      id: ids.itemCheckOut,
      tripId: DEMO_TRIP_ID,
      bookingId: ids.lodging,
      bookingAnchor: 'check_out',
      title: 'Check-out hospedaje',
      importance: 'crucial',
      goalIds: [],
      ...stamp,
    },
    {
      id: ids.itemBusBack,
      tripId: DEMO_TRIP_ID,
      bookingId: ids.busBack,
      bookingAnchor: 'departure',
      importance: 'crucial',
      goalIds: [],
      ...stamp,
    },
    {
      id: ids.itemFlightBack,
      tripId: DEMO_TRIP_ID,
      bookingId: ids.flightBack,
      bookingAnchor: 'departure',
      importance: 'crucial',
      goalIds: [],
      ...stamp,
    },
  ]
}

export function buildDemoReminders(): Array<AbsoluteReminder | RelativeReminder> {
  return [
    {
      id: ids.rem24h,
      tripId: DEMO_TRIP_ID,
      itineraryItemId: ids.itemFlightOut,
      kind: 'relative',
      anchor: 'start',
      offsetMinutes: -24 * 60,
      label: '[FICTICIO] Check-in online (24 h antes del vuelo)',
      done: false,
      ...stamp,
    },
    {
      id: ids.rem3h,
      tripId: DEMO_TRIP_ID,
      itineraryItemId: ids.itemFlightOut,
      kind: 'relative',
      anchor: 'start',
      offsetMinutes: -3 * 60,
      label: '[FICTICIO] Salir hacia el aeropuerto (3 h antes)',
      done: false,
      ...stamp,
    },
    {
      id: ids.remAbs,
      tripId: DEMO_TRIP_ID,
      itineraryItemId: ids.itemEvent,
      kind: 'absolute',
      triggerAt: '2026-09-21T12:00:00-06:00',
      label: '[FICTICIO] Revisar horario del evento (aviso absoluto)',
      done: false,
      ...stamp,
    },
  ]
}

export function buildDemoChecklist(): ChecklistItem[] {
  return [
    {
      id: 'demo-check-flight',
      tripId: DEMO_TRIP_ID,
      label: '[FICTICIO] Reservar vuelo',
      status: 'done',
      relatedBookingId: ids.flightOut,
      sortOrder: 1,
      ...stamp,
    },
    {
      id: 'demo-check-lodging',
      tripId: DEMO_TRIP_ID,
      label: '[FICTICIO] Reservar hospedaje',
      status: 'done',
      relatedBookingId: ids.lodging,
      sortOrder: 2,
      ...stamp,
    },
    {
      id: 'demo-check-receipt',
      tripId: DEMO_TRIP_ID,
      label: '[FICTICIO] Guardar comprobante',
      status: 'open',
      relatedBookingId: ids.lodging,
      sortOrder: 3,
      ...stamp,
    },
    {
      id: 'demo-check-checkin',
      tripId: DEMO_TRIP_ID,
      label: '[FICTICIO] Hacer check-in',
      status: 'open',
      relatedBookingId: ids.flightOut,
      sortOrder: 4,
      ...stamp,
    },
    {
      id: 'demo-check-boarding',
      tripId: DEMO_TRIP_ID,
      label: '[FICTICIO] Descargar pase de abordar',
      status: 'open',
      relatedBookingId: ids.flightOut,
      sortOrder: 5,
      ...stamp,
    },
  ]
}

export function buildDemoNote(): Note {
  return {
    id: ids.noteResearch,
    tripId: DEMO_TRIP_ID,
    title: '[FICTICIO] Investigación general',
    body: [
      DEMO_MARK,
      '',
      'Ideas a investigar (no verificadas):',
      '- Fechas y horarios de fiestas patronales',
      '- Opciones de autobus Guadalajara ↔ San Miguel el Alto',
      '- Lugares para socializar en la plaza',
      '- Comida tradicional local',
    ].join('\n'),
    ...stamp,
  }
}

/** Upsert full demo dataset into IndexedDB via services. */
export async function seedDemoTrip(services: Services): Promise<string> {
  const trip = buildDemoTrip()
  await services.trips.save(trip)

  for (const booking of buildDemoBookings()) {
    await services.bookings.save(booking)
  }
  for (const item of buildDemoItineraryItems()) {
    await services.itinerary.save(item)
  }
  for (const reminder of buildDemoReminders()) {
    await services.reminders.save(reminder)
  }
  for (const check of buildDemoChecklist()) {
    await services.checklist.save(check)
  }
  await services.notes.save(buildDemoNote())

  const demoPdf = new Blob(
    [
      '%PDF-1.4\n',
      '1 0 obj<< /Type /Catalog >>endobj\n',
      'trailer<< /Root 1 0 R >>\n',
      '%%EOF\n',
      `\n${DEMO_MARK}\nComprobante DEMO-MEX-GDL-001 — no es un boleto real.\n`,
    ],
    { type: 'application/pdf' },
  )
  await services.documents.save(
    {
      id: ids.docReservation,
      tripId: DEMO_TRIP_ID,
      name: '[FICTICIO] Reservación vuelo ida.pdf',
      type: 'reservation',
      mimeType: 'application/pdf',
      bookingId: ids.flightOut,
      itineraryItemId: ids.itemFlightOut,
      notes: DEMO_MARK,
    },
    demoPdf,
  )

  return DEMO_TRIP_ID
}

export { ids as demoIds, goal as demoGoals }
