import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import type { ToolTraceEntry } from '../../shared/agentContracts.ts'
import { fetchUrl } from '../tools/fetchUrl.ts'
import {
  MAX_PASSAGES,
  PASSAGE_MAX_CHARS,
  TITLE_MAX_CHARS,
  htmlToText,
} from '../tools/pageEvidence.ts'
import {
  resolveClaimEvidence,
  validateClaimsAgainstToolTrace,
  type AgentClaimLlm,
} from './claims.ts'
import { evidenceRefsForEntry, renderToolContentForModel } from './evidenceRefs.ts'
import { toolCallOutcome } from './newTravelCoherence.ts'

type Route = { status?: number; body: string; finalUrl?: string }

const realFetch = globalThis.fetch
function mockFetch(routes: Record<string, Route>): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const r = routes[url]
    const res = r
      ? new Response(r.body, { status: r.status ?? 200, headers: { 'content-type': 'text/html' } })
      : new Response('not found', { status: 404 })
    if (r?.finalUrl) Object.defineProperty(res, 'url', { value: r.finalUrl })
    return res
  }) as typeof fetch
}
afterEach(() => {
  globalThis.fetch = realFetch
})

// Test fixture only (no place name is special-cased in production code).
const PAGE_URL = 'https://ferias.example/feria-totatiche'
const SERENATA = 'Domingo 4 de octubre de 2026, 22:00 — Serenata en la plaza principal.'
const NAV_ITEMS = [
  'Inicio', 'Menú principal', 'FERIAS', 'FESTIVALES', 'CONCIERTOS', 'CARNAVALES',
  'Botón claro/oscuro', 'Buscar', 'Iniciar sesión', 'Suscríbete', 'Ferias de Jalisco',
  'Ferias de Zacatecas', 'Ferias de Nayarit', 'Ferias de Aguascalientes', 'Ferias de Michoacán',
  'Ferias de Colima', 'Ferias de Guanajuato', 'Calendario 2026', 'Contacto',
]
const PAGE_HTML = [
  '<html><head><title>Feria Totatiche 2026 - Ferias</title></head><body>',
  `<nav><ul>${NAV_ITEMS.map((i) => `<li><a href="#">${i}</a></li>`).join('')}</ul></nav>`,
  '<main><h1>Feria Totatiche 2026</h1>',
  '<p>La feria se celebra en la cabecera municipal con actividades culturales para toda la familia.</p>',
  `<p>${SERENATA}</p>`,
  '<p>Lunes 5 de octubre de 2026, 20:00 — Baile popular en el jardín municipal.</p>',
  '</main><footer><p>Todos los derechos reservados. Política de privacidad. Cookies.</p></footer>',
  '</body></html>',
].join('')

function webClaim(statement: string, url: string, evidenceIndex: number): AgentClaimLlm {
  return {
    kind: 'other_factual',
    statement,
    sourceType: 'web',
    sourceUrl: url,
    evidenceIndex,
    verificationStatus: 'verified',
    confidence: 'high',
  }
}

function searchEntry(query: string, sources: ToolTraceEntry['sources']): ToolTraceEntry {
  return {
    tool: 'webSearch',
    args: { query, provider: 'tavily' },
    ok: true,
    sources,
    checkedAt: '2026-09-28T18:00:00+00:00',
  }
}

describe('P0 fetchUrl evidence is preserved for grounding', () => {
  it('data after character 240 is stored in the trace and grounds the claim the model makes from it', async () => {
    mockFetch({ [PAGE_URL]: { body: PAGE_HTML, finalUrl: `${PAGE_URL}/` } })
    assert.ok(htmlToText(PAGE_HTML).indexOf('Domingo 4 de octubre') > 240, 'fixture: data after char 240')

    const { trace } = await fetchUrl(PAGE_URL)
    assert.equal(trace.ok, true)
    assert.equal(trace.args?.quality, 'usable')
    // Stored under the requested URL (the one search results and claims cite), not the redirect.
    assert.equal(trace.args?.finalUrl, `${PAGE_URL}/`)
    assert.ok(trace.sources.every((s) => s.url === PAGE_URL))
    assert.ok(!trace.sources.some((s) => /Menú principal/.test(s.snippet ?? '')), 'navigation dropped')
    const idx = trace.sources.findIndex((s) => s.snippet?.includes(SERENATA))
    assert.ok(idx >= 0, 'the serenata passage is stored')

    const statement = 'Serenata en la plaza principal el domingo 4 de octubre de 2026 a las 22:00'
    const result = validateClaimsAgainstToolTrace([webClaim(statement, PAGE_URL, idx)], [trace])
    assert.equal(result.invalid.length, 0, JSON.stringify(result.invalid))
    assert.match(result.valid[0]!.quotedFact, /Serenata en la plaza principal/)
    assert.equal(result.valid[0]!.sourceTitle, 'Feria Totatiche 2026 - Ferias')
  })

  it('the model receives exactly the stored passages (nothing only the LLM saw)', async () => {
    mockFetch({ [PAGE_URL]: { body: PAGE_HTML } })
    const { trace } = await fetchUrl(PAGE_URL)
    const content = JSON.parse(renderToolContentForModel(trace, [], 'fallback')) as {
      payload: { passages: Array<{ sourceUrl: string; evidenceIndex: number; text: string }> }
    }
    assert.deepEqual(
      content.payload.passages.map((p) => p.text),
      trace.sources.map((s) => s.snippet),
    )
    for (const p of content.payload.passages) {
      const r = resolveClaimEvidence(p.sourceUrl, p.evidenceIndex, [trace])
      assert.ok(r.ok && r.quotedFact.includes(p.text))
    }
  })

  it('size stays bounded: at most MAX_PASSAGES passages of PASSAGE_MAX_CHARS, title capped', async () => {
    const paragraphs = Array.from(
      { length: 60 },
      (_, i) => `<p>El día ${(i % 28) + 1} de octubre de 2026 hay actividad número ${i} en la plaza, con música y comida típica para visitantes.</p>`,
    ).join('')
    mockFetch({
      [PAGE_URL]: { body: `<title>${'Programa '.repeat(40)}</title><body>${paragraphs}</body>` },
    })
    const { trace } = await fetchUrl(PAGE_URL)
    assert.ok(trace.sources.length > 0 && trace.sources.length <= MAX_PASSAGES)
    for (const s of trace.sources) {
      assert.ok((s.snippet ?? '').length <= PASSAGE_MAX_CHARS)
      assert.ok((s.title ?? '').length <= TITLE_MAX_CHARS)
    }
    const r = resolveClaimEvidence(PAGE_URL, 0, [trace])
    assert.ok(r.ok && r.quotedFact.length <= 800, 'title + passage fits quotedFact')
  })
})

describe('P1 evidenceIndex contract (toolTrace → model → claims → grounding)', () => {
  it('single source: the exposed index is 0; index 1 fails closed', () => {
    const url = 'https://noticias.example/serenata'
    const s = searchEntry('serenata', [
      { url, title: 'Serenata', snippet: 'Serenata el 3 de octubre de 2026' },
    ])
    const refs = evidenceRefsForEntry(s, [])
    assert.deepEqual(refs.map((r) => r.evidenceIndex), [0])
    const ok = validateClaimsAgainstToolTrace(
      [webClaim('Serenata el 3 de octubre de 2026', url, 0)],
      [s],
    )
    assert.equal(ok.valid.length, 1)
    const bad = validateClaimsAgainstToolTrace(
      [webClaim('Serenata el 3 de octubre de 2026', url, 1)],
      [s],
    )
    assert.equal(bad.valid.length, 0)
    assert.equal(bad.invalid[0]!.code, 'evidence_index_invalid')
  })

  it('multiple evidences for one URL: every exposed (sourceUrl, evidenceIndex) resolves to the text shown with it', async () => {
    mockFetch({ [PAGE_URL]: { body: PAGE_HTML } })
    const trace: ToolTraceEntry[] = []
    const shown: Array<{ sourceUrl: string; evidenceIndex: number; text: string }> = []
    const push = (e: ToolTraceEntry) => {
      shown.push(...evidenceRefsForEntry(e, trace))
      trace.push(e)
    }
    push(searchEntry('feria Totatiche', [
      { url: PAGE_URL, title: 'Feria Totatiche 2026', snippet: 'Programa de la feria' },
      { url: 'https://otro.example/a', title: 'Otro', snippet: 'Otro resultado' },
    ]))
    push((await fetchUrl(PAGE_URL)).trace)
    push(searchEntry('serenata Totatiche', [
      { url: PAGE_URL, title: 'Feria Totatiche 2026', snippet: 'Programa de la feria (repetido)' },
    ]))
    const forUrl = shown.filter((r) => r.sourceUrl === PAGE_URL)
    assert.deepEqual(
      forUrl.map((r) => r.evidenceIndex),
      forUrl.map((_, i) => i),
      'indices are dense and unique per URL',
    )
    assert.ok(forUrl.length >= 3)
    for (const r of shown) {
      const resolved = resolveClaimEvidence(r.sourceUrl, r.evidenceIndex, trace)
      assert.ok(resolved.ok && resolved.quotedFact.includes(r.text), `${r.sourceUrl}#${r.evidenceIndex}`)
    }
    // Rendered for the model with the same pairs.
    const fetchContent = JSON.parse(renderToolContentForModel(trace[1]!, trace.slice(0, 1), 'x')) as {
      payload: { passages: Array<{ evidenceIndex: number }>; citation: string }
    }
    assert.equal(fetchContent.payload.passages[0]!.evidenceIndex, 1)
    assert.match(fetchContent.payload.citation, /NOT the position in this list/)
  })

  it('invalid or wrong index fails closed and is never autocorrected', async () => {
    mockFetch({ [PAGE_URL]: { body: PAGE_HTML } })
    const trace: ToolTraceEntry[] = [
      searchEntry('feria', [{ url: PAGE_URL, title: 'Feria', snippet: 'Programa de la feria' }]),
    ]
    trace.push((await fetchUrl(PAGE_URL)).trace)
    const statement = 'Serenata en la plaza principal el domingo 4 de octubre de 2026 a las 22:00'
    const outOfRange = validateClaimsAgainstToolTrace([webClaim(statement, PAGE_URL, 99)], trace)
    assert.equal(outOfRange.invalid[0]!.code, 'evidence_index_invalid')
    // Index 0 is the search snippet: the server does not hop to the passage that has the numbers.
    const wrong = validateClaimsAgainstToolTrace([webClaim(statement, PAGE_URL, 0)], trace)
    assert.equal(wrong.valid.length, 0)
    assert.equal(wrong.invalid[0]!.code, 'number_mismatch')
  })

  it('cabef4a6: search URL without slash + fetch redirected to a slash URL → passage index resolves', async () => {
    mockFetch({ [PAGE_URL]: { body: PAGE_HTML, finalUrl: `${PAGE_URL}/` } })
    const search = searchEntry('feria Totatiche', [
      { url: PAGE_URL, title: 'Feria Totatiche 2026', snippet: '29 de septiembre: Gran inauguración' },
    ])
    const fetched = (await fetchUrl(PAGE_URL)).trace
    const ref = evidenceRefsForEntry(fetched, [search]).find((r) => r.text.includes(SERENATA))!
    assert.ok(ref.evidenceIndex >= 1)
    const res = validateClaimsAgainstToolTrace(
      [webClaim('Serenata el domingo 4 de octubre de 2026 a las 22:00', PAGE_URL, ref.evidenceIndex)],
      [search, fetched],
    )
    assert.equal(res.valid.length, 1, JSON.stringify(res.invalid))
  })
})

describe('P3 fetch quality: walls are unusable, not verifications', () => {
  const FB_URL = 'https://www.facebook.com/Totatiche.Jalisco/posts/123'
  const IG_URL = 'https://www.instagram.com/p/DcFtQQLNmEk'
  const facebookJsWall =
    '<html><head><title>Buenos días ☀️. Pues... - Totatiche, Jalisco</title></head><body>' +
    '<script type="application/json">{"require":[["ScheduledServerJS","handle",null,[{"__bbox":{"define":[["cr:310",["RunWWW"],{"__rc":["RunWWW",null]},-1]'
  const instagramLogin =
    '<html><head><title>Instagram</title></head><body><div>Log in</div><div>Sign up</div>' +
    '<span>Log in to see photos and videos from friends.</span><a>Forgot password?</a></body></html>'

  it('Facebook JS wall (script cut at MAX_BYTES) → unusable js_required, no sources', async () => {
    mockFetch({ [FB_URL]: { body: facebookJsWall } })
    const { trace } = await fetchUrl(FB_URL)
    assert.equal(trace.ok, false)
    assert.equal(trace.error, 'unusable: js_required')
    assert.deepEqual(trace.sources, [])
    assert.equal(toolCallOutcome(trace), 'unusable_source')
  })

  it('Instagram login wall → unusable login_wall', async () => {
    mockFetch({ [IG_URL]: { body: instagramLogin } })
    const { trace } = await fetchUrl(IG_URL)
    assert.equal(trace.ok, false)
    assert.equal(trace.error, 'unusable: login_wall')
    assert.equal(trace.args?.quality, 'login_wall')
    assert.deepEqual(trace.sources, [])
  })

  it('consent wall and empty page are unusable too; HTTP errors keep no sources', async () => {
    mockFetch({
      'https://c.example/a': {
        body: '<title>Before you continue</title><p>Before you continue to the site, accept all cookies.</p>',
      },
      'https://e.example/a': { body: '<title>Vacío</title><body><div>Hola</div></body>' },
    })
    assert.equal((await fetchUrl('https://c.example/a')).trace.error, 'unusable: consent_wall')
    assert.equal((await fetchUrl('https://e.example/a')).trace.error, 'unusable: no_evidence')
    const notFound = (await fetchUrl('https://missing.example/x')).trace
    assert.equal(notFound.error, 'HTTP 404')
    assert.deepEqual(notFound.sources, [])
    assert.equal(toolCallOutcome(notFound), 'tool_failure')
  })

  it('control positive: a usable HTML page with a "log in" link in its header stays usable', async () => {
    mockFetch({
      [PAGE_URL]: { body: PAGE_HTML.replace('<nav>', '<header><a>Log in</a></header><nav>') },
    })
    const { trace } = await fetchUrl(PAGE_URL)
    assert.equal(trace.ok, true)
    assert.equal(trace.args?.quality, 'usable')
    assert.equal(toolCallOutcome(trace), 'ok')
  })
})
