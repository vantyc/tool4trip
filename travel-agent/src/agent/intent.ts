import type { AgentAskRequest, TripContextSnapshot } from '../../shared/agentContracts.ts'

export type AskIntent =
  | 'context_answer'
  | 'research'
  | 'mutation'
  | 'new_travel'

function norm(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Heuristic intent routing (no extra LLM call).
 * Prefer research as default so tool loop remains available;
 * only force context_answer for clear trip-local questions.
 * Explicit mode=new_travel from the UI always wins.
 */
export function classifyAskIntent(
  prompt: string,
  mode?: 'ask' | 'new_travel',
): AskIntent {
  if (mode === 'new_travel') return 'new_travel'

  const p = norm(prompt)

  if (
    /verifica en internet|busca en (la )?web|search online|en internet|usa websearch|fetchurl/.test(
      p,
    ) ||
    /precios actuales|horarios de autobus|hoteles disponibles|confirma programa|vuelos nuevos|busca vuelos|busca hoteles|busca autobus/.test(
      p,
    ) ||
    /investiga opciones reales|fuentes oficiales/.test(p)
  ) {
    return 'research'
  }

  if (
    /\b(cambia|cambiar|actualiza|actualizar|agrega|agregar|anade|anadir|añade|añadir|modifica|modificar|reemplaza|reemplazar|quita|quitar|elimina|eliminar|aplica|aplicar)\b/.test(
      p,
    )
  ) {
    return 'mutation'
  }

  if (
    /^(busca|buscar|encuentra|encontrar|verifica|verificar|confirma|confirmar|investiga|investigar)\b/.test(
      p,
    )
  ) {
    return 'research'
  }

  // Clear trip-local questions only
  if (
    /(que|qué).*(dia|día|fecha).*(regreso|vuelta|llegada|inicio|salida)/.test(p) ||
    /(dia|día|fecha) (del? )?(regreso|vuelta|llegada|inicio|fin)/.test(p) ||
    /cuando (es|sera|será)? ?(el )?regreso/.test(p) ||
    /regreso a (cdmx|casa|ciudad de mexico|méxico)/.test(p) ||
    /fecha de (regreso|vuelta|fin|llegada|inicio)/.test(p) ||
    /opciones guardadas|que opciones tengo|qué opciones tengo|opciones de viaje/.test(
      p,
    ) ||
    /vuelo seleccionado|mi vuelo|donde me hospedo|dónde me hospedo|hospedaje guardado/.test(
      p,
    ) ||
    /que tengo planeado|qué tengo planeado|planeado el (domingo|lunes|martes)/.test(
      p,
    )
  ) {
    return 'context_answer'
  }

  return 'research'
}

export function formatTripDateEs(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim())
  if (!m) return ymd
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const dt = new Date(Date.UTC(y, mo - 1, d))
  const formatted = new Intl.DateTimeFormat('es-MX', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(dt)
  return formatted
}

function tripField(ctx: TripContextSnapshot, field: string): unknown {
  const trip = ctx.trip as Record<string, unknown>
  return trip?.[field]
}

export type ContextAnswerHit = {
  narrative: string
  claims: Array<{
    kind: 'other_factual' | 'schedule'
    statement: string
    sourceType: 'context'
    entityType: 'trip' | 'travelOption' | 'booking' | 'itineraryItem'
    entityId: string
    field: string
    verificationStatus: 'verified'
    confidence: 'high'
    sourceUrl: null
    evidenceIndex: null
  }>
}

/**
 * Deterministic answers for common context-only prompts.
 * Returns null when the prompt needs LLM and/or research.
 */
export function tryContextAnswer(req: AgentAskRequest): ContextAnswerHit | null {
  const p = norm(req.prompt)
  const trip = req.context.trip as Record<string, unknown>
  const tripId = String(trip.id ?? req.tripId)

  // Return / end date
  if (
    /(que|qué).*(dia|día|fecha).*(regreso|vuelta)/.test(p) ||
    /(dia|día|fecha) (del? )?(regreso|vuelta)/.test(p) ||
    /cuando (es|sera|será)? ?(el )?regreso/.test(p) ||
    /regreso a (cdmx|casa|ciudad de mexico|méxico)/.test(p) ||
    /fecha de (regreso|vuelta|fin)/.test(p)
  ) {
    const endDate = tripField(req.context, 'endDate')
    if (typeof endDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      const pretty = formatTripDateEs(endDate)
      return {
        narrative: `El regreso es el ${pretty} (fecha de fin del viaje en tu itinerario local).`,
        claims: [
          {
            kind: 'schedule',
            statement: `Fecha de regreso / fin del viaje: ${endDate} (${pretty})`,
            sourceType: 'context',
            entityType: 'trip',
            entityId: tripId,
            field: 'endDate',
            verificationStatus: 'verified',
            confidence: 'high',
            sourceUrl: null,
            evidenceIndex: null,
          },
        ],
      }
    }
  }

  // Arrival / start date
  if (
    /(que|qué).*(dia|día|fecha).*(llegada|inicio|salida)/.test(p) ||
    /fecha de (llegada|inicio|salida)/.test(p) ||
    /cuando (llego|llega|empiez)/.test(p)
  ) {
    const startDate = tripField(req.context, 'startDate')
    if (typeof startDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
      const pretty = formatTripDateEs(startDate)
      return {
        narrative: `La fecha de inicio / llegada planificada es el ${pretty}.`,
        claims: [
          {
            kind: 'schedule',
            statement: `Fecha de inicio del viaje: ${startDate} (${pretty})`,
            sourceType: 'context',
            entityType: 'trip',
            entityId: tripId,
            field: 'startDate',
            verificationStatus: 'verified',
            confidence: 'high',
            sourceUrl: null,
            evidenceIndex: null,
          },
        ],
      }
    }
  }

  // Saved travel options listing
  if (
    /opciones guardadas|que opciones tengo|qué opciones tengo|opciones de viaje/.test(
      p,
    )
  ) {
    const opts = req.context.travelOptions ?? []
    const titles = opts
      .map((o) => {
        const r = o as Record<string, unknown>
        return typeof r.title === 'string' ? r.title : null
      })
      .filter((t): t is string => Boolean(t))
    const statement =
      titles.length > 0
        ? `Opciones guardadas: ${titles.join('; ')}`
        : 'No hay travelOptions guardadas en el contexto local.'
    return {
      narrative: statement,
      claims: [
        {
          kind: 'other_factual',
          statement,
          sourceType: 'context',
          entityType: 'trip',
          entityId: tripId,
          field: 'travelOptions',
          verificationStatus: 'verified',
          confidence: 'high',
          sourceUrl: null,
          evidenceIndex: null,
        },
      ],
    }
  }

  // Selected / lodging / flight from saved options (best-effort title match)
  if (/vuelo seleccionado|mi vuelo|donde me hospedo|dónde me hospedo|hospedaje guardado/.test(p)) {
    const opts = req.context.travelOptions ?? []
    const wantFlight = /vuelo/.test(p)
    const wantLodge = /hosped|hotel/.test(p)
    const match = opts.find((o) => {
      const r = o as Record<string, unknown>
      const type = String(r.type ?? '')
      if (wantFlight) return type === 'flight'
      if (wantLodge) return type === 'lodging'
      return false
    }) as Record<string, unknown> | undefined
    if (match?.title) {
      const externalId = String(match.externalId ?? match.id ?? 'option')
      const statement = `${wantFlight ? 'Vuelo' : 'Hospedaje'}: ${match.title}`
      return {
        narrative: statement,
        claims: [
          {
            kind: 'other_factual',
            statement,
            sourceType: 'context',
            entityType: 'travelOption',
            entityId: externalId,
            field: 'title',
            verificationStatus: 'verified',
            confidence: 'high',
            sourceUrl: null,
            evidenceIndex: null,
          },
        ],
      }
    }
    // Known question shape but missing data → let research path decide (null)
    return null
  }

  return null
}

/**
 * Minimal package shell for a context-only read answer.
 * Historical Dexie fields (notes, options, bookings) stay INPUT CONTEXT —
 * they must not be copied into the draft that grounding validates.
 */
export function buildContextOnlyDraft(
  req: AgentAskRequest,
  hit: ContextAnswerHit,
): Record<string, unknown> {
  const trip = req.context.trip as Record<string, unknown>
  return {
    narrative: hit.narrative,
    warnings: [],
    claims: hit.claims,
    diffSummary: [],
    package: {
      schemaVersion: 1,
      packageId: `ctx-${req.tripId}`,
      revision: 1,
      generatedAt: null,
      trip: {
        id: trip.id ?? req.tripId,
        title: trip.title ?? 'Viaje',
        destination: trip.destination ?? null,
        startDate: trip.startDate,
        endDate: trip.endDate,
        timezone: trip.timezone ?? 'America/Mexico_City',
        goals: Array.isArray(trip.goals) ? trip.goals : [],
        // Empty string (not null): hydrate stripNulls drops null keys and would
        // otherwise fall back to Dexie trip.notes. Explicit empty = omit notes.
        notes: '',
        status: trip.status ?? 'planned',
      },
      travelOptions: [],
      itineraryItems: [],
      checklistItems: [],
      notes: [],
    },
    ops: [],
  }
}
