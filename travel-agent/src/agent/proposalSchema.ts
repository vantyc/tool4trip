import type { ChatCompletionParams } from '../llm/types.ts'

/** Nullable string for OpenAI-compatible strict json_schema (all keys must be required). */
const strOrNull = { type: ['string', 'null'] as const }
const numOrNull = { type: ['number', 'null'] as const }

/**
 * OpenAI-compatible json_schema for the LLM-produced AgentProposal draft (strict).
 * Server-owned fields (proposalId, createdAt, toolTrace) are NOT requested from the model.
 * Use only on final/repair turns without tools. Zod remains authoritative after hydration.
 */
export const agentProposalJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'narrative',
    'warnings',
    'diffSummary',
    'package',
    'ops',
    'claims',
  ],
  properties: {
    narrative: { type: 'string' },
    warnings: { type: 'array', items: { type: 'string' } },
    /**
     * Internal grounding claims (AgentRuntime only). Stripped before public AgentProposal.
     * Every operational fact in narrative/diff/package must be backed by a valid claim.
     */
    claims: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'kind',
          'statement',
          'sourceType',
          'sourceUrl',
          'evidenceIndex',
          'entityType',
          'entityId',
          'field',
          'verificationStatus',
          'confidence',
        ],
        properties: {
          kind: {
            type: 'string',
            enum: [
              'price',
              'currency',
              'schedule',
              'availability',
              'service_status',
              'transport_mode',
              'other_factual',
            ],
          },
          statement: { type: 'string' },
          sourceType: { type: 'string', enum: ['web', 'context'] },
          sourceUrl: strOrNull,
          evidenceIndex: numOrNull,
          entityType: {
            type: ['string', 'null'],
            enum: [
              'trip',
              'travelOption',
              'booking',
              'itineraryItem',
              'checklistItem',
              'note',
              null,
            ],
          },
          entityId: strOrNull,
          field: strOrNull,
          verificationStatus: {
            type: 'string',
            enum: ['verified', 'estimated', 'unverified'],
          },
          confidence: {
            type: 'string',
            enum: ['high', 'medium', 'low'],
          },
        },
      },
    },
    diffSummary: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['entityKind', 'entityRef', 'op', 'before', 'after', 'note'],
        properties: {
          entityKind: {
            type: 'string',
            enum: [
              'trip',
              'travelOption',
              'itineraryItem',
              'checklistItem',
              'note',
              'other',
            ],
          },
          entityRef: strOrNull,
          op: {
            type: 'string',
            enum: ['add', 'update', 'supersede', 'noop'],
          },
          before: strOrNull,
          after: strOrNull,
          note: strOrNull,
        },
      },
    },
    package: {
      type: 'object',
      additionalProperties: false,
      required: [
        'schemaVersion',
        'packageId',
        'revision',
        'generatedAt',
        'trip',
        'travelOptions',
        'itineraryItems',
        'checklistItems',
        'notes',
      ],
      properties: {
        schemaVersion: { type: 'number', enum: [1] },
        packageId: { type: 'string' },
        revision: { type: 'number' },
        generatedAt: strOrNull,
        trip: {
          type: 'object',
          additionalProperties: false,
          required: [
            'id',
            'title',
            'destination',
            'startDate',
            'endDate',
            'timezone',
            'goals',
            'notes',
            'status',
          ],
          properties: {
            id: strOrNull,
            title: { type: 'string' },
            destination: strOrNull,
            startDate: { type: 'string' },
            endDate: { type: 'string' },
            timezone: { type: 'string' },
            goals: { type: 'array', items: { type: 'string' } },
            notes: strOrNull,
            status: {
              type: 'string',
              enum: ['planned', 'active', 'archived'],
            },
          },
        },
        travelOptions: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'externalId',
              'type',
              'status',
              'title',
              'provider',
              'description',
              'startAt',
              'endAt',
              'origin',
              'destination',
              'address',
              'phone',
              'priceObserved',
              'currency',
              'sourceUrl',
              'checkedAt',
              'verificationStatus',
              'sourceType',
              'notes',
            ],
            properties: {
              externalId: { type: 'string' },
              type: {
                type: 'string',
                enum: [
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
                ],
              },
              status: {
                type: 'string',
                enum: ['researched', 'shortlisted'],
              },
              title: { type: 'string' },
              provider: strOrNull,
              description: strOrNull,
              startAt: strOrNull,
              endAt: strOrNull,
              origin: strOrNull,
              destination: strOrNull,
              address: strOrNull,
              phone: strOrNull,
              priceObserved: numOrNull,
              currency: strOrNull,
              sourceUrl: strOrNull,
              checkedAt: strOrNull,
              verificationStatus: {
                type: ['string', 'null'],
                enum: ['verified', 'estimated', 'unverified', null],
              },
              sourceType: {
                type: 'string',
                enum: ['cursor', 'manual', 'imported', 'agent', 'other'],
              },
              notes: strOrNull,
            },
          },
        },
        itineraryItems: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'externalId',
              'title',
              'startAt',
              'endAt',
              'place',
              'importance',
              'notes',
            ],
            properties: {
              externalId: { type: 'string' },
              title: { type: 'string' },
              startAt: strOrNull,
              endAt: strOrNull,
              place: strOrNull,
              importance: {
                type: 'string',
                enum: ['crucial', 'recommended', 'optional'],
              },
              notes: strOrNull,
            },
          },
        },
        checklistItems: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['externalId', 'label', 'dueAt', 'sortOrder'],
            properties: {
              externalId: { type: 'string' },
              label: { type: 'string' },
              dueAt: strOrNull,
              sortOrder: { type: ['number', 'null'] },
            },
          },
        },
        notes: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['externalId', 'title', 'body'],
            properties: {
              externalId: { type: 'string' },
              title: strOrNull,
              body: { type: 'string' },
            },
          },
        },
      },
    },
    ops: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['op', 'entityKind', 'externalId', 'supersedesExternalId', 'note'],
        properties: {
          op: {
            type: 'string',
            enum: ['add', 'update', 'supersede', 'noop'],
          },
          entityKind: {
            type: 'string',
            enum: ['travelOption', 'itineraryItem', 'checklistItem', 'note'],
          },
          externalId: { type: 'string' },
          supersedesExternalId: strOrNull,
          note: strOrNull,
        },
      },
    },
  },
} as const

export function agentProposalStructuredResponseFormat(): NonNullable<
  ChatCompletionParams['response_format']
> {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'agent_proposal_draft',
      strict: true,
      schema: agentProposalJsonSchema as unknown as Record<string, unknown>,
    },
  }
}
