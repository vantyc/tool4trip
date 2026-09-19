/**
 * Presentation view-model for TripPanel widgets.
 * Pure transforms over existing package / entity JSON — no persistence changes.
 */

export type VisualStatus =
  | 'confirmed'
  | 'verified'
  | 'estimated'
  | 'pending'
  | 'alternative'
  | 'missing'

export type TripPanelCardKind =
  | 'flight_out'
  | 'flight_return'
  | 'ground'
  | 'lodging'
  | 'activity'
  | 'checklist'
  | 'note'
  | 'source'
  | 'missing_slot'

/** Policy-derived airport desk arrival (not LLM-invented). */
export type AirportArrivalInfo = {
  deskAt: string
  onlineAt: string
  deskMinutes: number
  onlineMinutes: number
  scope: 'domestic' | 'international'
  airportLabel: string
}

export type TripPanelCard = {
  id: string
  kind: TripPanelCardKind
  title: string
  status: VisualStatus
  /** Only set when present with provenance — UI must not invent. */
  startAt?: string
  endAt?: string
  origin?: string
  destination?: string
  provider?: string
  price?: number
  currency?: string
  sourceUrl?: string
  place?: string
  notes?: string
  body?: string
  /** FlightCard only — derived from startAt via airportArrivalPolicy. */
  airportArrival?: AirportArrivalInfo
}

export type IntegrityLight = 'green' | 'amber' | 'red'

export type TripPanelDiagnostics = {
  verifiedCount: number
  pendingCount: number
  missingCount: number
  sourceCount: number
  warnings: string[]
  /** True when Create should ask for draft confirmation. */
  needsCreateConfirm: boolean
  integrityLight: IntegrityLight
}

export type TripPanelHeader = {
  title: string
  statusLabel: string
  origin?: string
  destinations: string[]
  startDate?: string
  endDate?: string
  days?: number
  nights?: number
  budgetAmount?: number
  budgetCurrency?: string
  budgetConfidence?: string
  progressPct: number
}

export type TripPanelModel = {
  header: TripPanelHeader
  diagnostics: TripPanelDiagnostics
  flightsOut: TripPanelCard[]
  flightsReturn: TripPanelCard[]
  ground: TripPanelCard[]
  lodging: TripPanelCard[]
  activities: TripPanelCard[]
  checklist: TripPanelCard[]
  notes: TripPanelCard[]
  sources: TripPanelCard[]
  /** Short executive blurb (truncated narrative). */
  executiveSummary?: string
  /** Collapsible technical payload. */
  technical?: {
    narrative?: string
    /** Agent/server warnings only (not integrity diagnostics). */
    warnings: string[]
    jsonText?: string
  }
}

export const VISUAL_STATUS_LABEL: Record<VisualStatus, string> = {
  confirmed: 'Confirmado',
  verified: 'Verificado',
  estimated: 'Estimado',
  pending: 'Pendiente',
  alternative: 'Alternativa',
  missing: 'Faltante',
}
