/**
 * Domain model — Viajes
 *
 * Datetimes: ISO 8601 strings WITH numeric offset (e.g. 2026-09-20T07:30:00-06:00).
 * That preserves both the absolute instant and the local wall-clock at origin/destination.
 * Optional IANA zones (startTimeZone / endTimeZone) label and support DST-aware edits.
 * Trip.timezone is the default reference zone for the trip (e.g. "today"), not a global assumption.
 */

export type SyncStatus = 'local' | 'pending' | 'synced' | 'conflict'

export type TripStatus = 'planned' | 'active' | 'archived'

export type BookingType =
  | 'flight'
  | 'bus'
  | 'train'
  | 'lodging'
  | 'transfer'
  | 'restaurant'
  | 'activity'
  | 'event'
  | 'ticket'
  | 'other'

export type BookingStatus =
  | 'investigating'
  | 'selected'
  | 'ready_to_book'
  | 'booked'
  | 'confirmed'
  | 'cancelled'

export type Importance = 'crucial' | 'recommended' | 'optional'

export type BookingAnchor =
  | 'start'
  | 'end'
  | 'check_in'
  | 'check_out'
  | 'departure'
  | 'arrival'

export type DocumentType =
  | 'reservation'
  | 'boarding_pass'
  | 'ticket'
  | 'receipt'
  | 'insurance'
  | 'id_scan'
  | 'photo'
  | 'other'

export type ChecklistStatus = 'open' | 'done'

export type ReminderAnchor = 'start' | 'end'

export interface TravelGoal {
  id: string
  label: string
}

export interface Trip {
  id: string
  title: string
  destination?: string
  /** Inclusive trip range as calendar dates (YYYY-MM-DD), interpreted in Trip.timezone. */
  startDate: string
  endDate: string
  /** Default IANA timezone for the trip (reference / "today"), not the only zone used. */
  timezone: string
  goals: TravelGoal[]
  status: TripStatus
  notes?: string
  createdAt: string
  updatedAt: string
  syncStatus: SyncStatus
}

export interface Booking {
  id: string
  tripId: string
  type: BookingType
  status: BookingStatus
  title: string
  provider?: string
  confirmationNumber?: string
  /** ISO 8601 with offset — local time at origin / start place. */
  startAt?: string
  /** ISO 8601 with offset — local time at destination / end place (may differ from startAt zone). */
  endAt?: string
  /** IANA zone for startAt wall clock (optional; offset in startAt is authoritative for the instant). */
  startTimeZone?: string
  /** IANA zone for endAt wall clock when origin and destination differ. */
  endTimeZone?: string
  origin?: string
  destination?: string
  address?: string
  phone?: string
  contactName?: string
  instructions?: string
  cost?: number
  currency?: string
  cancellationPolicy?: string
  externalUrl?: string
  notes?: string
  flightNumber?: string
  seat?: string
  gate?: string
  terminal?: string
  createdAt: string
  updatedAt: string
  syncStatus: SyncStatus
}

/**
 * Timeline slot. When bookingId is set, schedule/place come from Booking via
 * bookingAnchor — resolved in the application layer (no cached startAt/endAt).
 */
export interface ItineraryItem {
  id: string
  tripId: string
  bookingId?: string
  bookingAnchor?: BookingAnchor
  /** Required when there is no bookingId; optional display override when linked. */
  title?: string
  /** Required when there is no bookingId. ISO 8601 with offset. Ignored when linked. */
  startAt?: string
  endAt?: string
  startTimeZone?: string
  endTimeZone?: string
  /** Only for free-form items; linked items derive place from Booking. */
  place?: string
  importance: Importance
  goalIds: string[]
  notes?: string
  createdAt: string
  updatedAt: string
  syncStatus: SyncStatus
}

interface ReminderBase {
  id: string
  tripId: string
  itineraryItemId: string
  label: string
  done: boolean
  createdAt: string
  updatedAt: string
  syncStatus: SyncStatus
}

/** Fires at a fixed instant (ISO 8601 with offset). */
export interface AbsoluteReminder extends ReminderBase {
  kind: 'absolute'
  triggerAt: string
}

/**
 * Fires relative to the resolved start/end of the linked ItineraryItem
 * (which may itself come from a Booking). offsetMinutes is negative for "before".
 * Re-resolved automatically when the underlying schedule changes.
 */
export interface RelativeReminder extends ReminderBase {
  kind: 'relative'
  anchor: ReminderAnchor
  offsetMinutes: number
}

export type Reminder = AbsoluteReminder | RelativeReminder

export interface DocumentMeta {
  id: string
  tripId: string
  name: string
  type: DocumentType
  mimeType: string
  sizeBytes: number
  capturedAt?: string
  notes?: string
  bookingId?: string
  itineraryItemId?: string
  createdAt: string
  updatedAt: string
  syncStatus: SyncStatus
}

export interface DocumentBlobRecord {
  id: string
  tripId: string
  blob: Blob
}

export interface ChecklistItem {
  id: string
  tripId: string
  label: string
  status: ChecklistStatus
  dueAt?: string
  relatedBookingId?: string
  sortOrder: number
  createdAt: string
  updatedAt: string
  syncStatus: SyncStatus
}

export interface Note {
  id: string
  tripId: string
  title?: string
  body: string
  createdAt: string
  updatedAt: string
  syncStatus: SyncStatus
}

/** Researched option — NOT a confirmed Booking. */
export type TravelOptionType =
  | 'flight'
  | 'lodging'
  | 'bus'
  | 'train'
  | 'transfer'
  | 'car_rental'
  | 'restaurant'
  | 'activity'
  | 'event'
  | 'other'

export type TravelOptionStatus =
  | 'researched'
  | 'shortlisted'
  | 'selected'
  | 'booked'
  | 'rejected'

export type VerificationStatus = 'verified' | 'estimated' | 'unverified'

export type TravelOptionSourceType =
  | 'cursor'
  | 'manual'
  | 'imported'
  | 'agent'
  | 'other'

/**
 * Lightweight researched option. Never treat researched/shortlisted/selected
 * as a confirmed Booking — only status `booked` (+ bookingId) means converted.
 */
export interface TravelOption {
  id: string
  tripId: string
  type: TravelOptionType
  status: TravelOptionStatus
  title: string
  provider?: string
  description?: string
  startAt?: string
  endAt?: string
  origin?: string
  destination?: string
  address?: string
  phone?: string
  priceObserved?: number
  currency?: string
  sourceUrl?: string
  /** When the web source was last checked (ISO with offset preferred). */
  checkedAt?: string
  verificationStatus?: VerificationStatus
  sourceType: TravelOptionSourceType
  notes?: string
  /** Stable id from the research package (dedupe / re-import). */
  externalId?: string
  /** TripPackage.packageId that created this option. */
  packageId?: string
  /** Set when converted to a managed Booking. */
  bookingId?: string
  createdAt: string
  updatedAt: string
  syncStatus: SyncStatus
}

/** Record of an imported TripPackage — identity for research revisions. */
export interface PackageImport {
  /** Same as TripPackage.packageId */
  id: string
  tripId: string
  title: string
  /** Last successful import/upsert time. */
  importedAt: string
  optionCount: number
  schemaVersion: number
  /** Last applied package revision (TripPackage.revision). */
  revision?: number
  /** TripPackage.generatedAt from the last applied package. */
  generatedAt?: string
}

/** Application-layer view after joining Booking → ItineraryItem. */
export interface ResolvedItineraryItem {
  item: ItineraryItem
  booking?: Booking
  title: string
  startAt?: string
  endAt?: string
  startTimeZone?: string
  endTimeZone?: string
  place?: string
  importance: Importance
  goalIds: string[]
}
