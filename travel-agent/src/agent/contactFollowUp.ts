import type { ToolTraceEntry } from '../../shared/agentContracts.ts'
import { evidenceTextsForUrl, phoneNumbersIn } from './entityEvidence.ts'

/**
 * Contact follow-up: when the user asked for phones/contact and a webSearch
 * item says its page has contact data but shows no number, the server fetches
 * that page itself (the model may stop without doing it). The passages land
 * in toolTrace under the same URL, so grounding still decides what survives.
 */
export const CONTACT_FOLLOW_UP_MAX_URLS = 2

const CONTACT_REQUEST_RE =
  /\b(?:tel[eé]fonos?|telef[oó]nic[oa]s?|contactos?|contactarl[oe]s?|contactar|llamarles|llamarlos|llamarle|llamar|whats\s?app|celular(?:es)?|phones?|contacts?)\b/i

const CONTACT_SIGNAL_RE =
  /tel[eé]fono|\btel\.\s*:|\bllamar\b|\bcontacto\b|whats\s?app|\bphone\b|\bcontact\b|\bcall us\b/i

/** Social networks, OTAs, maps and encyclopedias: not the establishment's own page or a contact directory. */
const EXCLUDED_BRANDS = new Set([
  'facebook',
  'instagram',
  'tiktok',
  'youtube',
  'twitter',
  'linkedin',
  'pinterest',
  'whatsapp',
  'expedia',
  'booking',
  'tripadvisor',
  'airbnb',
  'trivago',
  'kayak',
  'despegar',
  'agoda',
  'priceline',
  'orbitz',
  'vrbo',
  'hostelworld',
  'hotelscombined',
  'hotels',
  'hoteles',
  'google',
  'bing',
  'yelp',
  'wikipedia',
])
const EXCLUDED_DOMAINS = ['x.com', 'fb.com', 'm.me', 'wa.me', 't.co', 'goo.gl', 'alojamiento.io']

const DATE_LIKE_RE = /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/

export function userAskedForContact(prompt: string): boolean {
  return CONTACT_REQUEST_RE.test(prompt)
}

export function isContactFetchableUrl(url: string): boolean {
  let host: string
  try {
    const u = new URL(url)
    if (!/^https?:$/i.test(u.protocol)) return false
    host = u.hostname.toLowerCase()
  } catch {
    return false
  }
  if (EXCLUDED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) return false
  return !host
    .split('.')
    .slice(0, -1)
    .some((label) => EXCLUDED_BRANDS.has(label))
}

export function hasUsablePhone(text: string): boolean {
  return phoneNumbersIn(text).some((n) => {
    const digits = n.replace(/\D/g, '')
    return digits.length >= 8 && digits.length <= 15 && !DATE_LIKE_RE.test(n.trim())
  })
}

function fetchedUrls(toolTrace: ToolTraceEntry[]): Set<string> {
  const out = new Set<string>()
  for (const t of toolTrace) {
    if (t.tool !== 'fetchUrl') continue
    const args = (t.args ?? {}) as Record<string, unknown>
    const requested = args.requested as Record<string, unknown> | undefined
    for (const u of [args.url, args.finalUrl, requested?.url]) {
      if (typeof u === 'string' && u.trim()) out.add(u.trim())
    }
  }
  return out
}

/**
 * webSearch URLs worth one server fetch: the item itself signals contact
 * data, no evidence stored for that URL has a usable number yet, the URL was
 * never fetched, and it is not a social/OTA page. First-seen order, capped.
 */
export function contactFollowUpUrls(
  toolTrace: ToolTraceEntry[],
  max = CONTACT_FOLLOW_UP_MAX_URLS,
): string[] {
  const fetched = fetchedUrls(toolTrace)
  const out: string[] = []
  for (const entry of toolTrace) {
    if (entry.tool !== 'webSearch' || !entry.ok) continue
    for (const s of entry.sources ?? []) {
      if (out.length >= max) return out
      const url = s.url?.trim()
      if (!url || out.includes(url) || fetched.has(url)) continue
      if (!isContactFetchableUrl(url)) continue
      if (!CONTACT_SIGNAL_RE.test(`${s.title ?? ''}\n${s.snippet ?? ''}`)) continue
      if (evidenceTextsForUrl(toolTrace, url).some(hasUsablePhone)) continue
      out.push(url)
    }
  }
  return out
}

export function buildContactFollowUpNote(urls: string[]): string {
  return [
    'CONTACT FOLLOW-UP (server): the user asked for phone/contact details and these search results mention contact information without showing a number, so the server fetched them (fetchUrl results above):',
    ...urls.map((u) => `- ${u}`),
    'Revise your answer with that evidence. A candidate gets a phone ONLY when a passage for its own sourceUrl states it for that establishment: copy the number as written and cite that sourceUrl + evidenceIndex. Never move a number to another establishment and never infer one. If no passage states it, keep phone null and say it is pending.',
    'Do not fetch these URLs again. Call another tool only if something decisive is still missing; otherwise answer.',
  ].join('\n')
}
