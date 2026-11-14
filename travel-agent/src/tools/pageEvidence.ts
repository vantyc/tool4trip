/**
 * Page → bounded evidence passages for fetchUrl.
 *
 * The passages selected here are the ONLY page text the model receives and
 * the ONLY text stored in toolTrace, so grounding validates exactly what the
 * model saw. Each passage must fit claims' quotedFact (800 chars) together
 * with the page title.
 */

export const PASSAGE_MAX_CHARS = 600
export const MAX_PASSAGES = 8
export const TITLE_MAX_CHARS = 120
/** Upper bound of page text scanned for passages (bytes are capped upstream). */
const MAX_SCAN_CHARS = 60_000
const MIN_PASSAGE_WORDS = 4
const MIN_PASSAGE_SCORE = 1.5

export type PageQuality =
  | 'usable'
  | 'login_wall'
  | 'js_required'
  | 'consent_wall'
  | 'no_evidence'

const BLOCK_TAG_RE =
  /<\/?(?:p|div|li|ul|ol|h[1-6]|br|tr|td|th|section|article|header|footer|nav|main|aside|table|blockquote|figcaption|dt|dd)\b[^>]*>/gi

/**
 * Strip tags naively — content is UNTRUSTED; never execute scripts/instructions.
 * Block boundaries become newlines so menus never merge with the prose after them.
 */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      // A body cut at MAX_BYTES can leave a script/style open: drop the tail.
      .replace(/<(script|style)\b[\s\S]*$/i, ' ')
      .replace(BLOCK_TAG_RE, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n\s*/g, '\n')
    .trim()
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n: string) => {
      const code = Number(n)
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' '
    })
}

export function pageTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (!m) return ''
  return decodeEntities(m[1]!.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TITLE_MAX_CHARS)
}

/** Block lines split into sentences, none longer than PASSAGE_MAX_CHARS (document order). */
function splitUnits(text: string): string[] {
  const units: string[] = []
  for (const line of text.slice(0, MAX_SCAN_CHARS).split('\n')) {
    for (const sentence of line.split(/(?<=[.!?])\s+/)) {
      let rest = sentence.trim()
      while (rest.length > PASSAGE_MAX_CHARS) {
        const cut = rest.lastIndexOf(' ', PASSAGE_MAX_CHARS)
        const at = cut > PASSAGE_MAX_CHARS / 2 ? cut : PASSAGE_MAX_CHARS
        units.push(rest.slice(0, at).trim())
        rest = rest.slice(at).trim()
      }
      if (rest) units.push(rest)
    }
  }
  return units
}

/**
 * Consecutive informative units packed into passages of at most
 * PASSAGE_MAX_CHARS; uninformative units (menus, headings, boilerplate, JSON)
 * are dropped and end the current passage.
 */
export function splitPassages(text: string): string[] {
  const out: string[] = []
  let cur = ''
  for (const u of splitUnits(text)) {
    if (passageScore(u) < MIN_PASSAGE_SCORE) {
      if (cur) out.push(cur)
      cur = ''
      continue
    }
    if (cur && cur.length + 1 + u.length > PASSAGE_MAX_CHARS) {
      out.push(cur)
      cur = u
    } else {
      cur = cur ? `${cur} ${u}` : u
    }
  }
  if (cur) out.push(cur)
  return out
}

const BOILERPLATE_RE =
  /saltar al contenido|skip to (?:main )?content|men[uú] principal|main menu|iniciar sesi[oó]n|inicia sesi[oó]n|log in|sign up|reg[ií]strate|cookies?|pol[ií]tica de privacidad|privacy policy|todos los derechos|all rights reserved|copyright|suscr[ií]bete|newsletter|compart(?:e|ir) en|leer m[aá]s|bot[oó]n claro\/oscuro/gi
const DATE_OR_TIME_RE =
  /\b\d{1,2}(?:\s+de)?\s+(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|january|february|march|april|may|june|july|august|september|october|november|december)\b|\b\d{1,2}:\d{2}\b|\b\d{1,2}\s*[ap]\.?\s*m\b|\b20\d{2}-\d{2}-\d{2}\b/i

/** Evidence density: prose with dates/numbers scores up; menus, JSON and boilerplate score down. */
export function passageScore(p: string): number {
  const words = p.split(/\s+/).filter(Boolean)
  if (words.length < MIN_PASSAGE_WORDS) return Number.NEGATIVE_INFINITY
  const jsonish = (p.match(/[{}[\]"\\]/g) ?? []).length / p.length
  if (jsonish > 0.05) return Number.NEGATIVE_INFINITY
  const lower = words.filter((w) => /^\p{Ll}/u.test(w)).length / words.length
  let score = lower * 2
  if (/[.,;:]/.test(p)) score += 1
  if (/\d/.test(p)) score += 1
  if (DATE_OR_TIME_RE.test(p)) score += 2
  score -= 2 * Math.min(2, (p.match(BOILERPLATE_RE) ?? []).length)
  return score
}

/** Highest-scoring passages, re-emitted in document order. */
export function selectPassages(text: string, max = MAX_PASSAGES): string[] {
  return splitPassages(text)
    .map((p, i) => ({ p, i, s: passageScore(p) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, max)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.p)
}

const JS_WALL_RE =
  /"require"\s*:\s*\[\s*\[\s*"ScheduledServerJS"|__bbox|enable javascript|javascript is (?:disabled|required)|habilita(?:r)? javascript|activa(?:r)? javascript|please enable js|you need to enable javascript/i
const LOGIN_WALL_RE =
  /\blog ?in\b|\bsign ?up\b|iniciar sesi[oó]n|inicia sesi[oó]n|reg[ií]strate|you must log in|log into facebook|forgot password|¿olvidaste tu contrase[nñ]a/i
const CONSENT_WALL_RE =
  /before you continue|antes de continuar|consent|acepta(?:r)? (?:todas )?(?:las )?cookies|accept (?:all )?cookies/i

/**
 * Classify a fetched 2xx page by what it actually returned: any citable
 * passage makes it usable (a page with a "log in" link in its menu is not a
 * wall); without one, the wall signal only names why it is unusable.
 */
export function classifyPage(input: {
  html: string
  text: string
  passages: string[]
}): PageQuality {
  if (input.passages.length > 0) return 'usable'
  if (JS_WALL_RE.test(input.html)) return 'js_required'
  if (LOGIN_WALL_RE.test(input.text)) return 'login_wall'
  if (CONSENT_WALL_RE.test(input.text)) return 'consent_wall'
  return 'no_evidence'
}
