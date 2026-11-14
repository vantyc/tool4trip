import { useEffect, useState } from 'react'
import type { BoardStop } from '../../application/tripBoard/buildTripBoard'

/**
 * Lead photo and coordinates of a place from English Wikipedia (free,
 * no key, CORS via origin=*). Results are cached in localStorage so the
 * board does not refetch on every visit.
 */

export type PlaceMedia = {
  photo?: string
  pageUrl?: string
  pageTitle?: string
  lat?: number
  lon?: number
}

const CACHE_PREFIX = 't4t-place-media:'
const TTL_MS = 30 * 24 * 60 * 60 * 1000
const inflight = new Map<string, Promise<PlaceMedia>>()

type WikiPage = {
  title?: string
  fullurl?: string
  thumbnail?: { source?: string }
  coordinates?: Array<{ lat: number; lon: number }>
  missing?: string
}

function readCache(key: string): PlaceMedia | undefined {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key)
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as { at: number; media: PlaceMedia }
    if (Date.now() - parsed.at > TTL_MS) return undefined
    return parsed.media
  } catch {
    return undefined
  }
}

function writeCache(key: string, media: PlaceMedia): void {
  try {
    localStorage.setItem(
      CACHE_PREFIX + key,
      JSON.stringify({ at: Date.now(), media }),
    )
  } catch {
    // Storage full or disabled: the photo just loads again next time.
  }
}

async function queryWikipedia(params: Record<string, string>): Promise<PlaceMedia> {
  const url = new URL('https://en.wikipedia.org/w/api.php')
  const all: Record<string, string> = {
    action: 'query',
    format: 'json',
    formatversion: '2',
    origin: '*',
    redirects: '1',
    prop: 'pageimages|coordinates|info',
    inprop: 'url',
    piprop: 'thumbnail',
    pithumbsize: '640',
    ...params,
  }
  for (const [k, v] of Object.entries(all)) url.searchParams.set(k, v)
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`Wikipedia ${res.status}`)
  const body = (await res.json()) as { query?: { pages?: WikiPage[] } }
  const page = body.query?.pages?.find((p) => !p.missing)
  if (!page) return {}
  return {
    photo: page.thumbnail?.source,
    pageUrl: page.fullurl,
    pageTitle: page.title,
    lat: page.coordinates?.[0]?.lat,
    lon: page.coordinates?.[0]?.lon,
  }
}

export function mediaQueryFor(stop: Pick<BoardStop, 'label' | 'place'>): string {
  return stop.place?.wiki ?? `${stop.label}${stop.place ? ` ${stop.place.country}` : ''}`
}

export function loadPlaceMedia(query: string, isTitle: boolean): Promise<PlaceMedia> {
  const cached = readCache(query)
  if (cached) return Promise.resolve(cached)
  const running = inflight.get(query)
  if (running) return running
  const task = (async () => {
    let media = isTitle ? await queryWikipedia({ titles: query }) : {}
    if (!media.pageUrl) {
      media = await queryWikipedia({
        generator: 'search',
        gsrsearch: query,
        gsrlimit: '1',
      })
    }
    writeCache(query, media)
    return media
  })().finally(() => inflight.delete(query))
  inflight.set(query, task)
  return task
}

/** Media for every distinct place on the board, keyed by stop key. */
export function usePlaceMedia(stops: BoardStop[]): Map<string, PlaceMedia> {
  const [media, setMedia] = useState<Map<string, PlaceMedia>>(() => new Map())
  const signature = stops.map((s) => `${s.key}=${mediaQueryFor(s)}`).join('|')

  useEffect(() => {
    let cancelled = false
    const distinct = new Map<string, BoardStop>()
    for (const s of stops) if (!distinct.has(s.key)) distinct.set(s.key, s)
    for (const [key, stop] of distinct) {
      const query = mediaQueryFor(stop)
      void loadPlaceMedia(query, Boolean(stop.place?.wiki))
        .then((m) => {
          if (cancelled) return
          setMedia((prev) => {
            const next = new Map(prev)
            next.set(key, m)
            return next
          })
        })
        .catch(() => {
          // Offline or blocked: the card keeps its illustration.
        })
    }
    return () => {
      cancelled = true
    }
    // stops change identity on every reload; the signature captures what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])

  return media
}
