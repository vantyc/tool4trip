import { z } from 'zod'

/** Agent-writable package option statuses (mirror TripPackage). */
export const PACKAGE_OPTION_STATUSES = ['researched', 'shortlisted'] as const

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
    'Datetime debe ser ISO 8601 con offset',
  )

const httpUrl = z
  .string()
  .url()
  .refine((u) => /^https?:\/\//i.test(u), 'URL debe usar http o https')

const currencyCode = z
  .string()
  .regex(/^[A-Z]{3}$/, 'Moneda debe ser ISO 4217')

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

const packageOptionStatus = z.enum(PACKAGE_OPTION_STATUSES)
const verificationStatus = z.enum(['verified', 'estimated', 'unverified'])
const sourceType = z.enum(['cursor', 'manual', 'imported', 'agent', 'other'])

const externalId = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/)

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
    sourceType: sourceType.default('agent'),
    notes: z.string().optional(),
  })
  .strict()
  .superRefine((opt, ctx) => {
    if (opt.priceObserved !== undefined && opt.currency === undefined) {
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
    importance: z.enum(['crucial', 'recommended', 'optional']).default('optional'),
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

/** TripPackage v1 — same contract as PWA import. */
export const tripPackageV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    packageId: z.string().min(1),
    revision: z.number().int().min(1).default(1),
    generatedAt: isoWithOffset.optional(),
    trip: packageTripSchema,
    travelOptions: z.array(packageTravelOptionSchema).default([]),
    itineraryItems: z.array(packageItineraryItemSchema).default([]),
    checklistItems: z.array(packageChecklistItemSchema).default([]),
    notes: z.array(packageNoteSchema).default([]),
  })
  .strict()

export type SharedTripPackageV1 = z.infer<typeof tripPackageV1Schema>

export const agentOpSchema = z.enum(['add', 'update', 'supersede', 'noop'])

export const agentDiffLineSchema = z
  .object({
    entityKind: z.enum([
      'trip',
      'travelOption',
      'itineraryItem',
      'checklistItem',
      'note',
      'other',
    ]),
    entityRef: z.string().optional(),
    op: agentOpSchema,
    before: z.string().optional(),
    after: z.string().optional(),
    note: z.string().optional(),
  })
  .strict()

/** Reserved for future supersede; Fase 1 may omit or mirror package. */
export const agentOpRecordSchema = z
  .object({
    op: agentOpSchema,
    entityKind: z.enum([
      'travelOption',
      'itineraryItem',
      'checklistItem',
      'note',
    ]),
    externalId: z.string().min(1),
    supersedesExternalId: z.string().min(1).optional(),
    note: z.string().optional(),
  })
  .strict()

export const toolTraceEntrySchema = z
  .object({
    tool: z.string().min(1),
    args: z.record(z.unknown()).optional(),
    ok: z.boolean(),
    sources: z
      .array(
        z.object({
          url: z.string().url().optional(),
          title: z.string().optional(),
          snippet: z.string().optional(),
        }),
      )
      .default([]),
    error: z.string().optional(),
    checkedAt: z.string().optional(),
  })
  .strict()

export const agentProposalSchema = z
  .object({
    proposalId: z.string().min(1),
    createdAt: z.string().min(1),
    narrative: z.string().min(1),
    warnings: z.array(z.string()).default([]),
    diffSummary: z.array(agentDiffLineSchema).default([]),
    package: tripPackageV1Schema,
    ops: z.array(agentOpRecordSchema).default([]),
    toolTrace: z.array(toolTraceEntrySchema).default([]),
    estimatedCostDelta: z
      .object({
        amount: z.number(),
        currency: currencyCode,
        confidence: z.enum(['estimated', 'unverified', 'verified']).optional(),
      })
      .optional(),
  })
  .strict()

export type AgentProposal = z.infer<typeof agentProposalSchema>
export type ToolTraceEntry = z.infer<typeof toolTraceEntrySchema>

/** Compact trip context from Dexie — sent to travel-agent. */
export const tripContextSnapshotSchema = z
  .object({
    trip: z.record(z.unknown()),
    bookings: z.array(z.record(z.unknown())).default([]),
    travelOptions: z.array(z.record(z.unknown())).default([]),
    itineraryItems: z.array(z.record(z.unknown())).default([]),
    checklistItems: z.array(z.record(z.unknown())).default([]),
    notes: z.array(z.record(z.unknown())).default([]),
    packageImports: z.array(z.record(z.unknown())).default([]),
  })
  .strict()

export type TripContextSnapshot = z.infer<typeof tripContextSnapshotSchema>

export const agentAskModeSchema = z.enum(['ask', 'new_travel'])

export type AgentAskMode = z.infer<typeof agentAskModeSchema>

export const agentAskRequestSchema = z
  .object({
    prompt: z.string().min(1).max(8000),
    tripId: z.string().min(1),
    context: tripContextSnapshotSchema,
    locale: z.string().optional(),
    /** ask = mutate/query existing trip; new_travel = create trip from prompt */
    mode: agentAskModeSchema.default('ask'),
  })
  .strict()

export type AgentAskRequest = z.infer<typeof agentAskRequestSchema>

/** Async Ask Travel job lifecycle. */
export const agentJobStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
])

export type AgentJobStatus = z.infer<typeof agentJobStatusSchema>

export const agentJobCreateResponseSchema = z
  .object({
    jobId: z.string().min(1),
    status: z.literal('queued'),
  })
  .strict()

export type AgentJobCreateResponse = z.infer<typeof agentJobCreateResponseSchema>

export const agentJobErrorSchema = z
  .object({
    message: z.string().min(1),
    code: z.string().optional(),
  })
  .strict()

export const agentJobStatusResponseSchema = z
  .object({
    jobId: z.string().min(1),
    status: agentJobStatusSchema,
    createdAt: z.string().min(1),
    startedAt: z.string().optional(),
    finishedAt: z.string().optional(),
    progress: z.string().optional(),
    toolTrace: z.array(toolTraceEntrySchema).optional(),
    proposal: agentProposalSchema.optional(),
    error: agentJobErrorSchema.optional(),
  })
  .strict()

export type AgentJobStatusResponse = z.infer<typeof agentJobStatusResponseSchema>
