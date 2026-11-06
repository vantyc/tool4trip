import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { TripBoard } from '../../application/tripBoard/buildTripBoard'
import type { PlaceMedia } from './placeMedia'
import { glyphHtml, legGlyph } from './boardFormat'

type Point = { lat: number; lon: number }

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

const STATUS_COLOR = { booked: '#2d6a4f', quoted: '#b08900', pending: '#9b2226' } as const

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
  const layerRef = useRef<L.LayerGroup | null>(null)
  const fittedFor = useRef('')
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
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>',
    }).addTo(map)
    layerRef.current = L.layerGroup().addTo(map)
    mapRef.current = map
    fittedFor.current = ''
    const ro = new ResizeObserver(() => map.invalidateSize())
    ro.observe(el.current)
    return () => {
      ro.disconnect()
      map.remove()
      mapRef.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    const layer = layerRef.current
    if (!map || !layer) return
    layer.clearLayers()
    const coords = coordsFor(board, media)
    const bounds: L.LatLngTuple[] = []

    for (const leg of board.legs) {
      const a = coords.get(leg.fromStopId)
      const b = coords.get(leg.toStopId)
      if (!a || !b) continue
      const { path, mid, angle } = arc(a, b)
      const color = STATUS_COLOR[leg.status]
      L.polyline(path, {
        color,
        weight: 2.5,
        opacity: 0.85,
        dashArray: leg.segments.length === 0 ? '6 6' : undefined,
      }).addTo(layer)
      const icon = L.divIcon({
        className: 'tb-map-leg',
        html: glyphHtml(legGlyph(leg.mode), angle, color),
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      })
      L.marker([mid.lat, mid.lon], {
        icon,
        title: `${leg.fromLabel} → ${leg.toLabel}`,
        keyboard: true,
      })
        .on('click', () => handlers.current.onSelectLeg(leg.id))
        .addTo(layer)
    }

    const byPlace = new Map<string, { p: Point; ids: string[]; nums: number[]; label: string; status: string }>()
    for (const s of board.stops) {
      const p = coords.get(s.id)
      if (!p) continue
      const k = `${p.lat.toFixed(3)},${p.lon.toFixed(3)}`
      const entry = byPlace.get(k) ?? { p, ids: [], nums: [], label: s.label, status: s.status }
      entry.ids.push(s.id)
      entry.nums.push(s.index + 1)
      byPlace.set(k, entry)
      bounds.push([p.lat, p.lon])
    }
    for (const entry of byPlace.values()) {
      const icon = L.divIcon({
        className: 'tb-map-stop',
        html: `<span class="tb-map-num">${entry.nums.join('·')}</span><span class="tb-map-label">${entry.label}</span>`,
        iconSize: undefined,
        iconAnchor: [12, 12],
      })
      L.marker([entry.p.lat, entry.p.lon], { icon, title: entry.label, keyboard: true })
        .on('click', () => handlers.current.onSelectStop(entry.ids[0]!))
        .addTo(layer)
    }

    const fitKey = bounds.map((b) => b.join(',')).join('|')
    if (fitKey === fittedFor.current) return
    fittedFor.current = fitKey
    if (bounds.length === 1) map.setView(bounds[0]!, 8)
    else if (bounds.length > 1) {
      map.fitBounds(bounds, { paddingTopLeft: [24, 24], paddingBottomRight: [90, 24] })
    }
    else map.setView([20, 0], 1)
  }, [board, media])

  return <div ref={el} className="tb-map" role="region" aria-label="Mapa de la ruta" />
}
