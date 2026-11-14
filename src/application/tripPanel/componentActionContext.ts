import type {
  ComponentActionPayload,
  SharedTripPackageV1,
} from '../../../shared/agentContracts'
import type { TripPanelCard } from './types'
import type {
  ItineraryItem,
  TravelOption,
  Trip,
} from '../../domain/types'

export function optionToSnapshot(o: TravelOption): Record<string, unknown> {
  return {
    externalId: o.externalId ?? o.id,
    type: o.type,
    status:
      o.status === 'selected' || o.status === 'booked'
        ? 'shortlisted'
        : o.status === 'shortlisted' || o.status === 'researched'
          ? o.status
          : 'researched',
    title: o.title,
    provider: o.provider,
    description: o.description,
    startAt: o.startAt,
    endAt: o.endAt,
    origin: o.origin,
    destination: o.destination,
    address: o.address,
    phone: o.phone,
    priceObserved: o.priceObserved,
    currency: o.currency,
    sourceUrl: o.sourceUrl,
    checkedAt: o.checkedAt,
    verificationStatus: o.verificationStatus,
    sourceType: o.sourceType,
    notes: o.notes,
  }
}

export function buildRelatedSnapshots(
  target: TravelOption,
  options: TravelOption[],
  itinerary: ItineraryItem[],
): ComponentActionPayload['relatedSnapshots'] {
  const out: ComponentActionPayload['relatedSnapshots'] = []
  const tid = target.externalId ?? target.id
  for (const o of options) {
    const id = o.externalId ?? o.id
    if (id === tid) continue
    if (o.type === 'lodging') {
      out.push({
        componentId: id,
        componentKind: 'travelOption',
        componentType: o.type,
        relation: 'covers_nights',
        snapshot: optionToSnapshot(o),
      })
    }
    if (
      ['bus', 'train', 'transfer', 'car_rental'].includes(o.type) &&
      (o.origin === target.destination || o.destination === target.origin)
    ) {
      out.push({
        componentId: id,
        componentKind: 'travelOption',
        componentType: o.type,
        relation: 'next_leg',
        snapshot: optionToSnapshot(o),
      })
    }
  }
  for (const i of itinerary) {
    if (i.id.includes(tid) || /airport-arrival/.test(i.id)) {
      out.push({
        componentId: i.id.startsWith('airport-arrival')
          ? i.id
          : (i as { externalId?: string }).externalId ?? i.id,
        componentKind: 'itineraryItem',
        relation: 'airport_arrival',
        snapshot: {
          externalId: i.id,
          title: i.title,
          startAt: i.startAt,
          place: i.place,
          notes: i.notes,
        },
      })
    }
  }
  return out.slice(0, 8)
}

export function persistedToPackage(input: {
  trip: Trip
  options: TravelOption[]
  itinerary: ItineraryItem[]
  packageId: string
  revision: number
}): SharedTripPackageV1 {
  return {
    schemaVersion: 1,
    packageId: input.packageId,
    revision: input.revision,
    trip: {
      id: input.trip.id,
      title: input.trip.title,
      destination: input.trip.destination,
      startDate: input.trip.startDate,
      endDate: input.trip.endDate,
      timezone: input.trip.timezone,
      goals: input.trip.goals.map((g) => g.label),
      status: input.trip.status,
      notes: input.trip.notes,
    },
    travelOptions: input.options.map((o) => {
      const s = optionToSnapshot(o)
      return {
        externalId: String(s.externalId),
        type: o.type,
        status: s.status as 'researched' | 'shortlisted',
        title: o.title,
        provider: o.provider,
        description: o.description,
        startAt: o.startAt,
        endAt: o.endAt,
        origin: o.origin,
        destination: o.destination,
        address: o.address,
        phone: o.phone,
        priceObserved: o.priceObserved,
        currency: o.currency,
        sourceUrl: o.sourceUrl,
        checkedAt: o.checkedAt,
        verificationStatus: o.verificationStatus,
        sourceType: o.sourceType ?? 'agent',
        notes: o.notes,
      }
    }),
    itineraryItems: input.itinerary.map((i) => ({
      externalId: i.id,
      title: i.title || 'Actividad',
      startAt: i.startAt,
      endAt: i.endAt,
      place: i.place,
      importance: i.importance,
      notes: i.notes,
    })),
    checklistItems: [],
    notes: [],
  }
}

export function cardComponentType(card: TripPanelCard): string {
  if (card.optionType) return card.optionType
  if (card.kind === 'flight_out' || card.kind === 'flight_return') return 'flight'
  if (card.kind === 'lodging') return 'lodging'
  if (card.kind === 'ground') return 'transfer'
  if (card.kind === 'activity') return 'activity'
  return 'other'
}
