import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { TripBoard } from '../../application/tripBoard/buildTripBoard'
import type { PlaceMedia } from './placeMedia'
import { glyphHtml, legGlyph } from './boardFormat'

type Point = { lat: number; lon: number }

/** Stops closer than this on screen share one marker. */
const MERGE_PX = 26

function coordsFor(
  board: TripBoard,
  media: Map<string, PlaceMedia>,
): Map<string, Point> {
  const out = new Map<string, Point>()
  for (const s of board.stops) {
    const m = media.get(s.key)
    const p = s.place
      ? { lat: s.place.lat, lon: s.place.lon }
      : m?.lat !== undefined && m.lon !== undefined
        ? { lat: m.lat, lon: m.lon }
        : undefined
    if (p) out.set(s.id, p)
  }
  // Routes across the Pacific: shift the western hemisphere east of Asia.
  const lons = [...out.values()].map((p) => p.lon)
  if (lons.length && Math.max(...lons) - Math.min(...lons) > 180) {
    for (const [id, p] of out) if (p.lon < 0) out.set(id, { ...p, lon: p.lon + 360 })
  }
  return out
}

/** Quadratic arc bending to the left of travel, so out and back don't overlap. */
function arc(a: Point, b: Point, steps = 24): { path: L.LatLngTuple[]; mid: Point; angle: number } {
  const dx = b.lon - a.lon
  const dy = b.lat - a.lat
  const len = Math.hypot(dx, dy) || 1
  const bend = Math.min(0.18 * len, 12)
  const cx = (a.lon + b.lon) / 2 - (dy / len) * bend
  const cy = (a.lat + b.lat) / 2 + (dx / len) * bend
  const path: L.LatLngTuple[] = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const lon = (1 - t) ** 2 * a.lon + 2 * (1 - t) * t * cx + t ** 2 * b.lon
    const lat = (1 - t) ** 2 * a.lat + 2 * (1 - t) * t * cy + t ** 2 * b.lat
    path.push([lat, lon])
  }
  const mid = { lat: 0.25 * a.lat + 0.5 * cy + 0.25 * b.lat, lon: 0.25 * a.lon + 0.5 * cx + 0.25 * b.lon }
  // Screen angle (y grows downward) of the tangent at the midpoint.
  const angle = (Math.atan2(-(b.lat - a.lat), b.lon - a.lon) * 180) / Math.PI
  return { path, mid, angle }
}

const STATUS_COLOR = { booked: '#2d6a4f', quoted: '#8a6700', pending: '#9b2226' } as const

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

function overlaps(a: DOMRect, b: DOMRect, pad = 2): boolean {
  return !(a.right + pad < b.left || b.right + pad < a.left || a.bottom + pad < b.top || b.bottom + pad < a.top)
}

type Cluster = { p: Point; px: L.Point; ids: string[]; nums: number[]; labels: string[] }

export default function TripMap({
  board,
  media,
  onSelectStop,
  onSelectLeg,
}: {
  board: TripBoard
  media: Map<string, PlaceMedia>
  onSelectStop: (id: string) => void
  onSelectLeg: (id: string) => void
}) {
  const el = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const legLayer = useRef<L.LayerGroup | null>(null)
  const stopLayer = useRef<L.LayerGroup | null>(null)
  const drawStops = useRef<() => void>(() => {})
  const fittedFor = useRef('')
  const fitRoute = useRef<() => void>(() => {})
  const userMoved = useRef(false)
  const programmatic = useRef(false)
  const handlers = useRef({ onSelectStop, onSelectLeg })
  useEffect(() => {
    handlers.current = { onSelectStop, onSelectLeg }
  }, [onSelectStop, onSelectLeg])

  useEffect(() => {
    if (!el.current || mapRef.current) return
    const map = L.map(el.current, {
      zoomControl: true,
      attributionControl: true,
      worldCopyJump: false,
      scrollWheelZoom: false,
    }).setView([20, 0], 1)
    const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>',
    }).addTo(map)
    legLayer.current = L.layerGroup().addTo(map)
    stopLayer.current = L.layerGroup().addTo(map)
    mapRef.current = map
    fittedFor.current = ''
    userMoved.current = false
    const redraw = () => drawStops.current()
    const markUserMove = () => {
      if (!programmatic.current) userMoved.current = true
    }
    map.on('zoomend', redraw)
    map.on('movestart zoomstart', markUserMove)
    // The summary above can change height after the first fit; keep the whole route in view until the user pans or zooms.
    const ro = new ResizeObserver(() => {
      programmatic.current = true
      map.invalidateSize()
      programmatic.current = false
      if (!userMoved.current) fitRoute.current()
      redraw()
    })
    ro.observe(el.current)

    // Printing: the sheet is wider than the on-screen map and Leaflet does not re-render inside the
    // print layout, so the map takes its printed size on screen, refits, and waits for its tiles.
    const box = el.current
    let saved: { center: L.LatLng; zoom: number; moved: boolean } | null = null
    const enterPrint = () => {
      if (saved) return
      saved = { center: map.getCenter(), zoom: map.getZoom(), moved: userMoved.current }
      box.classList.add('tb-map-print')
      programmatic.current = true
      map.invalidateSize({ pan: false })
      programmatic.current = false
      fitRoute.current()
      redraw()
    }
    const leavePrint = () => {
      if (!saved) return
      const before = saved
      saved = null
      box.classList.remove('tb-map-print')
      programmatic.current = true
      map.invalidateSize({ pan: false })
      if (before.moved) map.setView(before.center, before.zoom, { animate: false })
      else fitRoute.current()
      programmatic.current = false
      userMoved.current = before.moved
      redraw()
    }
    const tilesLoaded = () =>
      new Promise<void>((resolve) => {
        if (!tiles.isLoading()) return resolve()
        const done = () => {
          window.clearTimeout(timer)
          tiles.off('load', done)
          resolve()
        }
        const timer = window.setTimeout(done, 6000)
        tiles.on('load', done)
      })
    const onPrintRequest = (e: Event) => {
      ;(e as CustomEvent<{ handled: boolean }>).detail.handled = true
      enterPrint()
      window.requestAnimationFrame(() => {
        void tilesLoaded().then(() => window.print())
      })
    }
    window.addEventListener('tb-print-request', onPrintRequest)
    window.addEventListener('beforeprint', enterPrint)
    window.addEventListener('afterprint', leavePrint)
    return () => {
      window.removeEventListener('tb-print-request', onPrintRequest)
      window.removeEventListener('beforeprint', enterPrint)
      window.removeEventListener('afterprint', leavePrint)
      ro.disconnect()
      map.off('zoomend', redraw)
      map.off('movestart zoomstart', markUserMove)
      map.remove()
      mapRef.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    const legs = legLayer.current
    const stopsLayer = stopLayer.current
    if (!map || !legs || !stopsLayer) return
    legs.clearLayers()
    const coords = coordsFor(board, media)
    const bounds: L.LatLngTuple[] = []
    const legMarkers: L.Marker[] = []

    for (const leg of board.legs) {
      const a = coords.get(leg.fromStopId)
      const b = coords.get(leg.toStopId)
      if (!a || !b) continue
      const { path, mid, angle } = arc(a, b)
      const color = STATUS_COLOR[leg.status]
      L.polyline(path, {
        color,
        weight: 3,
        opacity: 0.9,
        dashArray: leg.segments.length === 0 ? '6 6' : undefined,
      }).addTo(legs)
      const icon = L.divIcon({
        className: 'tb-map-leg',
        html: glyphHtml(legGlyph(leg.mode), angle, color),
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      })
      const marker = L.marker([mid.lat, mid.lon], {
        icon,
        title: `${leg.fromLabel} → ${leg.toLabel}`,
        keyboard: true,
      })
        .on('click', () => handlers.current.onSelectLeg(leg.id))
        .addTo(legs)
      legMarkers.push(marker)
    }
    for (const p of coords.values()) bounds.push([p.lat, p.lon])

    drawStops.current = () => {
      stopsLayer.clearLayers()
      const clusters: Cluster[] = []
      for (const s of board.stops) {
        const p = coords.get(s.id)
        if (!p) continue
        const px = map.latLngToLayerPoint([p.lat, p.lon])
        const near = clusters.find((c) => c.px.distanceTo(px) < MERGE_PX)
        if (near) {
          near.ids.push(s.id)
          near.nums.push(s.index + 1)
          if (!near.labels.includes(s.label)) near.labels.push(s.label)
        } else {
          clusters.push({ p, px, ids: [s.id], nums: [s.index + 1], labels: [s.label] })
        }
      }
      const labelEls: HTMLElement[] = []
      const numEls: HTMLElement[] = []
      for (const c of clusters) {
        const icon = L.divIcon({
          className: 'tb-map-stop',
          html: `<span class="tb-map-num">${c.nums.join('·')}</span><span class="tb-map-label">${escapeHtml(c.labels.join(' · '))}</span>`,
          iconSize: undefined,
          iconAnchor: [12, 12],
        })
        const marker = L.marker([c.p.lat, c.p.lon], {
          icon,
          title: c.labels.join(', '),
          keyboard: true,
        })
          .on('click', () => {
            if (c.labels.length > 1) {
              const pts = c.ids.map((id) => coords.get(id)!).map((q) => [q.lat, q.lon] as L.LatLngTuple)
              userMoved.current = true
              map.fitBounds(pts, { padding: [40, 40], maxZoom: 9 })
            } else {
              handlers.current.onSelectStop(c.ids[0]!)
            }
          })
          .addTo(stopsLayer)
        const node = marker.getElement()
        const label = node?.querySelector<HTMLElement>('.tb-map-label')
        const num = node?.querySelector<HTMLElement>('.tb-map-num')
        if (label) labelEls.push(label)
        if (num) numEls.push(num)
      }
      // Leg icons that would cover a stop number (or another leg icon) wait for a closer zoom.
      const taken = numEls.map((n) => n.getBoundingClientRect())
      for (const m of legMarkers) {
        const node = m.getElement()
        if (!node) continue
        node.classList.remove('tb-map-leg-hidden')
        const r = node.getBoundingClientRect()
        const hide = taken.some((t) => overlaps(r, t))
        node.classList.toggle('tb-map-leg-hidden', hide)
        if (!hide) taken.push(r)
      }
      // Labels go last: hidden when they would overlap anything already shown.
      const box = el.current?.getBoundingClientRect()
      for (const label of labelEls) {
        label.classList.remove('tb-map-label-hidden')
        const r = label.getBoundingClientRect()
        const outside = box ? r.right > box.right - 2 || r.left < box.left : false
        const hide = outside || taken.some((t) => overlaps(r, t))
        label.classList.toggle('tb-map-label-hidden', hide)
        if (!hide) taken.push(r)
      }
    }

    fitRoute.current = () => {
      programmatic.current = true
      if (bounds.length === 1) map.setView(bounds[0]!, 8, { animate: false })
      else if (bounds.length > 1)
        map.fitBounds(bounds, { paddingTopLeft: [24, 24], paddingBottomRight: [90, 24], animate: false })
      else map.setView([20, 0], 1, { animate: false })
      programmatic.current = false
    }
    const fitKey = bounds.map((b) => b.join(',')).join('|')
    if (fitKey !== fittedFor.current) {
      fittedFor.current = fitKey
      userMoved.current = false
      fitRoute.current()
    }
    drawStops.current()
  }, [board, media])

  return <div ref={el} className="tb-map" role="region" aria-label="Mapa de la ruta" />
}
