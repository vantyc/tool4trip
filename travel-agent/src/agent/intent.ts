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

/** "primero investiga…" only counts when no later build step is requested. */
const RESEARCH_FIRST_RE =
  /\b(?:primero|antes|solo|solamente|unicamente) (?:investiga|investigar|busca|buscar|compara|comparar|averigua|averiguar|verifica|verificar|revisa|revisar|analiza|analizar)\b/
const THEN_BUILD_RE =
  /\b(?:luego|despues|y entonces|y (?:luego )?(?:arma|crea|genera|prepara|agrega|actualiza))\b/

const NO_MUTATION_PATTERNS: RegExp[] = [
  /\bno (?:lo |la |los |las |me |nada )?(?:modifiques|cambies|actualices|toques|crees|apliques|guardes|agregues|anadas|elimines|borres|reserves|compres|edites|armes|generes)\b/,
  /\bno (?:hay que |debes )?(?:crear|aplicar|modificar|cambiar(?! de)|guardar|actualizar|tocar|reservar|comprar|armar)\b/,
  /\bno quiero que (?:\w+ )?(?:modifiques|cambies|actualices|toques|crees|apliques|guardes|reserves)\b/,
  /\bsin (?:modificar|cambiar|crear|aplicar|guardar|tocar|actualizar|reservar)\b/,
  /\bantes de (?:crear|aplicar|modificar|cambiar|guardar|armar|reservar)\b/,
  /\b(?:todavia|aun|por ahora|de momento) no (?:\w+ )?(?:crees|crear|apliques|aplicar|modifiques|modificar|cambies|cambiar|guardes|guardar|armes|armar)\b/,
  /\b(?:don'?t|do not) (?:modify|change|create|apply|save|update|book)\b/,
  /\b(?:research|investigate) (?:only|first)\b/,
  /\bwithout (?:modifying|changing|creating|applying|saving)\b/,
]

/**
 * "no crees un viaje nuevo / otro viaje" says WHERE to apply (the existing
 * trip), not that nothing may be applied. Only phrases naming a new/other
 * trip qualify; "no crees el viaje todavía" stays a no-mutation directive.
 */
const NEW_TRIP_SCOPE_RE = new RegExp(
  '\\b(?:no (?:crees|crear|generes|generar|armes|armar|hagas|hacer|abras|abrir)' +
    '|sin (?:crear|generar|armar|abrir)' +
    '|en (?:lugar|vez) de (?:crear|generar|armar|abrir)' +
    "|(?:don'?t|do not|without) (?:create|creating|make|making|open|opening)) " +
    '(?:(?:(?:un|una|uno|a) )?(?:(?:viaje|trip|itinerario|paquete) )?' +
    '(?:nuev[oa]|distint[oa]|aparte|adicional|separad[oa]|duplicad[oa]|new|separate|duplicate)' +
    '(?: (?:viaje|trip|itinerario|paquete))?' +
    '|(?:otr[oa]|another)(?: (?:viaje|trip|itinerario|paquete))?)\\b',
  'g',
)

/**
 * A component-edit prohibition limited by a condition ("no elimines X solo
 * porque…", "… a menos que …") constrains HOW to edit; the edit itself is
 * allowed, so it is not a no-mutation directive. Apply/create/save/book verbs
 * are excluded: "no apliques a menos que confirme" still means "not yet".
 */
const GUARDED_PROHIBITION_RE = new RegExp(
  '\\b(?:no (?:lo |la |los |las |me |nada )?' +
    '(?:elimines|borres|quites|reemplaces|sustituyas|cambies|modifiques|toques|descartes)' +
    "|(?:don'?t|do not) (?:delete|remove|drop|replace|change|modify|touch|discard))\\b" +
    '[^.;!?]{0,120}?' +
    '(?:\\b(?:solo|solamente|unicamente|simplemente|just|only|simply|merely) (?:porque|por que|because)' +
    '|\\ba menos que\\b|\\bsalvo (?:que|si)\\b|\\bexcepto (?:que|si)\\b|\\bunless\\b)' +
    '[^.;!?]*',
  'g',
)

/**
 * The user explicitly asked not to mutate / create yet (research first).
 * Generic phrasing only — no domain or place terms.
 */
export function detectNoMutationDirective(prompt: string): boolean {
  const p = norm(prompt)
    .replace(NEW_TRIP_SCOPE_RE, ' ')
    .replace(GUARDED_PROHIBITION_RE, ' ')
  if (NO_MUTATION_PATTERNS.some((re) => re.test(p))) return true
  return RESEARCH_FIRST_RE.test(p) && !THEN_BUILD_RE.test(p)
}

/**
 * Explicit order to apply changes to the trip. Wins over research keywords:
 * researching is then a step of the mutation, not the whole answer.
 */
const EXPLICIT_APPLY_PATTERNS: RegExp[] = [
  /\baplica(?:r|los|las)? (?:(?:estos|estas|los|las|este|esta|el|la|dichos|dichas|todos los|todas las) )?(?:cambios?|ajustes?|modificaciones?|actualizaciones?)\b/,
  /\b(?:actualiza|modifica|cambia|ajusta|edita)(?:r)? (?:el|mi|este|nuestro) viaje\b/,
  /\b(?:aplica|agrega|anade|actualiza)\b[^.;?]{0,60}\b(?:al|a mi|a este|en el|en mi) viaje (?:existente|actual|guardado)\b/,
  /\bapply (?:these |the |those )?(?:changes|updates)\b/,
]

/**
 * Heuristic intent routing (no extra LLM call).
 * Prefer research as default so tool loop remains available;
 * only force context_answer for clear trip-local questions.
 * Explicit mode=new_travel from the UI always wins.
 */
export function classifyAskIntent(
  prompt: string,
  mode?: 'ask' | 'new_travel' | 'component_action',
): AskIntent {
  if (mode === 'new_travel') return 'new_travel'
  if (mode === 'component_action') return 'mutation'

  const p = norm(prompt)

  if (
    EXPLICIT_APPLY_PATTERNS.some((re) => re.test(p)) &&
    !detectNoMutationDirective(prompt)
  ) {
    return 'mutation'
  }

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

  // "no crear/aplicar todavía" negates the mutation verbs below.
  if (detectNoMutationDirective(prompt)) return 'research'

  if (
    /\b(cambia|cambiar|actualiza|actualizar|agrega|agregar|anade|anadir|añade|añadir|modifica|modificar|reemplaza|reemplazar|quita|quitar|elimina|eliminar|aplica|aplicar|reorganiza|reorganizar)\b/.test(
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
