import { useParams } from 'react-router-dom'
import { services } from '../../application'
import { documentActionLabel } from '../../application/documents'
import type { Booking, DocumentMeta } from '../../domain/types'
import { formatBookingStatus, formatLocalFromIso } from '../format'
import { useDocumentViewer } from '../documents/useDocumentViewer'
import { useCloudQuery } from '../useCloudQuery'
import { useLiveQuery } from 'dexie-react-hooks'

export function BookingsPage() {
  const { tripId } = useParams<{ tripId: string }>()
  const { open, Viewer } = useDocumentViewer()

  const { data: bookings = [], loading, error } = useCloudQuery(
    tripId ? `bookings:${tripId}` : null,
    async () => {
      const list = await services.bookings.listByTrip(tripId!)
      return list.sort((a, b) =>
        (a.startAt ?? '').localeCompare(b.startAt ?? ''),
      )
    },
  )

  // Documents remain Dexie-local in v1.
  const docsByBooking =
    useLiveQuery(async () => {
      if (!tripId) return new Map<string, DocumentMeta[]>()
      const docs = await services.documents.listByTrip(tripId)
      const map = new Map<string, DocumentMeta[]>()
      for (const doc of docs) {
        if (!doc.bookingId) continue
        const list = map.get(doc.bookingId) ?? []
        list.push(doc)
        map.set(doc.bookingId, list)
      }
      return map
    }, [tripId]) ?? new Map<string, DocumentMeta[]>()

  return (
    <section className="page">
      <h2>Reservas</h2>
      {error && <p className="status-bad">{error.message}</p>}
      {loading ? (
        <p className="muted">Cargando…</p>
      ) : bookings.length === 0 ? (
        <p className="muted">Sin reservas.</p>
      ) : (
        <ul className="entity-list">
          {bookings.map((b) => (
            <BookingRow
              key={b.id}
              booking={b}
              docs={docsByBooking.get(b.id) ?? []}
              onOpenDoc={open}
            />
          ))}
        </ul>
      )}
      {Viewer}
    </section>
  )
}

function BookingRow({
  booking: b,
  docs,
  onOpenDoc,
}: {
  booking: Booking
  docs: DocumentMeta[]
  onOpenDoc: (id: string) => void
}) {
  return (
    <li>
      <div className="entity-title">{b.title}</div>
      <div className="entity-meta">
        {b.type} · {formatBookingStatus(b.status)}
      </div>
      <div className="entity-meta">
        {formatLocalFromIso(b.startAt)}
        {b.endAt ? ` → ${formatLocalFromIso(b.endAt)}` : ''}
      </div>
      {(b.origin || b.destination) && (
        <div className="entity-meta">
          {b.origin ?? '—'} → {b.destination ?? '—'}
        </div>
      )}
      {b.confirmationNumber && (
        <div className="entity-meta">Loc: {b.confirmationNumber}</div>
      )}
      {b.notes && <p className="note-block small">{b.notes}</p>}
      {docs.length > 0 && (
        <div className="sum-actions doc-row-actions">
          {docs.map((doc) => (
            <button
              key={doc.id}
              type="button"
              className="sum-action"
              onClick={() => onOpenDoc(doc.id)}
            >
              {documentActionLabel(doc.type)}
            </button>
          ))}
        </div>
      )}
    </li>
  )
}
