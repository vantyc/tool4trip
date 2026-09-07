import type { ToolTraceEntry } from '../../shared/agentContracts.ts'
import { wrapUntrustedToolPayload } from './registry.ts'

export type WebHit = {
  title: string
  url: string
  snippet: string
}

export type WebSearchOptions = {
  provider?: string
  enableDdgFallback?: boolean
  signal?: AbortSignal
}

/**
 * webSearch — results are always UNTRUSTED.
 * Production default: Tavily only (WEB_SEARCH_PROVIDER=tavily).
 * DDG only if ENABLE_DDG_FALLBACK=1.
 */
export async function webSearch(
  query: string,
  opts: WebSearchOptions = {},
): Promise<{ hits: WebHit[]; trace: ToolTraceEntry; contentForModel: string }> {
  const checkedAt = new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00')
  const provider = (opts.provider || process.env.WEB_SEARCH_PROVIDER || 'tavily')
    .trim()
    .toLowerCase()
  const enableDdg =
    opts.enableDdgFallback ?? process.env.ENABLE_DDG_FALLBACK === '1'
  const signal = opts.signal ?? AbortSignal.timeout(15_000)

  try {
    if (provider === 'tavily') {
      const tavilyKey = process.env.TAVILY_API_KEY?.trim()
      if (!tavilyKey) {
        const trace: ToolTraceEntry = {
          tool: 'webSearch',
          args: { query, provider: 'tavily' },
          ok: false,
          sources: [],
          error: 'TAVILY_API_KEY missing',
          checkedAt,
        }
        return {
          hits: [],
          trace,
          contentForModel: wrapUntrustedToolPayload('webSearch', {
            error: 'TAVILY_API_KEY missing',
            hits: [],
          }),
        }
      }
      return await searchTavily(query, tavilyKey, checkedAt, signal)
    }

    if (enableDdg) {
      return await searchDdg(query, checkedAt, signal)
    }

    const trace: ToolTraceEntry = {
      tool: 'webSearch',
      args: { query, provider },
      ok: false,
      sources: [],
      error: `unsupported WEB_SEARCH_PROVIDER="${provider}" (DDG fallback disabled)`,
      checkedAt,
    }
    return {
      hits: [],
      trace,
      contentForModel: wrapUntrustedToolPayload('webSearch', {
        error: trace.error,
        hits: [],
      }),
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      const trace: ToolTraceEntry = {
        tool: 'webSearch',
        args: { query, provider },
        ok: false,
        sources: [],
        error: 'aborted',
        checkedAt,
      }
      return {
        hits: [],
        trace,
        contentForModel: wrapUntrustedToolPayload('webSearch', {
          error: 'aborted',
          hits: [],
        }),
      }
    }
    const trace: ToolTraceEntry = {
      tool: 'webSearch',
      args: { query, provider },
      ok: false,
      sources: [],
      error: err instanceof Error ? err.message : 'webSearch failed',
      checkedAt,
    }
    return {
      hits: [],
      trace,
      contentForModel: wrapUntrustedToolPayload('webSearch', {
        error: trace.error,
        hits: [],
      }),
    }
  }
}

async function searchTavily(
  query: string,
  apiKey: string,
  checkedAt: string,
  signal: AbortSignal,
): Promise<{ hits: WebHit[]; trace: ToolTraceEntry; contentForModel: string }> {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: 5,
      include_answer: false,
    }),
    signal,
  })
  if (!res.ok) {
    const trace: ToolTraceEntry = {
      tool: 'webSearch',
      args: { query, provider: 'tavily' },
      ok: false,
      sources: [],
      error: `tavily HTTP ${res.status}`,
      checkedAt,
    }
    return {
      hits: [],
      trace,
      contentForModel: wrapUntrustedToolPayload('webSearch', {
        error: trace.error,
        hits: [],
      }),
    }
  }
  const data = (await res.json()) as {
    results?: { title?: string; url?: string; content?: string }[]
  }
  const hits = (data.results ?? []).slice(0, 5).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: (r.content ?? '').slice(0, 400),
  }))
  const trace: ToolTraceEntry = {
    tool: 'webSearch',
    args: { query, provider: 'tavily' },
    ok: true,
    sources: hits.map((h) => ({
      url: h.url || undefined,
      title: h.title || undefined,
      snippet: h.snippet || undefined,
    })),
    checkedAt,
  }
  return {
    hits,
    trace,
    contentForModel: wrapUntrustedToolPayload('webSearch', {
      provider: 'tavily',
      trust: 'UNTRUSTED',
      hits,
    }),
  }
}

async function searchDdg(
  query: string,
  checkedAt: string,
  signal: AbortSignal,
): Promise<{ hits: WebHit[]; trace: ToolTraceEntry; contentForModel: string }> {
  const ddg = new URL('https://api.duckduckgo.com/')
  ddg.searchParams.set('q', query)
  ddg.searchParams.set('format', 'json')
  ddg.searchParams.set('no_html', '1')
  ddg.searchParams.set('skip_disambig', '1')
  const res = await fetch(ddg, { signal })
  const data = (await res.json()) as {
    AbstractURL?: string
    AbstractText?: string
    Heading?: string
    RelatedTopics?: { Text?: string; FirstURL?: string }[]
  }
  const hits: WebHit[] = []
  if (data.AbstractURL) {
    hits.push({
      title: data.Heading || query,
      url: data.AbstractURL,
      snippet: data.AbstractText || '',
    })
  }
  for (const t of data.RelatedTopics ?? []) {
    if (t.FirstURL && t.Text && hits.length < 5) {
      hits.push({ title: t.Text.slice(0, 80), url: t.FirstURL, snippet: t.Text })
    }
  }
  const trace: ToolTraceEntry = {
    tool: 'webSearch',
    args: { query, provider: 'duckduckgo' },
    ok: true,
    sources: hits.map((h) => ({
      url: h.url || undefined,
      title: h.title || undefined,
      snippet: h.snippet || undefined,
    })),
    checkedAt,
    error:
      hits.length === 0
        ? 'Sin resultados DDG; use Tavily en producción'
        : undefined,
  }
  return {
    hits,
    trace,
    contentForModel: wrapUntrustedToolPayload('webSearch', {
      provider: 'duckduckgo',
      trust: 'UNTRUSTED',
      hits,
    }),
  }
}
