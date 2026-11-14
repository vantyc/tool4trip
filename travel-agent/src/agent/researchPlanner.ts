/**
 * Dependency-aware research planning for multi-objective requests
 * ("next verifiable event among these towns, compare safety/lodging…").
 *
 * Generic lexicons only — no place names. Candidate verdicts computed here are
 * PLANNING signals (what to research next); they never become claims.
 */
import type {
  AgentAskRequest,
  ToolTraceEntry,
} from '../../shared/agentContracts.ts'
import type { AgentClaimDraft } from './claims.ts'
import { extractAssertedEventDates } from './eventDateGrounding.ts'
import {
  assessResearchGoals,
  deriveResearchGoals,
  extractTripDatesFromPrompt,
  markUnsupportedGoals,
  originQueryByUrl,
  type GoalStatus,
  type ResearchGoal,
} from './researchCoverage.ts'

// ---------------------------------------------------------------------------
// Lexicons (folded: lowercase, no accents)
// ---------------------------------------------------------------------------

const EVENT_NOUN =
  '(?:serenatas?|ferias?|fiestas?|festival(?:es)?|conciertos?|grito|procesion(?:es)?|carnaval(?:es)?|romerias?|peregrinacion(?:es)?)'
export const EVENT_TERM_RE = new RegExp(`\\b${EVENT_NOUN}\\b`)
const EVENT_ANY_RE = new RegExp(`\\b(?:${EVENT_NOUN}|eventos?)\\b`)
/**
 * Specific event types a user can target. Generic ones (feria, fiesta,
 * festival, evento) are context: they never satisfy a specific target.
 */
const TARGET_EVENT_RE =
  /\b(serenata|concierto|procesion|carnaval|romeria|peregrinacion)(?:s|es)?\b/

/** The specific event type the ask targets (first one named), if any. */
export function extractEventTarget(prompt: string): string | undefined {
  return fold(prompt).match(TARGET_EVENT_RE)?.[1]
}

function matchesEventTarget(text: string, target: string | undefined): boolean {
  return !target || new RegExp(`\\b${target}(?:s|es)?\\b`).test(fold(text))
}
/** Timing is open only when it qualifies the event itself. */
const OPEN_TIMING_RE = new RegExp(
  [
    `\\b(?:proxim[oa]s?|futur[oa]s?|siguientes?)\\s+(?:\\w+\\s+)?(?:${EVENT_NOUN}|eventos?|ediciones?)\\b`,
    `\\b(?:${EVENT_NOUN}|eventos?)\\s+(?:\\w+\\s+)?(?:futur[oa]s?|proxim[oa]s?|verificables?|posteriores?)\\b`,
    '\\bverificables?\\b',
    '\\bposterior(?:es)? a\\b',
    '\\bcuando (?:es|sera|hay|son|seran)\\b',
    '\\b(?:que|en que) fechas?\\b',
    '\\b(?:upcoming|next) (?:event|festival|fair)',
  ].join('|'),
)
/** The ask leaves the event's date open: the trip dates depend on finding it. */
const EVENT_DATE_OPEN_RE = new RegExp(
  [
    `\\b(?:proxim[oa]s?|futur[oa]s?|siguientes?)\\s+(?:\\w+\\s+)?(?:${EVENT_NOUN}|eventos?|ediciones?)\\b`,
    `\\b(?:${EVENT_NOUN}|eventos?)\\s+(?:\\w+\\s+)?(?:futur[oa]s?|proxim[oa]s?)\\b`,
    '\\bcuando (?:es|sera|hay|son|seran)\\b',
    '\\b(?:que|en que) fechas?\\b',
    '\\b(?:upcoming|next) (?:event|festival|fair)',
  ].join('|'),
)
const COMPARE_RE =
  /\bcompar\w*|\bcual(?:es)? (?:conviene|es mejor|son mejores)|\belegir entre|\bcandidat\w*|\bdonde (?:ir|conviene)\b/
const COMPARE_CONTEXT_RE = /\bcompar\w*|\bversus\b|\bvs\b|\bentre\b|\bcandidat\w*/
const MULTI_PLACE_RE =
  /\b(?:municipios|pueblos|localidades|poblaciones|destinos|ciudades|regiones)\b/
export const SAFETY_RE =
  /\b(?:seguridad|insegur\w*|incidencia delictiva|delit\w*|crimen|criminalidad|violencia|homicidios?|asaltos?|robos?|peligros\w*|alerta de viaje|travel advisory|seguros? para viajar)\b/
const LODGING_RE =
  /\b(?:hotel(?:es|s)?|hospedaje|alojamientos?|posadas?|hostal(?:es)?|hostels?|resorts?|villas|suites|airbnb|lodging|accommodations?|donde dormir|pernoctar)\b/
const GROUND_RE =
  /\b(?:autobus(?:es)?|camion(?:es)?|bus|corridas?|central(?:es)? (?:de autobuses|camioneras?)|terminal(?:es)? (?:de autobuses|terrestres?)|carreteras?|traslados?|transportes?|transporte (?:terrestre|publico)|como llegar|acceso|renta de autos?|taxis?|colectivos?|combis?|shuttles?)\b/
/** Explicit verification instruction ("verifícalas", "confirma", "comprueba"). */
const VERIFY_RE = /\b(?:verific\w*|confirm\w*|comprueb\w*|comprob\w*)\b/
/** The trip is about attending the event ("asistir a la serenata", "ir a la procesión"). */
const ATTEND_RE = /\b(?:asist\w*|acud\w*|presenci\w*|escuch\w*|disfrut\w*|ir a)\b/
/**
 * Mexican states (folded) used only to detect a conflicting geographic entity
 * in evidence. Names that are also common surnames/streets (Hidalgo, Morelos,
 * Guerrero) and the capital (usual trip origin) are left out on purpose.
 */
const MX_STATES = [
  'aguascalientes', 'baja california', 'campeche', 'chiapas', 'chihuahua',
  'coahuila', 'colima', 'durango', 'estado de mexico', 'guanajuato', 'jalisco',
  'michoacan', 'nayarit', 'nuevo leon', 'oaxaca', 'puebla', 'queretaro',
  'quintana roo', 'san luis potosi', 'sinaloa', 'sonora', 'tabasco',
  'tamaulipas', 'tlaxcala', 'veracruz', 'yucatan', 'zacatecas',
]
/** Never a candidate destination by itself: the country, states, the capital. */
const NON_CANDIDATE_PLACES = new Set([
  ...MX_STATES,
  'hidalgo', 'morelos', 'guerrero', 'mexico', 'ciudad de mexico', 'cdmx',
])
/** A leading word that makes a longer, different entity ("Estado de México", "Ciudad de …"). */
const GEO_HEAD_WORDS = new Set(['estado', 'ciudad', 'region'])
/** Regions / cardinal areas: research scopes, not destinations. */
const REGION_WORDS = new Set([
  'altos', 'region', 'zona', 'norte', 'sur', 'centro', 'costa', 'bajio',
  'occidente', 'oriente',
])
const FLIGHT_RE =
  /\b(?:vuelos?|flights?|aerolineas?|airlines?|aeropuerto|aicm|searchflightschedules|aerodatabox)\b|\b[a-z]{3}\s*[-–]\s*[a-z]{3}\b/
const DATE_RE =
  /\b\d{1,2}(?:\s+de)?\s+(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|ene|feb|mar|abr|may|jun|jul|ago|sept?|oct|nov|dic)\b|\b20\d{2}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/

const SAFETY_NEG_RE =
  /\b(?:alerta|no viajar|evitar viajar|enfrentamientos?|toque de queda|bloqueos?|alto indice|alta incidencia|zona roja|balaceras?|violencia (?:reciente|armada))\b/
const SAFETY_POS_RE =
  /\b(?:baja incidencia|tranquil[oa]|segur[oa] para viajar|sin alertas?|de los mas seguros)\b/
const LODGING_NEG_RE =
  /\b(?:sin hoteles|no hay (?:hoteles|hospedaje)|sin (?:hospedaje|disponibilidad)|agotad[oa]s?|no cuenta con hoteles)\b/
const EVENT_NEG_RE =
  /\b(?:cancelad[oa]s?|suspendid[oa]s?|no habra|pospuest[oa]s?)\b/

const MONTH_WORDS = new Set([
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
  'septiembre', 'setiembre', 'octubre', 'noviembre', 'diciembre',
])
const WEEKDAY_WORDS = new Set([
  'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo',
])
const PLATFORM_WORDS = new Set([
  'facebook', 'google', 'airbnb', 'booking', 'expedia', 'tripadvisor',
  'instagram', 'youtube', 'tiktok', 'uber', 'didi', 'tavily', 'whatsapp',
])
/** Sentence starters / generic nouns that may be capitalized but are not places. */
const STARTER_WORDS = new Set([
  'busca', 'buscar', 'compara', 'comparar', 'investiga', 'investigar', 'quiero',
  'queremos', 'necesito', 'dame', 'dime', 'entre', 'en', 'para', 'de', 'del',
  'la', 'el', 'los', 'las', 'un', 'una', 'cual', 'cuales', 'que', 'donde',
  'hay', 'me', 'mi', 'mis', 'por', 'sin', 'con', 'primero', 'luego', 'no', 'si',
  'hola', 'ayudame', 'ayuda', 'verifica', 'verificar', 'revisa', 'revisar',
  'encuentra', 'encontrar', 'planea', 'planear', 'arma', 'armar', 'crea',
  'crear', 'analiza', 'analizar', 'averigua', 'averiguar', 'considera',
  'evalua', 'evaluar', 'opciones', 'municipios', 'municipio', 'pueblos',
  'pueblo', 'destinos', 'destino', 'ciudades', 'ciudad', 'lugares', 'proximos',
  'proximo', 'proxima', 'proximas', 'siguiente', 'despues', 'antes', 'tambien',
  'ademas', 'incluye', 'solo', 'solamente', 'todavia', 'aun', 'viaje', 'vuelo',
  'vuelos', 'hotel', 'hoteles', 'hospedaje', 'seguridad', 'fechas', 'fecha',
  'evento', 'eventos', 'serenata', 'serenatas', 'feria', 'ferias', 'fiesta',
  'fiestas', 'festival', 'concierto', 'grito', 'procesion', 'carnaval',
  'patronal', 'patronales', 'salida', 'regreso', 'ida', 'vuelta', 'nota',
  'importante', 'objetivo', 'estado', 'region', 'cuando', 'como', 'revisa',
])

const PLACE_PHRASE_SRC =
  "\\p{Lu}[\\p{L}'’\\-]*(?:\\s+(?:(?:de|del|la|las|los|el)\\s+){0,2}\\p{Lu}[\\p{L}'’\\-]*)*"

export function fold(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const ARTICLE_WORDS = new Set(['el', 'la', 'los', 'las'])

/** A capitalized article that starts the name itself ("El Nido", "La Barca", "Los Cabos"). */
function isArticleLedName(words: string[]): boolean {
  const [article, next] = words
  if (!article || !next || !ARTICLE_WORDS.has(fold(article))) return false
  return /^\p{Lu}/u.test(article) && /^\p{Lu}/u.test(next) && !STARTER_WORDS.has(fold(next))
}

function cleanPlacePhrase(raw: string): string | null {
  const words = raw.trim().split(/\s+/)
  while (words.length && STARTER_WORDS.has(fold(words[0]!)) && !isArticleLedName(words)) {
    words.shift()
  }
  while (
    words.length &&
    ['de', 'del', 'la', 'las', 'los', 'el'].includes(fold(words[0]!)) &&
    !isArticleLedName(words)
  ) {
    words.shift()
  }
  if (!words.length) return null
  const phrase = words.join(' ')
  const f = fold(phrase)
  if (words.length === 1) {
    if (MONTH_WORDS.has(f) || WEEKDAY_WORDS.has(f) || PLATFORM_WORDS.has(f)) {
      return null
    }
  }
  if (words.some((w) => PLATFORM_WORDS.has(fold(w)))) return null
  // IATA / acronyms (MEX, GDL, CDMX, AICM)
  if (!/\p{Ll}/u.test(phrase) && phrase.replace(/\W/g, '').length <= 5) {
    return null
  }
  return phrase
}

type PhraseHit = { phrase: string; start: number; end: number; raw: string }

function placePhraseHits(text: string): PhraseHit[] {
  const re = new RegExp(PLACE_PHRASE_SRC, 'gu')
  const hits: PhraseHit[] = []
  for (const m of text.matchAll(re)) {
    const phrase = cleanPlacePhrase(m[0])
    if (!phrase) continue
    hits.push({
      phrase,
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
      raw: m[0],
    })
  }
  return hits
}

const LIST_GAP_RE = /^\s*(?:[,;/]\s*)?(?:(?:y|o|e|u)\s+)?$/i

/** Lead-in (folded) naming the next places only to exclude them ("no confundir con X", "no es X", "ni X"). */
const EXCLUSION_LEAD_RE =
  /\b(?:no\s+confundir(?:lo|la|se)?\s+con|no\s+confundas\s+con|no\s+es|no\s+son|no\s+me\s+refiero\s+a|distint[oa]s?\s+(?:de|a)|diferentes?\s+(?:de|a)|excepto|salvo|ni|no)(?:\s+(?:con|a|al|el|la|los|las))*\s*[(«"“]?\s*$/

/** A state, the country or a region: a research scope, never a destination candidate. */
function isScopeNotPlace(phrase: string): boolean {
  const n = fold(phrase)
  const head = n.split(' ').find((w) => !CONNECTOR_WORDS.has(w)) ?? ''
  return NON_CANDIDATE_PLACES.has(n) || GEO_HEAD_WORDS.has(head) || REGION_WORDS.has(head)
}

/**
 * Candidate places listed in the prompt ("A, B y C"). A list of ≥3 names, or
 * ≥2 when introduced by a plural place noun or a comparison verb. States,
 * the country and regions are dropped, and so is a list introduced only to
 * exclude it ("no confundir con A ni B").
 */
export function extractPromptCandidates(prompt: string): string[] {
  const list = listItemCandidates(prompt)
  const hits = placePhraseHits(prompt).filter(
    (h) => !list.spans.some(([s, e]) => h.start >= s && h.start < e),
  )
  const groups: PhraseHit[][] = []
  for (const h of hits) {
    const last = groups[groups.length - 1]
    const prev = last?.[last.length - 1]
    if (prev) {
      const gap = prompt.slice(prev.end, h.start)
      if (gap.length > 0 && LIST_GAP_RE.test(gap) && /[,;/]|\b[yoeu]\b/i.test(gap)) {
        last!.push(h)
        continue
      }
    }
    groups.push([h])
  }
  const out: string[] = []
  for (const g of groups) {
    if (g.length < 2) continue
    const first = g[0]!
    const context = fold(
      `${prompt.slice(Math.max(0, first.start - 80), first.start)} ${first.raw}`,
    )
    const introduced =
      MULTI_PLACE_RE.test(context) || COMPARE_CONTEXT_RE.test(context)
    const prev = hits[hits.indexOf(first) - 1]
    const leadIn = fold(prompt.slice(prev?.end ?? 0, first.start))
    if ((g.length >= 3 || introduced) && !EXCLUSION_LEAD_RE.test(leadIn)) {
      for (const h of g) {
        if (isScopeNotPlace(h.phrase)) continue
        if (!out.some((o) => fold(o) === fold(h.phrase))) out.push(h.phrase)
      }
    }
  }
  for (const name of list.names) {
    if (!out.some((o) => fold(o) === fold(name))) out.push(name)
  }
  return out.slice(0, 8)
}

const LIST_ITEM_RE = /^\s*(?:\d{1,2}[.)]|[-*•])\s+(.+)$/
const LIST_EXCLUSION_RE = /\b(?:evit\w*|no (?:incluir|quiero|ir)|excepto|salvo|descart\w*)\b/

/**
 * Places that open the items of a bulleted/numbered list introduced (heading
 * or lead line) as destinations or a comparison: "### Destinos / Compara
 * estos tres: 1. **Boracay:** … 2. **El Nido, Palawan:** …". Only an item
 * headed by a place counts, and only that place (", Palawan" is its scope);
 * "3. Prioriza municipios …" is an instruction, not a candidate.
 */
function listItemCandidates(prompt: string): { names: string[]; spans: Array<[number, number]> } {
  const lines = prompt.split('\n')
  const lineStart: number[] = []
  for (let k = 0, pos = 0; k < lines.length; k++) {
    lineStart.push(pos)
    pos += lines[k]!.length + 1
  }
  const out: string[] = []
  const spans: Array<[number, number]> = []
  let i = 0
  while (i < lines.length) {
    if (!LIST_ITEM_RE.test(lines[i]!)) {
      i++
      continue
    }
    const intro = fold(
      lines
        .slice(Math.max(0, i - 4), i)
        .filter((l) => l.trim())
        .slice(-2)
        .join(' '),
    )
    const items: string[] = []
    let j = i
    while (j < lines.length && (LIST_ITEM_RE.test(lines[j]!) || !lines[j]!.trim())) {
      const m = lines[j]!.match(LIST_ITEM_RE)
      if (m) items.push(m[1]!.replace(/[*_`]/g, '').trim())
      j++
    }
    const span: [number, number] = [lineStart[i]!, lineStart[j - 1]! + lines[j - 1]!.length]
    i = j
    if (items.length < 2) continue
    if (!(MULTI_PLACE_RE.test(intro) || COMPARE_CONTEXT_RE.test(intro))) continue
    if (LIST_EXCLUSION_RE.test(intro)) continue
    const before = out.length
    for (const item of items) {
      const first = placePhraseHits(item)[0]
      if (!first || item.slice(0, first.start).trim()) continue
      if (!/^\s*(?:[:,(—–-]|$)/.test(item.slice(first.end))) continue
      if (isScopeNotPlace(first.phrase)) continue
      if (!out.some((o) => fold(o) === fold(first.phrase))) out.push(first.phrase)
    }
    if (out.length > before) spans.push(span)
  }
  return { names: out, spans }
}

/**
 * Sentences where the traveler asks to attend or verify the target event
 * ("Quiero asistir a la serenata en X el 7 de octubre").
 */
function targetEventSentences(prompt: string, target: string): string[] {
  return sentences(prompt).filter((s) => {
    const f = fold(s)
    return matchesEventTarget(f, target) && (ATTEND_RE.test(f) || VERIFY_RE.test(f))
  })
}

/**
 * Fixed destination of a target-event ask: the place introduced by "en"/"de"
 * closest to the event mention in the sentence that asks for it.
 */
function targetEventDestination(prompt: string, target: string): string | undefined {
  for (const s of targetEventSentences(prompt, target)) {
    const at = fold(s).search(new RegExp(`\\b${target}`))
    const hits = placePhraseHits(s).filter((h, i, all) => {
      if (isScopeNotPlace(h.phrase)) return false
      const lead = fold(s.slice(all[i - 1]?.end ?? 0, h.start))
      return /\b(?:en|de)\s*$/.test(lead) && !EXCLUSION_LEAD_RE.test(lead)
    })
    const best = hits.sort((a, b) => Math.abs(a.start - at) - Math.abs(b.start - at))[0]
    if (best) return best.phrase
  }
  return undefined
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Whole-word, accent-insensitive occurrence of `name` in `text`. */
export function namesPlace(text: string, name: string): boolean {
  const n = fold(name)
  if (!n) return false
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRe(n)}(?![\\p{L}\\p{N}])`, 'u').test(
    fold(text),
  )
}

/** States named in `text` (folded, whole word). */
export function statesIn(text: string): string[] {
  return MX_STATES.filter((s) => namesPlace(text, s))
}

export type PlaceIdentity = 'identified' | 'ambiguous' | 'absent'

/**
 * Whether `sentence` unambiguously refers to candidate `name`.
 * - full name as a whole word (never a shared prefix: "San Miguel" ≠ "San Miguel el Alto");
 * - every occurrence of the leading words is followed by the full name
 *   (a sibling like "San Miguel Cuyutlán" / "San Miguel de Allende" → ambiguous);
 * - a longer candidate containing this name wins its own mentions;
 * - no state outside the requested region in the sentence or the source title.
 */
export function placeIdentity(input: {
  sentence: string
  name: string
  otherNames?: string[]
  regionStates?: string[]
  sourceTitle?: string
}): PlaceIdentity {
  const { sentence, name } = input
  if (!namesPlace(sentence, name)) return 'absent'
  const n = fold(name)
  const f = fold(sentence)
  const longer = (input.otherNames ?? []).filter(
    (o) => fold(o) !== n && fold(o).includes(n) && namesPlace(sentence, o),
  )
  if (longer.length) {
    const stripped = longer.reduce(
      (acc, o) => acc.split(fold(o)).join(' '),
      f,
    )
    if (!namesPlace(stripped, name)) return 'absent'
  }
  const words = n.split(' ')
  if (words.length > 2) {
    const prefix = words.slice(0, 2).join(' ')
    const rest = n.slice(prefix.length)
    const re = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRe(prefix)}(?![\\p{L}\\p{N}])`, 'gu')
    for (const m of f.matchAll(re)) {
      const after = f.slice((m.index ?? 0) + m[0].length)
      if (!after.startsWith(rest)) return 'ambiguous'
    }
  }
  const region = input.regionStates ?? []
  if (region.length) {
    const named = [...statesIn(sentence), ...statesIn(input.sourceTitle ?? '')]
    if (named.some((s) => !region.includes(s))) return 'ambiguous'
  }
  return 'identified'
}

function sentences(text: string): string[] {
  return text
    .split(/[.;!?\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

const CONNECTOR_WORDS = new Set(['de', 'del', 'la', 'las', 'los', 'el'])

/**
 * Capitalized place phrases as written: leading verbs/event nouns are dropped,
 * but a geographic head is kept ("Estado de México" stays whole, never "México").
 */
function rawPlacePhrases(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(new RegExp(PLACE_PHRASE_SRC, 'gu'))) {
    const words = m[0].trim().split(/\s+/)
    while (words.length) {
      const w = fold(words[0]!)
      if (isArticleLedName(words)) break
      if (CONNECTOR_WORDS.has(w) || (STARTER_WORDS.has(w) && !GEO_HEAD_WORDS.has(w))) {
        words.shift()
      } else {
        break
      }
    }
    if (words.length) out.push(words.join(' '))
  }
  return out
}

export type ProposedCandidateVerdict =
  | 'accepted'
  | 'duplicate'
  | 'not_a_place_name'
  | 'region_not_destination'
  | 'overlaps_candidate'
  | 'not_identified_in_evidence'

/**
 * A candidate the model proposed explicitly (webSearch `candidates`). Accepted
 * only as a complete geographic entity: a place name (not a state, region or
 * the country), not a fragment of / overlapping an existing candidate, and
 * written whole in some evidence sentence that identifies it inside the
 * requested region.
 */
export function proposedCandidateVerdict(input: {
  name: string
  evidence: Array<{ title?: string; snippet?: string }>
  existing: string[]
  regionStates: string[]
}): ProposedCandidateVerdict {
  const name = input.name.trim()
  const n = fold(name)
  if (input.existing.some((e) => fold(e) === n)) return 'duplicate'
  const head = n.split(' ').find((w) => !CONNECTOR_WORDS.has(w)) ?? ''
  if (NON_CANDIDATE_PLACES.has(n) || GEO_HEAD_WORDS.has(head) || REGION_WORDS.has(head)) {
    return 'region_not_destination'
  }
  const clean = cleanPlacePhrase(name)
  if (!clean || fold(clean) !== n || n.split(' ').length > 5) return 'not_a_place_name'
  if (input.existing.some((e) => mentions(e, name) || mentions(name, e))) {
    return 'overlaps_candidate'
  }
  for (const src of input.evidence) {
    const title = src.title ?? ''
    for (const s of sentences(`${title}. ${src.snippet ?? ''}`)) {
      if (!rawPlacePhrases(s).some((p) => fold(p) === n)) continue
      const identity = placeIdentity({
        sentence: s,
        name,
        otherNames: input.existing,
        regionStates: input.regionStates,
        sourceTitle: title,
      })
      if (identity === 'identified') return 'accepted'
    }
  }
  return 'not_identified_in_evidence'
}

/**
 * Sibling of a multi-word candidate: its leading words followed by something
 * else ("San Miguel de Allende" for "San Miguel el Alto").
 */
function namesSibling(text: string, name: string): boolean {
  const n = fold(name)
  const words = n.split(' ')
  if (words.length < 3) return false
  const prefix = words.slice(0, 2).join(' ')
  const rest = n.slice(prefix.length)
  const f = fold(text)
  const re = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRe(prefix)}(?![\\p{L}\\p{N}])`, 'gu')
  for (const m of f.matchAll(re)) {
    if (!f.slice((m.index ?? 0) + m[0].length).startsWith(rest)) return true
  }
  return false
}

/** URL path as words ("/feria-de-san-miguel-de-allende" → "feria de san miguel de allende"). */
function urlSlugText(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname).replace(/[-_/+.]+/g, ' ')
  } catch {
    return ''
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// Event timing (future-event semantics)
// ---------------------------------------------------------------------------

/** Dates the prompt pins for the event search (from = today/start, to = latest). */
export type EventWindow = { from: string; to?: string }

export type EventTiming = 'in_window' | 'past' | 'outside' | 'undated'

/** A "del X al Y" range that started before the window can still be running. */
const ONGOING_RANGE_DAYS = 45

function dayDiff(a: string, b: string): number {
  return (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000
}

const YEAR_RE = /\b(?:19|20)\d{2}\b/g

/**
 * Year for dates written without one. When the text names years and none is a
 * window year ("el 7 de octubre … en 2019"), its dates belong to that year,
 * never to the window's.
 */
function yearHintFor(text: string, window: EventWindow): string {
  const from = window.from.slice(0, 4)
  const to = window.to?.slice(0, 4) ?? '9999'
  const years = [...new Set(text.match(YEAR_RE) ?? [])].sort()
  if (!years.length || years.some((y) => y >= from && y <= to)) return from
  return years[years.length - 1]!
}

export function eventTiming(text: string, window: EventWindow): EventTiming {
  const dates = extractAssertedEventDates(text, yearHintFor(text, window)).sort()
  if (!dates.length) return 'undated'
  const to = window.to ?? '9999-12-31'
  if (dates.some((d) => d >= window.from && d <= to)) return 'in_window'
  const before = dates.filter((d) => d < window.from)
  const after = dates.filter((d) => d > to)
  if (before.some((a) => after.some((b) => dayDiff(a, b) <= ONGOING_RANGE_DAYS))) {
    return 'in_window'
  }
  return after.length ? 'outside' : 'past'
}

/** Four-digit years, also glued to words as in URL paths ("fiestas_octubre2019"). */
const EDITION_YEAR_RE = /(?<!\d)(?:19|20)\d{2}(?!\d)/g

/**
 * Year of another edition the source belongs to: its title, text or URL path
 * name years near the window and none is a window year. Distant years are
 * history ("desde 1890"), not an edition.
 */
export function otherEditionYear(
  source: { url?: string; title?: string; snippet?: string },
  window: EventWindow,
): number | null {
  const from = Number(window.from.slice(0, 4))
  const to = Number((window.to ?? window.from).slice(0, 4))
  let path = ''
  try {
    path = decodeURIComponent(new URL(source.url ?? '').pathname)
  } catch {
    path = ''
  }
  const years = [...`${source.title ?? ''} ${source.snippet ?? ''} ${path}`.matchAll(EDITION_YEAR_RE)]
    .map((m) => Number(m[0]))
    .filter((y) => y >= from - 15 && y <= to + 5)
  if (!years.length || years.some((y) => y >= from && y <= to)) return null
  return Math.max(...years)
}

function eventWindowFor(prompt: string): EventWindow | undefined {
  const dates = extractTripDatesFromPrompt(prompt).sort()
  if (!dates.length) return undefined
  const last = dates[dates.length - 1]!
  return last !== dates[0] ? { from: dates[0]!, to: last } : { from: dates[0]! }
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export type ResearchDimension =
  | 'event'
  | 'safety'
  | 'lodging'
  | 'ground'
  | 'flight'
  | 'other'

export type ResearchPlan = {
  goals: ResearchGoal[]
  multiObjective: boolean
  promptCandidates: string[]
  /** Prompt candidates with their own verification instruction ("Si X…, verifícalas"). */
  priorityCandidates: string[]
  /** States named in the prompt; evidence naming another state is ambiguous. */
  regionStates: string[]
  destinationSelection: boolean
  eventDiscovery: boolean
  /** Temporal restriction of event discovery: only events inside it support a candidate. */
  eventWindow?: EventWindow
  /** Specific event type asked for (e.g. "serenata"): only it resolves event discovery. */
  eventTarget?: string
  /** Dimensions the plan tracks (a goal exists for each). */
  dimensions: ResearchDimension[]
  /** Hotels the prompt asks to research by name or by count (sizes the lodging budget). */
  lodgingTargets?: number
}

const COUNT_WORDS: Record<string, number> = { dos: 2, tres: 3, '2': 2, '3': 3 }

/**
 * Hotels requested in list items ("- Boracay: Ferra Hotel & Garden Suites",
 * "- Panglao: busca dos hoteles con alberca"): one per item, or the count it states.
 */
export function lodgingTargetCount(prompt: string): number {
  let n = 0
  for (const line of prompt.split('\n')) {
    const m = line.match(LIST_ITEM_RE)
    if (!m) continue
    const item = fold(m[1]!.replace(/[*_`]/g, ''))
    if (!LODGING_RE.test(item)) continue
    const counted = item.match(/\b(dos|tres|2|3) (?:hoteles|opciones|alojamientos|resorts)\b/)
    n += counted ? COUNT_WORDS[counted[1]!]! : 1
  }
  return n
}

/** A candidate singled out in a sentence that asks to verify it. */
export function extractPriorityCandidates(
  prompt: string,
  candidates: string[],
): string[] {
  const out: string[] = []
  for (const s of sentences(prompt)) {
    if (!VERIFY_RE.test(fold(s))) continue
    const named = candidates.filter((c) => namesPlace(s, c))
    if (named.length === 1 && !out.includes(named[0]!)) out.push(named[0]!)
  }
  return out
}

const GOAL_EVENT = 'goal-event-discovery'
const GOAL_DEST = 'goal-destination-selection'
const GOAL_SAFETY = 'goal-public-safety'
const GOAL_LODGING = 'goal-lodging-dest'
const GOAL_GROUND = 'goal-ground'

/**
 * Goals for a prompt. Simple asks keep the legacy (flight-first) goals and
 * multiObjective=false; event discovery / destination selection prompts get a
 * dependency-ordered plan where flights are secondary.
 */
export function deriveResearchPlan(prompt: string): ResearchPlan {
  const p = fold(prompt)
  const legacy = deriveResearchGoals(prompt)
  const promptCandidates = extractPromptCandidates(prompt)
  const hasEvent = EVENT_TERM_RE.test(p)
  const destinationSelection =
    promptCandidates.length >= 2 ||
    (MULTI_PLACE_RE.test(p) &&
      (hasEvent || COMPARE_RE.test(p) || SAFETY_RE.test(p)))
  // A trip that depends on a specific event must verify it first, even with a
  // fixed destination and dates (the trip dates are its window).
  const askedTarget = extractEventTarget(prompt)
  const targetDependent =
    !!askedTarget && targetEventSentences(prompt, askedTarget).length > 0
  const eventDiscovery =
    EVENT_ANY_RE.test(p) &&
    (OPEN_TIMING_RE.test(p) || (hasEvent && destinationSelection) || targetDependent)
  if (targetDependent && !destinationSelection && !promptCandidates.length) {
    const fixed = targetEventDestination(prompt, askedTarget)
    if (fixed) promptCandidates.push(fixed)
  }

  const priorityCandidates = extractPriorityCandidates(prompt, promptCandidates)
  const regionStates = statesIn(prompt)

  if (!destinationSelection && !eventDiscovery) {
    return {
      goals: legacy,
      multiObjective: false,
      promptCandidates,
      priorityCandidates,
      regionStates,
      destinationSelection: false,
      eventDiscovery: false,
      dimensions: [],
    }
  }

  const eventWindow = eventDiscovery ? eventWindowFor(prompt) : undefined
  const eventTarget = eventDiscovery ? extractEventTarget(prompt) : undefined
  const goals: ResearchGoal[] = []
  const dimensions: ResearchDimension[] = []
  if (eventDiscovery) {
    // The event is researched first either way; it gates the package only when
    // the destination or the dates depend on it. With both fixed by the user,
    // an unverified event stays pending inside the trip.
    const tripFixed =
      !destinationSelection &&
      promptCandidates.length === 1 &&
      !!eventWindow?.to &&
      !EVENT_DATE_OPEN_RE.test(p)
    goals.push({
      id: GOAL_EVENT,
      kind: 'event_discovery',
      label: 'Próximo evento verificable (fecha + fuente oficial/actual)',
      important: true,
      tier: 'critical',
      status: 'UNRESOLVED',
      decisionCritical: !tripFixed,
    })
    dimensions.push('event')
  }
  if (destinationSelection) {
    goals.push({
      id: GOAL_DEST,
      kind: 'destination_selection',
      label: promptCandidates.length
        ? `Selección de destino entre candidatos (${promptCandidates.join(', ')})`
        : 'Selección de destino entre candidatos',
      important: true,
      tier: 'critical',
      status: 'UNRESOLVED',
      // Picking among destinations by preference is the model's recommendation
      // and the package keeps it as pending; only a pick that hinges on an
      // event still to be verified withholds the package.
      decisionCritical: eventDiscovery,
      dependsOn: [
        ...(eventDiscovery ? [GOAL_EVENT] : []),
        ...(SAFETY_RE.test(p) ? [GOAL_SAFETY] : []),
        ...(LODGING_RE.test(p) ? [GOAL_LODGING] : []),
      ],
    })
  }
  if (SAFETY_RE.test(p)) {
    goals.push({
      id: GOAL_SAFETY,
      kind: 'public_safety',
      label: 'Seguridad pública / incidencia delictiva de los candidatos',
      important: true,
      tier: 'supporting',
      status: 'UNRESOLVED',
    })
    dimensions.push('safety')
  }
  const legacyLodging = legacy.find((g) => g.kind === 'lodging_destination')
  if (LODGING_RE.test(p) || legacyLodging) {
    goals.push({
      id: GOAL_LODGING,
      kind: 'lodging_destination',
      label: 'Hospedaje en destino (candidatos)',
      important: true,
      tier: 'supporting',
      status: 'UNRESOLVED',
    })
    dimensions.push('lodging')
  }
  if (GROUND_RE.test(p) || legacy.some((g) => g.kind === 'ground_leg')) {
    goals.push({
      id: GOAL_GROUND,
      kind: 'ground_leg',
      label: 'Acceso / transporte terrestre al destino',
      important: true,
      tier: 'supporting',
      status: 'UNRESOLVED',
    })
    dimensions.push('ground')
  }
  for (const g of legacy) {
    if (goals.some((x) => x.id === g.id)) continue
    if (g.kind === 'event_activities' || g.kind === 'lodging_destination') continue
    if (g.kind === 'ground_leg') continue
    if (g.kind === 'flight_day_specific') {
      goals.push({ ...g, tier: 'secondary', important: false })
      dimensions.push('flight')
      continue
    }
    goals.push({ ...g, tier: 'secondary', important: false })
  }
  if (!dimensions.includes('flight') && FLIGHT_RE.test(p)) dimensions.push('flight')
  const lodgingTargets = lodgingTargetCount(prompt)

  return {
    goals,
    multiObjective: true,
    promptCandidates,
    priorityCandidates,
    regionStates,
    destinationSelection,
    eventDiscovery,
    ...(eventWindow ? { eventWindow } : {}),
    ...(eventTarget ? { eventTarget } : {}),
    dimensions,
    ...(lodgingTargets ? { lodgingTargets } : {}),
  }
}

// ---------------------------------------------------------------------------
// Planner state (recomputed from toolTrace after every call)
// ---------------------------------------------------------------------------

/** partial: event mentioned for the place without a date checkable against the window. */
export type CellState =
  | 'not_attempted'
  | 'attempted'
  | 'partial'
  | 'supported'
  | 'rejected'

export type CandidatePriority = 'verify_requested' | 'explicit' | 'inferred'

export type CandidateState = {
  name: string
  origin: 'prompt' | 'model_proposed'
  priority: CandidatePriority
  cells: Record<'event' | 'safety' | 'lodging' | 'ground', CellState>
  status: 'open' | 'discarded'
  discardReason?: string
}

export type DimensionState = {
  dimension: ResearchDimension
  level: number
  /** Discovery calls: webSearch, schedule search, fetch of a URL no search returned. */
  attempts: number
  limit: number
  /** Verification calls: fetchUrl of a URL an earlier discovery call returned. */
  verifications: number
  verifyLimit: number
  /** Fetches that returned no usable page (wall, HTTP error, no evidence). */
  failedFetches: number
  /** Failed fetches up to this many are free; beyond it they spend their phase budget. */
  failedFetchAllowance: number
  satisfied: boolean
  /** The last searches brought no new usable source: discovery ends before its limit. */
  stalled: boolean
  discoveryExhausted: boolean
  verificationExhausted: boolean
  /** Nothing left to do: discovery spent and no verification possible/pending. */
  exhausted: boolean
  pendingCandidates: string[]
  /** Promising discovered URLs not fetched yet, identity-compatible with the research. */
  pendingVerification: string[]
  /** Discovered URLs whose identity is another place (diagnostics only; never shown as pending). */
  excludedVerification: Array<{ url: string; reason: string }>
}

export type PlannerState = {
  candidates: CandidateState[]
  relevantCandidates: string[]
  /** Open prompt candidates without any event discovery yet (priority order). */
  uncoveredCandidates: string[]
  dimensions: DimensionState[]
  /** Lowest priority level with an open (unsatisfied, non-exhausted) dimension. */
  minOpenLevel: number
  /** Decision-critical research still open → the multi-objective budget applies. */
  decisionBudgetOpen: boolean
  /** An event dated inside the window (or dated at all, without a window). */
  hasEventEvidence: boolean
  /** Event mentions without a date checkable against the window. */
  hasPartialEventEvidence: boolean
  queriesUsed: string[]
  /** Fetched URLs (requested and final) that returned no usable page: never retried. */
  unusableUrls: string[]
  /** Hosts of those URLs: their other URLs are suggested last. */
  unusableHosts: string[]
  /** Model-proposed names rejected as candidates (diagnostics). */
  rejectedProposals: Array<{ name: string; reason: ProposedCandidateVerdict }>
  /**
   * Depth-first: a candidate's discovered event sources to verify before any
   * further discovery (other candidates, or its safety/lodging).
   */
  verifyFirst: { candidate: string; urls: string[] } | null
}

const DISCOVERY_LIMITS: Record<ResearchDimension, number> = {
  event: 4,
  safety: 3,
  lodging: 3,
  ground: 2,
  flight: 2,
  other: 2,
}

/** Separate from discovery so a spent discovery budget never blocks verifying its own results. */
const VERIFY_LIMITS: Record<ResearchDimension, number> = {
  event: 3,
  safety: 1,
  lodging: 1,
  ground: 1,
  flight: 1,
  other: 1,
}

/**
 * Unusable fetches (walls, HTTP errors, empty pages) never count as a
 * verification. Up to this many per dimension are free; further ones spend
 * the budget of their phase, so retries stay bounded.
 */
const FAILED_FETCH_ALLOWANCE: Record<ResearchDimension, number> = {
  event: 2,
  safety: 1,
  lodging: 1,
  ground: 1,
  flight: 1,
  other: 1,
}

/**
 * Schedule lookups that found no published (direct) flight — e.g. MEX→MNL
 * has only connections — leave the flight web search budget intact; one per leg.
 */
const EMPTY_SCHEDULE_ALLOWANCE = 2

/** Lodging searches when the prompt names more hotels than the default budget (one search each). */
const MAX_LODGING_DISCOVERY = 6

/** Event searches for a single destination: first try, reformulation, one more only after a productive one. */
const FIXED_DESTINATION_EVENT_LIMIT = 3

/** Model-proposed candidates tracked on top of the prompt's. */
const MAX_PROPOSED = 3

/** Event-source fetches per candidate before depth-first moves on to the next one. */
const VERIFY_FIRST_FETCHES_PER_CANDIDATE = 2

export function dimensionLevel(
  plan: ResearchPlan,
  dim: ResearchDimension,
): number {
  switch (dim) {
    case 'event':
      return 0
    case 'safety':
    case 'lodging':
      // Candidate evaluation: evaluated alongside event discovery, not after
      // a winner is declared.
      return plan.destinationSelection ? 0 : 1
    case 'ground':
    case 'other':
      return 1
    case 'flight':
      return 2
  }
}

const TRANSFER_RE = /\b(?:traslados?|transfers?|shuttles?|como llegar)\b/
const FLIGHT_WORD_RE = /\b(?:vuelos?|flights?|aerolineas?|airlines?|searchflightschedules|aerodatabox)\b/

export function classifyQueryDimensions(text: string): ResearchDimension[] {
  const f = fold(text)
  const dims: ResearchDimension[] = []
  // "traslado aeropuerto → hotel X" is ground access: the airport and the
  // hotel are its endpoints, so it spends neither the flight nor the lodging budget.
  const transfer = TRANSFER_RE.test(f) && !FLIGHT_WORD_RE.test(f)
  if (EVENT_ANY_RE.test(f)) dims.push('event')
  if (SAFETY_RE.test(f)) dims.push('safety')
  if (LODGING_RE.test(f) && !transfer) dims.push('lodging')
  if (GROUND_RE.test(f)) dims.push('ground')
  if (FLIGHT_RE.test(f) && !transfer) dims.push('flight')
  return dims.length ? dims : ['other']
}

export type CallPhase = 'discovery' | 'verification'

type Attribution = { dims: ResearchDimension[]; query: string; phase: CallPhase }

function entryAttribution(
  entry: { tool: string; args?: Record<string, unknown> },
  origins: Map<string, string>,
): Attribution {
  const args = entry.args ?? {}
  if (entry.tool === 'searchFlightSchedules') {
    return { dims: ['flight'], query: '', phase: 'discovery' }
  }
  if (entry.tool === 'fetchUrl') {
    const url = String(args.url ?? '')
    const origin = origins.get(url)
    if (origin) {
      return { dims: classifyQueryDimensions(origin), query: origin, phase: 'verification' }
    }
    return {
      dims: FLIGHT_RE.test(fold(url)) ? ['flight'] : ['other'],
      query: '',
      phase: 'discovery',
    }
  }
  const query = typeof args.query === 'string' ? args.query : ''
  return { dims: classifyQueryDimensions(query), query, phase: 'discovery' }
}

function mentions(text: string, name: string): boolean {
  return fold(text).includes(fold(name))
}

const CELL_RANK: Record<CellState, number> = {
  not_attempted: 0,
  attempted: 1,
  partial: 2,
  supported: 3,
  rejected: 4,
}

const PRIORITY_RANK: Record<CandidatePriority, number> = {
  verify_requested: 0,
  explicit: 1,
  inferred: 2,
}

function bump(c: CandidateState, dim: keyof CandidateState['cells'], to: CellState) {
  if (CELL_RANK[to] > CELL_RANK[c.cells[dim]]) c.cells[dim] = to
}

/**
 * With an event window, only a date inside it supports the event; a past or
 * out-of-window date is irrelevant (not positive, not negative) and a mention
 * without a parseable date stays partial.
 */
function sentenceVerdict(
  dim: keyof CandidateState['cells'],
  sentence: string,
  window?: EventWindow,
): CellState | null {
  const f = fold(sentence)
  switch (dim) {
    case 'event':
      if (!EVENT_TERM_RE.test(f)) return null
      if (EVENT_NEG_RE.test(f)) return 'rejected'
      if (!window) return DATE_RE.test(f) ? 'supported' : null
      switch (eventTiming(sentence, window)) {
        case 'in_window':
          return 'supported'
        case 'undated':
          return 'partial'
        default:
          return null
      }
    case 'safety':
      if (SAFETY_NEG_RE.test(f.replace(/\bsin alertas?\b/g, ''))) return 'rejected'
      if (SAFETY_POS_RE.test(f) || SAFETY_RE.test(f)) return 'supported'
      return null
    case 'lodging':
      if (LODGING_NEG_RE.test(f)) return 'rejected'
      return LODGING_RE.test(f) ? 'supported' : null
    case 'ground':
      return GROUND_RE.test(f) ? 'supported' : null
  }
}

function isSkipped(t: ToolTraceEntry): boolean {
  return Boolean((t.args as Record<string, unknown> | undefined)?.skipped)
}

const CELL_DIMS = ['event', 'safety', 'lodging', 'ground'] as const
type CellDim = (typeof CELL_DIMS)[number]

function isCellDim(d: ResearchDimension): d is CellDim {
  return (CELL_DIMS as readonly string[]).includes(d)
}

function emptyCells(): CandidateState['cells'] {
  return {
    event: 'not_attempted',
    safety: 'not_attempted',
    lodging: 'not_attempted',
    ground: 'not_attempted',
  }
}

export function computePlannerState(
  plan: ResearchPlan,
  toolTrace: ToolTraceEntry[],
): PlannerState {
  const executed = toolTrace.filter((t) => !isSkipped(t))
  const origins = originQueryByUrl(executed)
  const failedSeen = new Map<ResearchDimension, number>()
  let emptySchedules = 0
  const attributed = executed.map((t) => {
    const att = entryAttribution(t, origins)
    const failedFetch = t.tool === 'fetchUrl' && !t.ok
    const emptySchedule = t.tool === 'searchFlightSchedules' && !(t.sources ?? []).length
    const free =
      (failedFetch &&
        att.dims.every((d) => (failedSeen.get(d) ?? 0) < FAILED_FETCH_ALLOWANCE[d])) ||
      (emptySchedule && emptySchedules++ < EMPTY_SCHEDULE_ALLOWANCE)
    if (failedFetch) {
      for (const d of att.dims) failedSeen.set(d, (failedSeen.get(d) ?? 0) + 1)
    }
    return { entry: t, ...att, failedFetch, free }
  })
  const window = plan.eventWindow

  const candidates: CandidateState[] = plan.promptCandidates.map((name) => ({
    name,
    origin: 'prompt' as const,
    priority: plan.priorityCandidates.some((p) => fold(p) === fold(name))
      ? ('verify_requested' as const)
      : ('explicit' as const),
    cells: emptyCells(),
    status: 'open' as const,
  }))

  // Beyond the prompt, a candidate exists only when the model proposes it
  // explicitly; place names merely present in snippets never become one.
  const rejectedProposals: PlannerState['rejectedProposals'] = []
  if (plan.destinationSelection) {
    const evidence = executed
      .filter((t) => t.ok && (t.tool === 'webSearch' || t.tool === 'fetchUrl'))
      .flatMap((t) => t.sources ?? [])
    for (const t of executed) {
      const proposed = (t.args as Record<string, unknown> | undefined)?.candidates
      if (!Array.isArray(proposed)) continue
      for (const raw of proposed) {
        if (typeof raw !== 'string' || !raw.trim()) continue
        if (candidates.filter((c) => c.origin === 'model_proposed').length >= MAX_PROPOSED) break
        const verdict = proposedCandidateVerdict({
          name: raw,
          evidence,
          existing: candidates.map((c) => c.name),
          regionStates: plan.regionStates,
        })
        if (verdict === 'accepted') {
          candidates.push({
            name: raw.trim(),
            origin: 'model_proposed',
            priority: 'inferred',
            cells: emptyCells(),
            status: 'open',
          })
        } else if (
          verdict !== 'duplicate' &&
          !rejectedProposals.some((r) => fold(r.name) === fold(raw))
        ) {
          rejectedProposals.push({ name: raw.trim(), reason: verdict })
        }
      }
    }
  }
  candidates.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority])

  const target = plan.eventTarget
  /** Page of another edition: none of its dates speak for the window. */
  const staleEdition = (s: { url?: string; title?: string; snippet?: string }) =>
    window ? otherEditionYear(s, window) : null
  const namesTarget = (s: { url?: string; title?: string; snippet?: string }) =>
    !target || matchesEventTarget(`${s.title ?? ''} ${s.snippet ?? ''} ${urlSlugText(s.url ?? '')}`, target)

  let hasEventEvidence = false
  let hasPartialEventEvidence = false
  for (const a of attributed) {
    if (!a.dims.includes('event')) continue
    for (const s of a.entry.sources ?? []) {
      if (staleEdition(s)) continue
      for (const x of sentences(`${s.title ?? ''}. ${s.snippet ?? ''}`)) {
        const v = sentenceVerdict('event', x, window)
        if (v === 'supported') hasEventEvidence = true
        else if (v === 'partial') hasPartialEventEvidence = true
      }
    }
  }

  const allNames = candidates.map((c) => c.name)
  const identifiedIn = (sentence: string, sourceTitle: string) =>
    candidates.filter(
      (c) =>
        placeIdentity({
          sentence,
          name: c.name,
          otherNames: allNames,
          regionStates: plan.regionStates,
          sourceTitle,
        }) === 'identified',
    )

  for (const a of attributed) {
    for (const dim of CELL_DIMS) {
      if (!a.dims.includes(dim)) continue
      // Research effort only: a targeted query never makes its results evidence.
      for (const c of candidates) {
        if (namesPlace(a.query, c.name)) bump(c, dim, 'attempted')
      }
      for (const s of a.entry.sources ?? []) {
        if (dim === 'event' && staleEdition(s)) continue
        const title = s.title ?? ''
        for (const sentence of sentences(`${title}. ${s.snippet ?? ''}`)) {
          const verdict = sentenceVerdict(dim, sentence, window)
          if (!verdict) continue
          for (const c of identifiedIn(sentence, title)) {
            bump(c, dim, verdict)
            if (verdict === 'rejected' && c.status === 'open') {
              c.status = 'discarded'
              c.discardReason = `${dim}: ${sentence.slice(0, 160)}`
            }
          }
        }
      }
    }
  }

  const open = candidates.filter((c) => c.status === 'open')
  const eventBacked = open.filter((c) => c.cells.event === 'supported')
  const relevantCandidates = (eventBacked.length ? eventBacked : open).map((c) => c.name)
  const uncoveredCandidates = open
    .filter((c) => c.origin === 'prompt' && c.cells.event === 'not_attempted')
    .map((c) => c.name)

  // Free failed fetches spend no budget; beyond the allowance they count in their phase.
  const count = (dim: ResearchDimension, phase: CallPhase) =>
    attributed.filter((a) => a.phase === phase && !a.free && a.dims.includes(dim)).length
  const pendingFor = (dim: 'safety' | 'lodging') =>
    relevantCandidates.filter((n) => {
      const c = candidates.find((x) => x.name === n)!
      return c.cells[dim] === 'not_attempted'
    })
  const eventFetchOk = attributed.some(
    (a) =>
      a.entry.tool === 'fetchUrl' &&
      a.entry.ok &&
      a.dims.includes('event') &&
      (a.entry.sources ?? []).some((s) => !staleEdition(s)) &&
      (!target ||
        (a.entry.sources ?? []).some((s) =>
          !staleEdition(s) &&
          sentences(`${s.title ?? ''}. ${s.snippet ?? ''}`).some(
            (x) =>
              sentenceVerdict('event', x, window) === 'supported' && matchesEventTarget(x, target),
          ),
        )),
  )
  const fetchedUrls = new Set(
    executed
      .filter((t) => t.tool === 'fetchUrl')
      .map((t) => String((t.args as Record<string, unknown> | undefined)?.url ?? '')),
  )
  const unusableUrls = [
    ...new Set(
      attributed
        .filter((a) => a.failedFetch)
        .flatMap((a) => {
          const args = (a.entry.args ?? {}) as Record<string, unknown>
          return [args.url, args.finalUrl].filter(
            (u): u is string => typeof u === 'string' && u.length > 0,
          )
        }),
    ),
  ]
  const unusableHosts = [...new Set(unusableUrls.map(hostOf).filter(Boolean))]

  /** The source is about another place: a state outside the region or a sibling of a candidate. */
  const identityConflict = (text: string): string | null => {
    if (plan.regionStates.length) {
      const other = statesIn(text).filter((s) => !plan.regionStates.includes(s))
      if (other.length) return `names another state: ${other.join(', ')}`
    }
    const sibling = candidates.find((c) => namesSibling(text, c.name))
    return sibling ? `names a place other than ${sibling.name}` : null
  }

  const eventLead = (x: string) => {
    if (!window) return EVENT_TERM_RE.test(fold(x)) && !EVENT_NEG_RE.test(fold(x))
    const v = sentenceVerdict('event', x, window)
    return v === 'supported' || v === 'partial'
  }
  const walledLast = (xs: string[]) => [
    ...xs.filter((u) => !unusableHosts.includes(hostOf(u))),
    ...xs.filter((u) => unusableHosts.includes(hostOf(u))),
  ]
  /** Why a source cannot verify the asked event: another edition, or no mention of the target type. */
  const eventLeadRejection = (s: { url?: string; title?: string; snippet?: string }) => {
    const year = staleEdition(s)
    if (year) return `edition ${year}, outside the event window`
    return namesTarget(s) ? null : `no mention of the target event (${target})`
  }

  /**
   * Discovered, not yet fetched; results naming an open candidate first, hosts
   * that already returned a wall last. Results identified as another place are
   * kept apart (diagnostics) and never proposed for verification.
   */
  const promisingUrls = (
    dim: CellDim,
  ): { urls: string[]; excluded: Array<{ url: string; reason: string }> } => {
    const strong: string[] = []
    const weak: string[] = []
    const excluded: Array<{ url: string; reason: string }> = []
    const seen = new Set<string>()
    const hit = (x: string) =>
      dim === 'event' ? eventLead(x) : sentenceVerdict(dim, x) === 'supported'
    for (const a of attributed) {
      if (a.phase !== 'discovery' || !a.dims.includes(dim)) continue
      for (const s of a.entry.sources ?? []) {
        const url = s.url
        if (!url || fetchedUrls.has(url) || unusableUrls.includes(url) || seen.has(url)) continue
        seen.add(url)
        const title = s.title ?? ''
        const snippet = s.snippet ?? ''
        const sents = sentences(`${title}. ${snippet}`)
        const strongHit = sents.some(
          (x) => hit(x) && identifiedIn(x, title).some((c) => c.status === 'open'),
        )
        const weakHit =
          !strongHit &&
          dim === 'event' &&
          sents.some((x) => sentenceVerdict('event', x, window) === 'supported')
        if (!strongHit && !weakHit) continue
        const conflict = identityConflict(
          strongHit ? `${title} ${urlSlugText(url)}` : `${title} ${snippet} ${urlSlugText(url)}`,
        )
        if (conflict) {
          excluded.push({ url, reason: conflict })
          continue
        }
        const irrelevant = dim === 'event' ? eventLeadRejection(s) : null
        if (irrelevant) {
          excluded.push({ url, reason: irrelevant })
          continue
        }
        ;(strongHit ? strong : weak).push(url)
      }
    }
    return { urls: [...walledLast(strong), ...walledLast(weak)].slice(0, 5), excluded }
  }

  const identifiesIn = (
    s: { title?: string; snippet?: string },
    c: CandidateState,
    pred: (sentence: string) => boolean,
  ) => {
    const title = s.title ?? ''
    return sentences(`${title}. ${s.snippet ?? ''}`).some(
      (x) => pred(x) && identifiedIn(x, title).some((k) => k.name === c.name),
    )
  }
  /** A search result that could verify the asked event (same rules as verifyFirst leads). */
  const isEventLead = (s: { url?: string; title?: string; snippet?: string }) => {
    if (!s.url || eventLeadRejection(s)) return false
    if (identityConflict(`${s.title ?? ''} ${urlSlugText(s.url)}`)) return false
    const openCands = candidates.filter((c) => c.status === 'open')
    return openCands.length
      ? openCands.some((c) => identifiesIn(s, c, eventLead))
      : sentences(`${s.title ?? ''}. ${s.snippet ?? ''}`).some(eventLead)
  }
  /** New event leads each event search brought, in order (URLs seen before do not count). */
  const eventSearchYield: number[] = []
  {
    const seenUrls = new Set<string>()
    for (const a of attributed) {
      if (a.entry.tool !== 'webSearch' || a.phase !== 'discovery' || !a.dims.includes('event')) {
        continue
      }
      let fresh = 0
      for (const s of a.entry.sources ?? []) {
        if (s.url && !seenUrls.has(s.url) && isEventLead(s)) fresh += 1
      }
      for (const s of a.entry.sources ?? []) if (s.url) seenUrls.add(s.url)
      eventSearchYield.push(fresh)
    }
  }

  const dims: DimensionState[] = plan.dimensions.map((dim) => {
    const attempts = count(dim, 'discovery')
    const verifications = count(dim, 'verification')
    const failedFetches = attributed.filter((a) => a.failedFetch && a.dims.includes(dim)).length
    let limit = DISCOVERY_LIMITS[dim]
    let verifyLimit = VERIFY_LIMITS[dim]
    if (dim === 'lodging' && (plan.lodgingTargets ?? 0) > limit) {
      limit = Math.min(plan.lodgingTargets!, MAX_LODGING_DISCOVERY)
      verifyLimit = Math.max(verifyLimit, 2)
    }
    let satisfied = false
    let stalled = false
    let pendingCandidates: string[] = []
    switch (dim) {
      case 'event':
        pendingCandidates = uncoveredCandidates
        satisfied = hasEventEvidence && eventFetchOk && uncoveredCandidates.length === 0
        // Comparing places needs event searches per candidate; one place does not.
        if (!plan.destinationSelection) limit = FIXED_DESTINATION_EVENT_LIMIT
        // A reformulated search that surfaced nothing new ends the line: more
        // searches of the same kind would only repeat it.
        stalled =
          uncoveredCandidates.length === 0 &&
          eventSearchYield.length >= 2 &&
          eventSearchYield[eventSearchYield.length - 1] === 0
        break
      case 'safety':
      case 'lodging':
        pendingCandidates = pendingFor(dim)
        satisfied =
          attempts >= 1 &&
          (relevantCandidates.length === 0 || pendingCandidates.length === 0)
        break
      default:
        satisfied = attempts + verifications >= 1
    }
    const promising = isCellDim(dim) ? promisingUrls(dim) : { urls: [], excluded: [] }
    const pendingVerification = satisfied ? [] : promising.urls
    const discoveryExhausted = attempts >= limit || stalled
    const verificationExhausted = verifications >= verifyLimit
    return {
      dimension: dim,
      level: dimensionLevel(plan, dim),
      attempts,
      limit,
      verifications,
      verifyLimit,
      failedFetches,
      failedFetchAllowance: FAILED_FETCH_ALLOWANCE[dim],
      satisfied,
      stalled,
      discoveryExhausted,
      verificationExhausted,
      exhausted:
        discoveryExhausted &&
        (verificationExhausted || pendingVerification.length === 0),
      pendingCandidates,
      pendingVerification,
      excludedVerification: promising.excluded,
    }
  })

  const openDims = dims.filter((d) => !d.satisfied && !d.exhausted)
  const minOpenLevel = openDims.length
    ? Math.min(...openDims.map((d) => d.level))
    : Number.POSITIVE_INFINITY
  const decisionDims: ResearchDimension[] = [
    'event',
    ...(plan.destinationSelection ? (['safety', 'lodging'] as const) : []),
  ]
  const decisionBudgetOpen =
    plan.multiObjective &&
    dims.some(
      (d) => decisionDims.includes(d.dimension) && !d.satisfied && !d.exhausted,
    )

  const queriesUsed = executed
    .map((t) => (t.args as Record<string, unknown> | undefined)?.query)
    .filter((q): q is string => typeof q === 'string' && q.length > 0)

  const eventVerified = (c: CandidateState) =>
    attributed.some(
      (a) =>
        a.entry.tool === 'fetchUrl' &&
        a.entry.ok &&
        a.phase === 'verification' &&
        a.dims.includes('event') &&
        (a.entry.sources ?? []).some((s) =>
          !staleEdition(s) &&
          identifiesIn(
            s,
            c,
            (x) =>
              sentenceVerdict('event', x, window) === 'supported' && matchesEventTarget(x, target),
          ),
        ),
    )
  const eventLeads = (c: CandidateState) => {
    const urls: string[] = []
    for (const a of attributed) {
      if (a.phase !== 'discovery' || !a.dims.includes('event')) continue
      for (const s of a.entry.sources ?? []) {
        if (!s.url || urls.includes(s.url) || !identifiesIn(s, c, eventLead)) continue
        if (eventLeadRejection(s)) continue
        if (identityConflict(`${s.title ?? ''} ${urlSlugText(s.url)}`)) continue
        urls.push(s.url)
      }
    }
    return urls
  }
  let verifyFirst: PlannerState['verifyFirst'] = null
  const eventDim = dims.find((d) => d.dimension === 'event')
  if (eventDim && !eventDim.satisfied && !eventDim.verificationExhausted) {
    for (const c of candidates) {
      if (c.status !== 'open' || eventVerified(c)) continue
      const leads = eventLeads(c)
      const tried = leads.filter((u) => fetchedUrls.has(u)).length
      const pending = walledLast(
        leads.filter((u) => !fetchedUrls.has(u) && !unusableUrls.includes(u)),
      )
      if (tried >= VERIFY_FIRST_FETCHES_PER_CANDIDATE || pending.length === 0) continue
      verifyFirst = { candidate: c.name, urls: pending.slice(0, 3) }
      break
    }
  }

  return {
    candidates,
    relevantCandidates,
    uncoveredCandidates,
    dimensions: dims,
    minOpenLevel,
    decisionBudgetOpen,
    hasEventEvidence,
    hasPartialEventEvidence,
    queriesUsed,
    unusableUrls,
    unusableHosts,
    rejectedProposals,
    verifyFirst,
  }
}

// ---------------------------------------------------------------------------
// Loop gating
// ---------------------------------------------------------------------------

export type PlannerDenyReason =
  | 'candidate_discarded'
  | 'deferred_by_dependency'
  | 'deferred_for_priority_candidate'
  | 'deferred_for_explicit_candidate'
  | 'discovery_budget_exhausted'
  | 'verification_budget_exhausted'
  | 'unusable_url_repeat'
  | 'research_line_closed'
  | 'verify_candidate_first'

export type PlannerCallDecision =
  | { allow: true; level: number; phase: CallPhase }
  | { allow: false; level: number; reason: PlannerDenyReason; hint: string }

function parseArgs(argsJson: string): Record<string, unknown> {
  try {
    const v = JSON.parse(argsJson) as unknown
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export function plannedCallLevel(
  plan: ResearchPlan,
  toolName: string,
  argsJson: string,
  toolTrace: ToolTraceEntry[],
): { level: number; dims: ResearchDimension[]; query: string; phase: CallPhase } {
  const args = parseArgs(argsJson)
  const origins = originQueryByUrl(toolTrace.filter((t) => !isSkipped(t)))
  const att = entryAttribution({ tool: toolName, args }, origins)
  const level = Math.min(...att.dims.map((d) => dimensionLevel(plan, d)))
  return { level, dims: att.dims, query: att.query, phase: att.phase }
}

export type RequiredResearchAction =
  | { type: 'VERIFY_EVENT'; candidate?: string; eligibleUrls: string[]; reason: string }
  | {
      type: 'SEARCH_EVENT'
      candidate?: string
      targetEvent?: string
      dateWindow?: EventWindow
      reason: string
    }

/**
 * The only research the next step may do while event discovery is the sole
 * open priority: verify an eligible event source, else search the event again.
 * Null once the event is satisfied or used up, or when other research of the
 * same level may run alongside it (candidate evaluation).
 */
export function nextRequiredResearchAction(
  plan: ResearchPlan,
  state: PlannerState,
): RequiredResearchAction | null {
  if (!plan.multiObjective || !plan.eventDiscovery) return null
  const ev = state.dimensions.find((d) => d.dimension === 'event')
  if (!ev || ev.satisfied || ev.exhausted || ev.level !== state.minOpenLevel) return null
  if (state.verifyFirst) {
    return {
      type: 'VERIFY_EVENT',
      candidate: state.verifyFirst.candidate,
      eligibleUrls: state.verifyFirst.urls,
      reason: 'verify_first',
    }
  }
  const sameLevel = state.dimensions.some(
    (d) => d !== ev && d.level === ev.level && !d.satisfied && !d.exhausted,
  )
  if (sameLevel) return null
  const candidate =
    state.uncoveredCandidates[0] ?? state.candidates.find((c) => c.status === 'open')?.name
  if (ev.pendingVerification.length && !ev.verificationExhausted) {
    return {
      type: 'VERIFY_EVENT',
      candidate,
      eligibleUrls: ev.pendingVerification.slice(0, 3),
      reason: 'pending_event_verification',
    }
  }
  if (ev.discoveryExhausted) return null
  return {
    type: 'SEARCH_EVENT',
    candidate,
    targetEvent: plan.eventTarget,
    dateWindow: plan.eventWindow,
    reason: ev.pendingVerification.length ? 'event_verification_used_up' : 'no_eligible_event_source',
  }
}

/** Server instruction for a step restricted to the required action. */
export function requiredActionMessage(action: RequiredResearchAction, state: PlannerState): string {
  const wait =
    'Lodging, transport and flights wait until the event is verified or its research is used up.'
  if (action.type === 'VERIFY_EVENT') {
    return `REQUIRED NEXT ACTION (server planner): verify the event${action.candidate ? ` for ${action.candidate}` : ''} — call fetchUrl on one of: ${action.eligibleUrls.join(' ')}. Only fetchUrl is available this step. ${wait}`
  }
  const w = action.dateWindow
  const used = state.queriesUsed.length ? ` Do not repeat: ${state.queriesUsed.join(' | ')}.` : ''
  return `REQUIRED NEXT ACTION (server planner): a NEW webSearch for the ${action.targetEvent ?? 'event'}${action.candidate ? ` in ${action.candidate}` : ''}${w ? ` dated between ${w.from} and ${w.to ?? 'later'}` : ''}; name the event in the query.${used} Only webSearch is available this step. ${wait}`
}

function closedWhy(dims: Array<DimensionState | undefined>): string {
  return dims.some((d) => d?.stalled)
    ? 'the last search found no new usable source'
    : 'its search budget is spent and no found source is left to verify'
}

function depthFirstLine(vf: NonNullable<PlannerState['verifyFirst']>): string {
  return `Depth-first: verify ${vf.candidate} now with fetchUrl ${vf.urls.join(' ')}. New searches wait until it is verified or its sources are used up.`
}

/**
 * What to do now while the event is the open level: verify its pending
 * sources, else search it again. Null once the event is satisfied or its
 * research is used up.
 */
function nextEventAction(plan: ResearchPlan, state: PlannerState): string | null {
  const ev = state.dimensions.find((d) => d.dimension === 'event')
  if (!ev || ev.satisfied || ev.exhausted || ev.level !== state.minOpenLevel) return null
  if (state.verifyFirst) return `Do this now: ${depthFirstLine(state.verifyFirst)}`
  if (ev.pendingVerification.length && !ev.verificationExhausted) {
    return `Do this now: fetchUrl ${ev.pendingVerification.slice(0, 3).join(' ')} to verify the event.`
  }
  if (ev.discoveryExhausted) return null
  const candidate =
    state.candidates.find((c) => c.status === 'open' && c.cells.event !== 'supported')?.name ??
    state.relevantCandidates[0]
  const window = plan.eventWindow
    ? ` dated between ${plan.eventWindow.from} and ${plan.eventWindow.to ?? 'later'}`
    : ''
  return `Do this now: webSearch for the ${plan.eventTarget ?? 'event'}${candidate ? ` in ${candidate}` : ''}${window} (event discovery ${ev.attempts}/${ev.limit}).`
}

export function planToolCallDecision(input: {
  plan: ResearchPlan
  state: PlannerState
  toolName: string
  argsJson: string
  toolTrace: ToolTraceEntry[]
}): PlannerCallDecision {
  const { plan, state } = input
  const { level, dims, query, phase } = plannedCallLevel(
    plan,
    input.toolName,
    input.argsJson,
    input.toolTrace,
  )
  const openList = state.dimensions
    .filter((d) => !d.satisfied && !d.exhausted)
    .map((d) =>
      d.pendingCandidates.length
        ? `${d.dimension} (pending: ${d.pendingCandidates.join(', ')})`
        : d.dimension,
    )
    .join('; ')

  if (input.toolName === 'fetchUrl') {
    const url = String(parseArgs(input.argsJson).url ?? '').trim()
    if (url && state.unusableUrls.includes(url)) {
      return {
        allow: false,
        level,
        reason: 'unusable_url_repeat',
        hint: `${url} already returned no usable page (login/JS/consent wall, HTTP error or no evidence). Do not fetch it again; verify with a different, fetchable HTML page (official site, news, tourism portal).`,
      }
    }
  }

  const targeted = state.candidates.filter((c) => namesPlace(query, c.name))
  if (targeted.length > 0 && targeted.every((c) => c.status === 'discarded')) {
    return {
      allow: false,
      level,
      reason: 'candidate_discarded',
      hint: `Candidate(s) ${targeted.map((c) => c.name).join(', ')} already discarded by evidence. Research the open candidates instead: ${state.relevantCandidates.join(', ') || '—'}.`,
    }
  }
  if (level > state.minOpenLevel) {
    const next = nextEventAction(plan, state)
    return {
      allow: false,
      level,
      reason: 'deferred_by_dependency',
      hint: `Research order: event discovery and candidate evaluation (event/safety/lodging per candidate) before ground access, flights last. Still open: ${openList || '—'}.${next ? ` ${next}` : ''}`,
    }
  }
  const tracked = dims.filter((d) => d !== 'other')
  const dimState = (d: ResearchDimension) =>
    state.dimensions.find((x) => x.dimension === d)
  const allTracked = (pred: (s: DimensionState) => boolean) =>
    tracked.length > 0 &&
    tracked.every((d) => {
      const s = dimState(d)
      return s ? pred(s) : false
    })

  if (phase === 'verification') {
    if (allTracked((s) => s.verificationExhausted)) {
      return {
        allow: false,
        level,
        reason: 'verification_budget_exhausted',
        hint: `Verification budget reached for ${tracked.join(', ')}. Work with the evidence gathered; still open: ${openList || '—'}.`,
      }
    }
    if (allTracked((s) => s.exhausted && !s.satisfied)) {
      return {
        allow: false,
        level,
        reason: 'research_line_closed',
        hint: `${tracked.join(', ')} research is closed (${closedWhy(tracked.map(dimState))}); it stays unverified. Move on — still open: ${openList || '—'}.`,
      }
    }
    return { allow: true, level, phase }
  }

  const vf = state.verifyFirst
  if (vf && tracked.some((d) => d === 'event' || d === 'safety' || d === 'lodging')) {
    return {
      allow: false,
      level,
      reason: 'verify_candidate_first',
      hint: `Verify ${vf.candidate} before more discovery: fetchUrl ${vf.urls.join(' ')} (a discovered event source may resolve the critical requirement). If it does not, the next source or candidate follows.`,
    }
  }

  if (allTracked((s) => s.discoveryExhausted)) {
    const verify = tracked
      .flatMap((d) => {
        const s = dimState(d)
        return s && !s.verificationExhausted ? s.pendingVerification : []
      })
      .slice(0, 3)
    return {
      allow: false,
      level,
      reason: 'discovery_budget_exhausted',
      hint: verify.length
        ? `Discovery closed for ${tracked.join(', ')}. Verify results already found instead (fetchUrl): ${verify.join(' ')}`
        : `Discovery closed for ${tracked.join(', ')} (${closedWhy(tracked.map(dimState))}). Work with the evidence gathered; still open: ${openList || '—'}.`,
    }
  }

  const ev = dims.includes('event') ? dimState('event') : undefined
  if (ev) {
    const remaining = ev.limit - ev.attempts
    const uncovered = state.uncoveredCandidates
    const priority = uncovered.filter(
      (n) => state.candidates.find((c) => c.name === n)?.priority === 'verify_requested',
    )
    const hits = (names: string[]) => names.some((n) => namesPlace(query, n))
    if (priority.length && !hits(priority) && remaining <= priority.length) {
      return {
        allow: false,
        level,
        reason: 'deferred_for_priority_candidate',
        hint: `The user explicitly asked to verify ${priority.join(', ')}; research it before other candidates (${remaining} event discovery call(s) left).`,
      }
    }
    if (uncovered.length && !hits(uncovered) && remaining <= uncovered.length) {
      return {
        allow: false,
        level,
        reason: 'deferred_for_explicit_candidate',
        hint: `Candidates named by the user still lack event research: ${uncovered.join(', ')}. Only ${remaining} event discovery call(s) left — name at most 2 of them per query.`,
      }
    }
  }
  return { allow: true, level, phase }
}

export function shouldForcePlannerRound(input: {
  plan: ResearchPlan
  state: PlannerState
  forcedRounds: number
  toolCallsUsed: number
  maxToolCalls: number
  steps: number
  maxSteps: number
}): boolean {
  if (!input.plan.multiObjective) return false
  if (input.forcedRounds >= 3) return false
  if (input.toolCallsUsed >= input.maxToolCalls) return false
  if (input.steps >= input.maxSteps - 1) return false
  // Every asked part of the trip gets its attempt; closed lines stay closed.
  return input.state.dimensions.some((d) => !d.satisfied && !d.exhausted)
}

/**
 * Short note when research moves to the next priority level: what closed (and
 * how it stands) and what to research now, so no step is spent on a deferral.
 */
export function buildResearchTransitionNote(state: PlannerState, remainingCalls: number): string {
  const closed = state.dimensions
    .filter((d) => d.level < state.minOpenLevel)
    .map((d) =>
      d.satisfied
        ? `${d.dimension}: covered`
        : `${d.dimension}: closed unverified (${closedWhy([d])}) — report it as pending`,
    )
  const now = state.dimensions
    .filter((d) => !d.satisfied && !d.exhausted && d.level === state.minOpenLevel)
    .map((d) => d.dimension)
  return [
    `RESEARCH PLANNER (server): ${closed.join('; ') || 'previous research done'}.`,
    now.length
      ? `Research now: ${now.join(' + ')}${now.length > 1 ? ' — issue these calls together in this turn' : ''}. Remaining tool budget: ${remainingCalls} call(s).`
      : 'Every asked part is researched or closed. fetchUrl a promising result only if it would change the answer; otherwise stop calling tools.',
  ].join('\n')
}

export function buildPlannerNudge(input: {
  plan: ResearchPlan
  state: PlannerState
  remainingCalls: number
}): string {
  const { plan, state } = input
  const lines: string[] = [
    'RESEARCH PLANNER (server): multi-objective request — research by dependency, not flights first.',
    `Remaining tool budget: ${input.remainingCalls} call(s). It is a ceiling: stop as soon as every open part below is covered.`,
    'Budgets per dimension are split: discovery (webSearch) and verification (fetchUrl of a result a search already returned). Spending discovery never blocks verifying what it found.',
    'A part that cannot be verified is closed as pending/unverified and research moves on; the rest of the trip is still researched.',
    'Independent calls of the same priority (e.g. lodging and ground transport, or outbound and return flights) go together in ONE turn.',
  ]
  const open = state.dimensions.filter((d) => !d.satisfied && !d.exhausted)
  if (open.length) {
    lines.push('', 'Open research (priority order):')
    for (const d of [...open].sort((a, b) => a.level - b.level)) {
      const pending = d.pendingCandidates.length
        ? ` — pending candidates: ${d.pendingCandidates.join(', ')}`
        : ''
      const failed = d.failedFetches ? `, unusable pages ${d.failedFetches}` : ''
      lines.push(
        `- [P${d.level}] ${d.dimension}${pending} (discovery ${d.attempts}/${d.limit}, verification ${d.verifications}/${d.verifyLimit}${failed})`,
      )
      if (d.pendingVerification.length && !d.verificationExhausted) {
        lines.push(`  verify with fetchUrl: ${d.pendingVerification.slice(0, 3).join(' ')}`)
      }
    }
  }
  if (state.verifyFirst) lines.push(depthFirstLine(state.verifyFirst))
  const openCands = state.candidates.filter((c) => c.status === 'open')
  if (plan.destinationSelection) {
    lines.push(
      '',
      'Candidate evaluation: gather event + safety + lodging evidence for each OPEN candidate before choosing a destination. One focused query per candidate/dimension (no mega-queries).',
      `Open candidates (priority order): ${openCands.map((c) => c.name).join(', ') || '— (discover them via event research)'}`,
    )
    if (plan.priorityCandidates.length) {
      lines.push(
        `The user explicitly asked to verify: ${plan.priorityCandidates.join(', ')} — research these first.`,
      )
    }
    if (state.uncoveredCandidates.length) {
      const ev = state.dimensions.find((d) => d.dimension === 'event')
      const remaining = ev ? Math.max(0, ev.limit - ev.attempts) : 0
      lines.push(
        `Named by the user, no event research yet: ${state.uncoveredCandidates.join(', ')}.` +
          (remaining < state.uncoveredCandidates.length
            ? ` Only ${remaining} event discovery call(s) left: name at most 2 of them per query so none is dropped.`
            : ''),
      )
    }
    const discarded = state.candidates.filter((c) => c.status === 'discarded')
    if (discarded.length) {
      lines.push(
        `Do not research further: ${discarded.map((c) => c.name).join(', ')} (discarded by evidence that names the place; verify before stating it as fact).`,
      )
    }
    lines.push(
      'New candidates: a place only mentioned in a snippet is NOT a candidate. To add one, pass its complete town/municipality name in webSearch.candidates (never a state, region or country).',
    )
  }
  if (plan.eventDiscovery) {
    lines.push(
      'Event discovery: prefer official/current sources (municipio, parroquia, turismo estatal); fetchUrl the most promising page to confirm the date.',
    )
    if (plan.eventWindow) {
      lines.push(
        `Only events dated between ${plan.eventWindow.from} and ${plan.eventWindow.to ?? 'later'} count; past editions are not evidence of an upcoming event.`,
      )
    }
  }
  if (state.unusableUrls.length) {
    lines.push(
      `Unusable pages (login/JS/consent wall, HTTP error or no evidence) — never fetch again: ${state.unusableUrls.slice(0, 5).join(' ')}`,
      `Prefer fetchable HTML pages (official municipal/tourism sites, news, event portals) over hosts that returned a wall: ${state.unusableHosts.join(', ')}.`,
    )
  }
  lines.push('Flights only after destination and date are plausible.')
  if (state.queriesUsed.length) {
    lines.push('', 'Queries already used (do not repeat):')
    for (const q of state.queriesUsed) lines.push(`- ${q}`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Goal assessment (loop + final)
// ---------------------------------------------------------------------------

/** Prompt candidates no call targeted in any dimension. */
export function notResearchedCandidates(state: PlannerState): string[] {
  return state.candidates
    .filter(
      (c) =>
        c.origin === 'prompt' &&
        Object.values(c.cells).every((v) => v === 'not_attempted'),
    )
    .map((c) => c.name)
}

function isHttps(u: unknown): boolean {
  return typeof u === 'string' && /^https:\/\//i.test(u)
}

function verifiedWebClaims(claims: AgentClaimDraft[] | undefined) {
  return (claims ?? []).filter(
    (c) =>
      c.sourceType === 'web' &&
      c.verificationStatus === 'verified' &&
      isHttps(c.sourceUrl),
  )
}

function asRec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

function packageDestination(pkg: unknown): string {
  return String(asRec(asRec(pkg).trip).destination ?? '')
}

function verifiedEventOptions(pkg: unknown): Record<string, unknown>[] {
  const opts = asRec(pkg).travelOptions
  if (!Array.isArray(opts)) return []
  return opts.map(asRec).filter(
    (o) =>
      (o.type === 'event' || o.type === 'activity') &&
      o.verificationStatus === 'verified' &&
      isHttps(o.sourceUrl) &&
      EVENT_TERM_RE.test(fold(`${String(o.title ?? '')} ${String(o.description ?? '')}`)),
  )
}

export type GroundedEvidence = {
  validClaims: AgentClaimDraft[]
  package: unknown
}

/**
 * Assess plan goals. Without grounded output (inside the tool loop), decision
 * goals are at most PARTIAL: RESOLVED requires a grounded, verified, https
 * web claim or entity.
 */
export function assessPlannerGoals(
  plan: ResearchPlan,
  toolTrace: ToolTraceEntry[],
  opts: {
    grounded?: GroundedEvidence
    availableTools?: string[]
    tripDates?: string[]
  } = {},
): ResearchGoal[] {
  const state = computePlannerState(plan, toolTrace)
  const claims = verifiedWebClaims(opts.grounded?.validClaims)
  const legacyAssessed = assessResearchGoals(
    plan.goals.filter(
      (g) =>
        g.kind !== 'event_discovery' &&
        g.kind !== 'destination_selection' &&
        g.kind !== 'public_safety',
    ),
    toolTrace,
    { package: opts.grounded?.package, tripDates: opts.tripDates },
  )
  const dim = (d: ResearchDimension) =>
    state.dimensions.find((x) => x.dimension === d)

  const window = plan.eventWindow
  const windowLabel = window ? ` inside ${window.from}–${window.to ?? '…'}` : ''
  // A grounded claim about a past edition is true but does not answer "the next event".
  const eventClaims = claims.filter((c) => {
    const f = fold(c.statement)
    if (!EVENT_TERM_RE.test(f) || !DATE_RE.test(f)) return false
    if (!matchesEventTarget(c.statement, plan.eventTarget)) return false
    return !window || eventTiming(c.statement, window) === 'in_window'
  })
  const eventOptions = verifiedEventOptions(opts.grounded?.package).filter((o) =>
    matchesEventTarget(String(o.title ?? ''), plan.eventTarget),
  )

  const out: ResearchGoal[] = plan.goals.map((g) => {
    if (g.kind === 'event_discovery') {
      if (eventClaims.length || eventOptions.length) {
        return {
          ...g,
          status: 'RESOLVED' as GoalStatus,
          evidenceNote: `dated event${windowLabel} backed by a verified https source`,
        }
      }
      if (state.hasEventEvidence) {
        return {
          ...g,
          status: 'PARTIAL' as GoalStatus,
          evidenceNote: `dated event mentions${windowLabel} found in search results; not grounded as a verified claim`,
        }
      }
      if (state.hasPartialEventEvidence) {
        return {
          ...g,
          status: 'PARTIAL' as GoalStatus,
          evidenceNote: `event mentions without a date verifiable${windowLabel}; not grounded as a verified claim`,
        }
      }
      return {
        ...g,
        status: 'UNRESOLVED' as GoalStatus,
        evidenceNote: `${dim('event')?.attempts ?? 0} event search attempt(s), no dated event evidence${windowLabel}`,
      }
    }
    if (g.kind === 'public_safety') {
      const safetyClaims = claims.filter((c) => SAFETY_RE.test(fold(c.statement)))
      if (safetyClaims.length) {
        return {
          ...g,
          status: 'RESOLVED' as GoalStatus,
          evidenceNote: 'safety finding backed by a verified https source',
        }
      }
      const d = dim('safety')
      const touched = state.candidates.some(
        (c) => c.cells.safety === 'supported' || c.cells.safety === 'rejected',
      )
      return {
        ...g,
        status: (touched || (d?.attempts ?? 0) > 0 ? 'PARTIAL' : 'UNRESOLVED') as GoalStatus,
        evidenceNote: d?.pendingCandidates.length
          ? `pending candidates: ${d.pendingCandidates.join(', ')}`
          : `${d?.attempts ?? 0} safety search attempt(s)`,
      }
    }
    if (g.kind === 'destination_selection') {
      const open = state.relevantCandidates
      const discarded = state.candidates.filter((c) => c.status === 'discarded')
      const eventGoal = plan.goals.find((x) => x.kind === 'event_discovery')
      const eventResolved =
        !eventGoal || eventClaims.length > 0 || eventOptions.length > 0
      const dest = fold(packageDestination(opts.grounded?.package))
      let resolved = false
      if (eventResolved && dest) {
        if (open.length === 1) {
          resolved = dest.includes(fold(open[0]!))
        } else if (state.candidates.length === 0) {
          const head = dest.split(',')[0]!.trim()
          resolved =
            head.length > 0 &&
            [...eventClaims.map((c) => c.statement), ...eventOptions.map((o) => String(o.title ?? ''))]
              .some((t) => fold(t).includes(head))
        }
      }
      const notResearched = notResearchedCandidates(state)
      const note = [
        open.length ? `open candidates: ${open.join(', ')}` : 'no open candidates',
        discarded.length
          ? `discarded (heuristic planning signal): ${discarded.map((c) => c.name).join(', ')}`
          : '',
        notResearched.length ? `not researched: ${notResearched.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('; ')
      if (resolved) {
        return { ...g, status: 'RESOLVED' as GoalStatus, evidenceNote: note }
      }
      const anyEvidence = state.candidates.some((c) =>
        Object.values(c.cells).some(
          (v) => v === 'supported' || v === 'rejected' || v === 'partial',
        ),
      )
      return {
        ...g,
        status: (anyEvidence || state.hasEventEvidence || state.hasPartialEventEvidence
          ? 'PARTIAL'
          : 'UNRESOLVED') as GoalStatus,
        evidenceNote: note,
      }
    }
    const legacy = legacyAssessed.find((x) => x.id === g.id)
    if (!legacy) return g
    if (
      g.kind === 'lodging_destination' &&
      legacy.status === 'UNRESOLVED' &&
      (dim('lodging')?.attempts ?? 0) > 0
    ) {
      return {
        ...legacy,
        status: 'PARTIAL' as GoalStatus,
        evidenceNote: `${dim('lodging')!.attempts} lodging search attempt(s); no anchored lodging option`,
      }
    }
    return legacy
  })

  return opts.availableTools ? markUnsupportedGoals(out, opts.availableTools) : out
}

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

export type ResponseShape = {
  shape: 'package' | 'research_only'
  reasons: string[]
}

export function decideResponseShape(input: {
  noMutation: boolean
  goals: ResearchGoal[]
}): ResponseShape {
  const reasons: string[] = []
  if (input.noMutation) {
    reasons.push('el usuario pidió no crear/modificar nada todavía')
  }
  for (const g of input.goals) {
    if (g.decisionCritical && g.status !== 'RESOLVED') {
      reasons.push(`${g.label}: ${g.status}`)
    }
  }
  return {
    shape: reasons.length ? 'research_only' : 'package',
    reasons,
  }
}

/** Package answer: every asked part research could not verify is flagged as pending. */
export function pendingGoalWarnings(goals: ResearchGoal[]): string[] {
  return goals
    .filter((g) => g.important && g.status !== 'RESOLVED')
    .map(
      (g) =>
        `server: pendiente de verificar — ${g.label}: ${STATUS_LABEL[g.status]}. No se presenta como confirmado.`,
    )
}

const STATUS_LABEL: Record<GoalStatus, string> = {
  RESOLVED: 'resuelto',
  PARTIAL: 'parcial',
  UNRESOLVED: 'sin resolver',
  UNSUPPORTED: 'sin herramienta disponible',
}

const CELL_LABEL: Record<CellState, string> = {
  not_attempted: 'no investigado',
  attempted: 'buscado, sin evidencia que identifique el lugar',
  partial: 'mencionado sin fecha verificable dentro de las fechas pedidas (no verificado)',
  supported: 'resultados de búsqueda lo mencionan (no verificado)',
  rejected: 'señal negativa en resultados de búsqueda (no verificada)',
}

/** Negative conclusion about availability of evidence/data ("no se encontró", "sin datos", …). */
const NEGATIVE_CONCLUSION_RE =
  /\b(?:no se (?:encontr|hall|localiz|pudo|dispone|verific|confirm|identific|registr)\w*|sin (?:evidencia|datos|informacion|resultados|fuentes?|registros?)\b|no (?:hay|existen?|tienen?|cuentan?|registran?|habra)\b|ningun[oa]?\b|descartad\w*)/

/**
 * "Not researched" ≠ "researched without evidence": a model warning that
 * concludes absence of evidence about a candidate never researched in that
 * dimension (every dimension when the warning names none) is dropped.
 */
export function filterUnresearchedNegativeWarnings(
  warnings: string[],
  state: PlannerState,
): string[] {
  const kept: string[] = []
  const named = new Set<string>()
  for (const w of warnings) {
    if (/^server:/i.test(w) || !NEGATIVE_CONCLUSION_RE.test(fold(w))) {
      kept.push(w)
      continue
    }
    const dims = classifyQueryDimensions(w).filter(isCellDim)
    const unresearched = state.candidates.filter(
      (c) =>
        namesPlace(w, c.name) &&
        (dims.length
          ? dims.some((d) => c.cells[d] === 'not_attempted')
          : CELL_DIMS.every((d) => c.cells[d] === 'not_attempted')),
    )
    if (!unresearched.length) {
      kept.push(w)
      continue
    }
    for (const c of unresearched) named.add(c.name)
  }
  if (named.size) {
    kept.push(
      `server: advertencia(s) del modelo omitida(s): concluían falta de evidencia sobre candidatos que no se investigaron (${[...named].join(', ')}); no investigado no equivale a investigado sin evidencia.`,
    )
  }
  return kept
}

const DIM_LABEL: Record<CellDim, string> = {
  event: 'evento',
  safety: 'seguridad',
  lodging: 'hospedaje',
  ground: 'transporte terrestre',
}

/** Concrete data (dates, times, prices, counts) beyond a bare year. */
function hasConcreteData(text: string): boolean {
  return /\d/.test(text.replace(/\b20\d{2}\b/g, ''))
}

function candidateStatusLines(
  state: PlannerState,
  dimensions: ResearchDimension[],
): string[] {
  const dims = CELL_DIMS.filter((d) => dimensions.includes(d))
  return state.candidates.map((c) => {
    const tag =
      c.priority === 'verify_requested'
        ? ' (verificación pedida por el usuario)'
        : c.origin === 'model_proposed'
          ? ' (propuesto por el modelo a partir de resultados)'
          : ''
    const cells = dims.map((d) => `${DIM_LABEL[d]}: ${CELL_LABEL[c.cells[d]]}`).join('; ')
    const status =
      c.status === 'discarded'
        ? ' — descartado como señal de planificación (no verificado)'
        : ''
    return `- ${c.name}${tag}: ${cells || 'sin dimensiones investigadas'}${status}`
  })
}

/**
 * Research-only draft: findings + open questions, no operational package.
 * The narrative is server-built from grounded claims, goal status and planner
 * state only; model prose never reaches it (a claim rejected by grounding must
 * not come back paraphrased).
 */
export function toResearchOnlyDraft(
  draft: Record<string, unknown>,
  req: AgentAskRequest,
  opts: {
    isNewTravel: boolean
    goals: ResearchGoal[]
    reasons: string[]
    validClaims: AgentClaimDraft[]
    planner?: { state: PlannerState; dimensions: ResearchDimension[] }
  },
): Record<string, unknown> {
  const modelTrip = asRec(asRec(draft.package).trip)
  const ctxTrip = asRec(req.context.trip)
  const trip = opts.isNewTravel
    ? {
        id: String(modelTrip.id ?? req.tripId),
        title: 'Investigación — destino y fechas por confirmar',
        startDate: modelTrip.startDate ?? ctxTrip.startDate,
        endDate: modelTrip.endDate ?? ctxTrip.endDate,
        timezone: modelTrip.timezone ?? 'America/Mexico_City',
        goals: [],
        notes: '',
        status: 'planned',
      }
    : {
        id: ctxTrip.id ?? req.tripId,
        title: ctxTrip.title ?? 'Viaje',
        destination: ctxTrip.destination ?? null,
        startDate: ctxTrip.startDate,
        endDate: ctxTrip.endDate,
        timezone: ctxTrip.timezone ?? 'America/Mexico_City',
        goals: Array.isArray(ctxTrip.goals) ? ctxTrip.goals : [],
        notes: '',
        status: ctxTrip.status ?? 'planned',
      }

  const findings = opts.validClaims
    .filter((c) => c.sourceType === 'web' && isHttps(c.sourceUrl))
    .slice(0, 8)
    .map((c) => `- ${c.statement} (${c.verificationStatus}; ${c.sourceUrl})`)
  const status = opts.goals
    .filter((g) => g.important || g.decisionCritical)
    .map((g) => `- ${g.label}: ${STATUS_LABEL[g.status]}`)

  const pending: string[] = []
  const candidateLines: string[] = []
  if (opts.planner) {
    const { state, dimensions } = opts.planner
    candidateLines.push(...candidateStatusLines(state, dimensions))
    const notResearched = notResearchedCandidates(state)
    if (notResearched.length) {
      pending.push(`- Candidatos nombrados sin investigar: ${notResearched.join(', ')}`)
    }
    const unverified = state.dimensions.flatMap((d) => d.pendingVerification)
    if (unverified.length) {
      pending.push(
        `- Resultados descubiertos sin verificar (fetch pendiente): ${[...new Set(unverified)].slice(0, 3).join(' ')}`,
      )
    }
  }
  for (const g of opts.goals) {
    if ((g.important || g.decisionCritical) && g.status !== 'RESOLVED') {
      pending.push(`- ${g.label}`)
    }
  }

  const narrative = [
    findings.length
      ? 'Resultado de investigación: sólo se presentan hallazgos respaldados por fuente verificada; todo lo demás sigue pendiente de verificar. No se generó ningún cambio operativo.'
      : 'Resultado de investigación: todavía no hay evidencia verificada suficiente para proponer destino, fechas ni reservas. No se generó ningún cambio operativo.',
    '',
    'Estado de la investigación:',
    ...(status.length ? status : ['- sin objetivos derivados']),
    ...(candidateLines.length ? ['', 'Candidatos (estado interno de la investigación):', ...candidateLines] : []),
    ...(findings.length ? ['', 'Hallazgos con fuente:', ...findings] : []),
    ...(pending.length ? ['', 'Pendiente de verificar:', ...pending] : []),
  ].join('\n')

  // Model-authored warnings may restate facts grounding rejected; keep only
  // those without concrete data. Server warnings pass through.
  const rawWarnings = Array.isArray(draft.warnings)
    ? draft.warnings.filter((w): w is string => typeof w === 'string')
    : []
  const prevWarnings = opts.planner
    ? filterUnresearchedNegativeWarnings(rawWarnings, opts.planner.state)
    : rawWarnings
  const keptWarnings = prevWarnings.filter(
    (w) => /^server:/i.test(w) || !hasConcreteData(w),
  )
  const droppedWarnings = prevWarnings.length - keptWarnings.length

  return {
    narrative,
    warnings: [
      `server: respuesta sólo de investigación (${opts.reasons.join('; ')}); sin paquete operativo ni ops.`,
      ...keptWarnings,
      ...(droppedWarnings
        ? [
            `server: ${droppedWarnings} advertencia(s) del modelo omitida(s) en modo investigación (contenían datos concretos sin grounding).`,
          ]
        : []),
    ],
    diffSummary: [],
    claims: [],
    ops: [],
    package: {
      schemaVersion: 1,
      packageId: opts.isNewTravel ? `new-${trip.id}` : undefined,
      revision: 1,
      trip,
      travelOptions: [],
      itineraryItems: [],
      checklistItems: [],
      notes: [],
    },
  }
}
