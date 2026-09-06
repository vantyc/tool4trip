import { z } from 'zod'

/** Supported TripPackage schema versions. */
export const TRIP_PACKAGE_SCHEMA_VERSION = 1 as const

/** Statuses an agent may set via TripPackage import. */
export const PACKAGE_OPTION_STATUSES = ['researched', 'shortlisted'] as const

/** Statuses that represent traveler decisions — never imposed by import. */
export const USER_DECISION_STATUSES = [
  'selected',
  'booked',
  'rejected',
] as const

const dateYmd = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha debe ser YYYY-MM-DD')

const isoWithOffset = z
  .string()
  .min(1)
  .refine(
    (v) =>
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) &&
      (/[+-]\d{2}:\d{2}$/.test(v) || /Z$/i.test(v)),
    'Datetime debe ser ISO 8601 con offset (ej. 2026-09-25T07:30:00-06:00)',
  )

const httpUrl = z
  .string()
  .url()
  .refine(
    (u) => /^https?:\/\//i.test(u),
    'URL debe usar http o https',
  )

const currencyCode = z
  .string()
  .regex(/^[A-Z]{3}$/, 'Moneda debe ser ISO 4217 (ej. MXN, USD)')

const travelOptionType = z.enum([
  'flight',
  'lodging',
  'bus',
  'train',
  'transfer',
  'car_rental',
  'restaurant',
  'activity',
  'event',
  'other',
])

/** Agent-writable statuses only — selected/booked/rejected are rejected. */
const packageOptionStatus = z.enum(PACKAGE_OPTION_STATUSES)

const verificationStatus = z.enum(['verified', 'estimated', 'unverified'])

const sourceType = z.enum(['cursor', 'manual', 'imported', 'other'])

const importance = z.enum(['crucial', 'recommended', 'optional'])

const externalId = z
  .string()
  .min(1)
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/,
    'externalId debe ser estable (letras, números, . _ -)',
  )

const packageTripSchema = z
  .object({
    id: z.string().min(1).optional(),
    title: z.string().min(1),
    destination: z.string().min(1).optional(),
    startDate: dateYmd,
    endDate: dateYmd,
    timezone: z.string().min(1).default('America/Mexico_City'),
    goals: z.array(z.string().min(1)).default([]),
    notes: z.string().optional(),
    status: z.enum(['planned', 'active', 'archived']).default('planned'),
  })
  .strict()
  .refine((t) => t.endDate >= t.startDate, {
    message: 'endDate debe ser >= startDate',
    path: ['endDate'],
  })

const packageTravelOptionSchema = z
  .object({
    externalId,
    type: travelOptionType,
    status: packageOptionStatus.default('researched'),
    title: z.string().min(1),
    provider: z.string().min(1).optional(),
    description: z.string().optional(),
    startAt: isoWithOffset.optional(),
    endAt: isoWithOffset.optional(),
    origin: z.string().optional(),
    destination: z.string().optional(),
    address: z.string().optional(),
    phone: z.string().optional(),
    priceObserved: z.number().nonnegative().optional(),
    currency: currencyCode.optional(),
    sourceUrl: httpUrl.optional(),
    checkedAt: isoWithOffset.optional(),
    verificationStatus: verificationStatus.optional(),
    sourceType: sourceType.default('cursor'),
    notes: z.string().optional(),
  })
  .strict()
  .superRefine((opt, ctx) => {
    if (
      opt.priceObserved !== undefined &&
      opt.currency === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'currency es obligatorio cuando hay priceObserved',
        path: ['currency'],
      })
    }
  })

const packageItineraryItemSchema = z
  .object({
    externalId,
    title: z.string().min(1),
    startAt: isoWithOffset.optional(),
    endAt: isoWithOffset.optional(),
    place: z.string().optional(),
    importance: importance.default('recommended'),
    notes: z.string().optional(),
  })
  .strict()

const packageChecklistItemSchema = z
  .object({
    externalId,
    label: z.string().min(1),
    dueAt: isoWithOffset.optional(),
    sortOrder: z.number().int().nonnegative().optional(),
  })
  .strict()

const packageNoteSchema = z
  .object({
    externalId,
    title: z.string().optional(),
    body: z.string().min(1),
  })
  .strict()

/**
 * TripPackage v1 — research import contract.
 * Unknown keys are rejected (.strict()) to catch incompatible versions early.
 * No Booking / Document blobs in this version.
 */
export const tripPackageV1Schema = z
  .object({
    schemaVersion: z.literal(TRIP_PACKAGE_SCHEMA_VERSION),
    /**
     * Stable research identity across revisions (e.g. sma-2026-research).
     * Re-importing upserts by externalId; does not wipe user decisions.
     */
    packageId: z.string().min(1),
    /** Monotonic revision of this research package (1, 2, …). */
    revision: z.number().int().positive().default(1),
    /** When this package JSON was generated (ISO with offset). */
    generatedAt: isoWithOffset.optional(),
    trip: packageTripSchema,
    travelOptions: z.array(packageTravelOptionSchema).default([]),
    itineraryItems: z.array(packageItineraryItemSchema).default([]),
    checklistItems: z.array(packageChecklistItemSchema).default([]),
    notes: z.array(packageNoteSchema).default([]),
  })
  .strict()
  .superRefine((pkg, ctx) => {
    const seen = new Set<string>()
    for (let i = 0; i < pkg.travelOptions.length; i++) {
      const id = pkg.travelOptions[i]!.externalId
      if (seen.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `externalId duplicado en el paquete: ${id}`,
          path: ['travelOptions', i, 'externalId'],
        })
      }
      seen.add(id)
    }
  })

export type TripPackageV1 = z.infer<typeof tripPackageV1Schema>
export type PackageTravelOption = TripPackageV1['travelOptions'][number]

export type PackageValidationError = {
  path: string
  message: string
}

export type PackageValidationResult =
  | { ok: true; package: TripPackageV1 }
  | { ok: false; errors: PackageValidationError[] }

const FORBIDDEN_STATUS_HINT =
  'TripPackage solo puede usar researched|shortlisted; selected/booked/rejected son decisiones del viajero en la PWA'

function rejectForbiddenOptionStatuses(
  input: unknown,
): PackageValidationError[] | null {
  if (typeof input !== 'object' || input === null) return null
  const opts = (input as { travelOptions?: unknown }).travelOptions
  if (!Array.isArray(opts)) return null
  const errors: PackageValidationError[] = []
  for (let i = 0; i < opts.length; i++) {
    const o = opts[i]
    if (typeof o !== 'object' || o === null) continue
    const status = (o as { status?: unknown }).status
    if (
      status === 'selected' ||
      status === 'booked' ||
      status === 'rejected'
    ) {
      errors.push({
        path: `travelOptions.${i}.status`,
        message: FORBIDDEN_STATUS_HINT,
      })
    }
  }
  return errors.length ? errors : null
}

export function validateTripPackage(input: unknown): PackageValidationResult {
  const forbidden = rejectForbiddenOptionStatuses(input)
  if (forbidden) {
    return { ok: false, errors: forbidden }
  }

  const parsed = tripPackageV1Schema.safeParse(input)
  if (parsed.success) {
    return { ok: true, package: parsed.data }
  }

  if (
    typeof input === 'object' &&
    input !== null &&
    'schemaVersion' in input &&
    (input as { schemaVersion: unknown }).schemaVersion !==
      TRIP_PACKAGE_SCHEMA_VERSION
  ) {
    return {
      ok: false,
      errors: [
        {
          path: 'schemaVersion',
          message: `schemaVersion no soportado (esperado ${TRIP_PACKAGE_SCHEMA_VERSION})`,
        },
      ],
    }
  }

  return {
    ok: false,
    errors: parsed.error.issues.map((issue) => ({
      path: issue.path.length ? issue.path.join('.') : '(root)',
      message: issue.message,
    })),
  }
}

export function summarizePackage(pkg: TripPackageV1) {
  const byType = (type: string) =>
    pkg.travelOptions.filter((o) => o.type === type).length
  return {
    title: pkg.trip.title,
    destination: pkg.trip.destination,
    startDate: pkg.trip.startDate,
    endDate: pkg.trip.endDate,
    packageId: pkg.packageId,
    revision: pkg.revision,
    generatedAt: pkg.generatedAt,
    optionCount: pkg.travelOptions.length,
    flights: byType('flight'),
    lodging: byType('lodging'),
    transport: pkg.travelOptions.filter((o) =>
      ['bus', 'train', 'transfer', 'car_rental'].includes(o.type),
    ).length,
    activities: pkg.travelOptions.filter((o) =>
      ['activity', 'event', 'restaurant'].includes(o.type),
    ).length,
    other: pkg.travelOptions.filter((o) => o.type === 'other').length,
    itineraryCount: pkg.itineraryItems.length,
    checklistCount: pkg.checklistItems.length,
    notesCount: pkg.notes.length,
  }
}

export function optionEntityId(
  packageId: string,
  externalId: string,
): string {
  return `opt-${packageId}-${externalId}`
}

export function itineraryEntityId(
  packageId: string,
  externalId: string,
): string {
  return `itin-${packageId}-${externalId}`
}

export function checklistEntityId(
  packageId: string,
  externalId: string,
): string {
  return `chk-${packageId}-${externalId}`
}

export function noteEntityId(
  packageId: string,
  externalId: string,
): string {
  return `note-${packageId}-${externalId}`
}
