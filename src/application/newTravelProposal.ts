import type {
  AgentProposal,
  SharedTripPackageV1,
} from '../../shared/agentContracts'
import { validateTripPackage } from './tripPackage'

/** Marker for missing / unconfirmed fields in Nuevo viaje proposals. */
export const UNKNOWN = 'UNKNOWN'

export type NewTravelSummary = {
  title: string
  /** UI draft label — domain persists as `planned` (no separate DRAFT status). */
  draftLabel: 'DRAFT'
  domainStatus: 'planned'
  startDate: string
  endDate: string
  durationDays: number
  origin: string
  destinations: string[]
  transport: Array<{
    title: string
    type: string
    verification: string
    sourceUrl?: string
  }>
  lodging: Array<{
    title: string
    verification: string
    sourceUrl?: string
  }>
  itinerary: Array<{ title: string; startAt?: string; place?: string }>
  notes: Array<{ title?: string; body: string }>
  pending: Array<{ label: string }>
  sources: string[]
  warnings: string[]
}

function inclusiveDurationDays(startDate: string, endDate: string): number {
  const a = Date.parse(`${startDate}T12:00:00Z`)
  const b = Date.parse(`${endDate}T12:00:00Z`)
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0
  return Math.floor((b - a) / 86_400_000) + 1
}

function collectOrigins(pkg: SharedTripPackageV1): string {
  const fromFlights = pkg.travelOptions
    .filter((o) => o.type === 'flight' || o.type === 'bus' || o.type === 'train')
    .map((o) => o.origin?.trim())
    .filter((v): v is string => Boolean(v))
  return fromFlights[0] ?? UNKNOWN
}

function collectDestinations(pkg: SharedTripPackageV1): string[] {
  const out: string[] = []
  const push = (v?: string) => {
    const s = v?.trim()
    if (!s || s === UNKNOWN) return
    if (!out.includes(s)) out.push(s)
  }
  push(pkg.trip.destination)
  for (const o of pkg.travelOptions) {
    if (o.type === 'lodging' || o.type === 'activity' || o.type === 'event') {
      push(o.destination ?? o.address ?? o.title)
    } else {
      push(o.destination)
    }
  }
  return out.length > 0 ? out : [UNKNOWN]
}

function collectSources(pkg: SharedTripPackageV1): string[] {
  const urls = new Set<string>()
  for (const o of pkg.travelOptions) {
    if (o.sourceUrl) urls.add(o.sourceUrl)
  }
  return [...urls]
}

/**
 * Build a human-readable summary for the Nuevo viaje preview.
 * Missing operational fields surface as UNKNOWN — never invent values here.
 */
export function summarizeNewTravelProposal(
  proposal: AgentProposal,
): NewTravelSummary {
  const pkg = proposal.package
  const transport = pkg.travelOptions
    .filter((o) =>
      ['flight', 'bus', 'train', 'transfer', 'car_rental'].includes(o.type),
    )
    .map((o) => ({
      title: o.title,
      type: o.type,
      verification: o.verificationStatus ?? UNKNOWN,
      sourceUrl: o.sourceUrl,
    }))
  const lodging = pkg.travelOptions
    .filter((o) => o.type === 'lodging')
    .map((o) => ({
      title: o.title,
      verification: o.verificationStatus ?? UNKNOWN,
      sourceUrl: o.sourceUrl,
    }))

  return {
    title: pkg.trip.title || UNKNOWN,
    draftLabel: 'DRAFT',
    domainStatus: 'planned',
    startDate: pkg.trip.startDate || UNKNOWN,
    endDate: pkg.trip.endDate || UNKNOWN,
    durationDays: inclusiveDurationDays(pkg.trip.startDate, pkg.trip.endDate),
    origin: collectOrigins(pkg),
    destinations: collectDestinations(pkg),
    transport,
    lodging,
    itinerary: pkg.itineraryItems.map((i) => ({
      title: i.title,
      startAt: i.startAt,
      place: i.place,
    })),
    notes: pkg.notes.map((n) => ({ title: n.title, body: n.body })),
    pending: pkg.checklistItems.map((c) => ({ label: c.label })),
    sources: collectSources(pkg),
    warnings: [...proposal.warnings],
  }
}

/**
 * Ensure a Nuevo viaje package is creatable: Zod-valid, planned status,
 * no booking-like statuses, and no price without currency.
 */
export function prepareNewTravelPackage(
  proposal: AgentProposal,
):
  | { ok: true; proposal: AgentProposal; summary: NewTravelSummary }
  | { ok: false; errors: string[] } {
  const errors: string[] = []
  const pkg = structuredClone(proposal.package)

  pkg.trip.status = 'planned'
  if (!pkg.trip.title?.trim()) errors.push('trip.title es obligatorio')
  if (!pkg.trip.startDate || !pkg.trip.endDate) {
    errors.push('trip.startDate y trip.endDate son obligatorios')
  }

  for (const opt of pkg.travelOptions) {
    if (
      opt.status === ('selected' as string) ||
      opt.status === ('booked' as string) ||
      opt.status === ('rejected' as string)
    ) {
      errors.push(
        `travelOption ${opt.externalId}: status de decisión no permitido en Nuevo viaje`,
      )
    }
    if (opt.priceObserved !== undefined && !opt.currency) {
      errors.push(
        `travelOption ${opt.externalId}: priceObserved requiere currency`,
      )
    }
  }

  // Never persist Bookings from Nuevo viaje — package has none by contract.
  const validated = validateTripPackage(pkg)
  if (!validated.ok) {
    for (const e of validated.errors) {
      errors.push(`${e.path}: ${e.message}`)
    }
  }

  if (errors.length > 0) return { ok: false, errors }

  const next: AgentProposal = {
    ...proposal,
    package: validated.ok ? validated.package : pkg,
  }
  // Force planned after validation defaults
  next.package.trip.status = 'planned'

  return {
    ok: true,
    proposal: next,
    summary: summarizeNewTravelProposal(next),
  }
}

/** Discard is a pure no-op on persistence — returns null proposal state. */
export function discardNewTravelProposal(): null {
  return null
}
