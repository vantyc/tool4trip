import { useLiveQuery } from 'dexie-react-hooks'
import { Link, useParams } from 'react-router-dom'
import { services } from '../../application'
import { documentActionLabel } from '../../application/documents'
import { formatClockHm } from '../../application/summary'
import type { DocumentMeta } from '../../domain/types'
import { formatLocalFromIso } from '../format'
import { useDocumentViewer } from '../documents/useDocumentViewer'

export function ItemDetailPage() {
  const { tripId, itemId } = useParams<{ tripId: string; itemId: string }>()
  const { open, Viewer } = useDocumentViewer()

  const resolved = useLiveQuery(async () => {
    if (!tripId || !itemId) return null
    const items = await services.itinerary.listResolvedByTrip(tripId)
    return items.find((r) => r.item.id === itemId) ?? null
  }, [tripId, itemId])

  const docs =
    useLiveQuery(async () => {
      if (!tripId || !itemId) return [] as DocumentMeta[]
      const [byItem, byBooking] = await Promise.all([
        services.documents.listByItineraryItem(itemId),
        resolved?.booking?.id
          ? services.documents.listByBooking(resolved.booking.id)
          : Promise.resolve([] as DocumentMeta[]),
      ])
      const map = new Map<string, DocumentMeta>()
      for (const d of [...byItem, ...byBooking]) map.set(d.id, d)
      return [...map.values()]
    }, [tripId, itemId, resolved?.booking?.id]) ?? []

  const reminders =
    useLiveQuery(async () => {
      if (!itemId || !tripId) return []
      return services.reminders.listResolvedByTrip(tripId).then((list) =>
        list.filter((r) => r.reminder.itineraryItemId === itemId),
      )
    }, [tripId, itemId]) ?? []

  if (resolved === undefined) {
    return <p className="muted">Cargando…</p>
  }
  if (!resolved || !tripId) {
    return (
      <section className="page">
        <p>Ítem no encontrado.</p>
        <Link to={tripId ? `/trips/${tripId}` : '/'}>Volver</Link>
      </section>
    )
  }

  const b = resolved.booking

  return (
    <section className="page">
      <Link to={`/trips/${tripId}`} className="back">
        ← Resumen
      </Link>
      <h2>{resolved.title}</h2>
      <p className="entity-meta">
        {formatLocalFromIso(resolved.startAt)}
        {resolved.endAt ? ` → ${formatLocalFromIso(resolved.endAt)}` : ''}
      </p>
      {resolved.place && <p className="entity-meta">{resolved.place}</p>}
      {resolved.item.bookingId && (
        <p className="entity-meta">
          Datos desde reserva ({resolved.item.bookingAnchor ?? 'start'}) — sin
          copia de horarios.
        </p>
      )}
      {resolved.item.notes && (
        <p className="note-block">{resolved.item.notes}</p>
      )}

      {b && (
        <div className="detail-booking">
          <h3>Reserva</h3>
          <p className="entity-meta">
            {b.type} · {b.status}
          </p>
          {b.confirmationNumber && (
            <p className="entity-meta">Loc: {b.confirmationNumber}</p>
          )}
          {b.phone && (
            <p>
              <a href={`tel:${b.phone}`}>{b.phone}</a>
            </p>
          )}
          {b.address && <p className="entity-meta">{b.address}</p>}
          {b.instructions && (
            <p className="note-block small">{b.instructions}</p>
          )}
        </div>
      )}

      {reminders.length > 0 && (
        <div>
          <h3>Recordatorios</h3>
          <ul className="entity-list">
            {reminders.map(({ reminder, triggerAt }) => (
              <li key={reminder.id}>
                <div className="entity-title">{reminder.label}</div>
                <div className="entity-meta">
                  {triggerAt
                    ? `${formatClockHm(triggerAt)} · ${formatLocalFromIso(triggerAt)}`
                    : '—'}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {docs.length > 0 && (
        <div>
          <h3>Documentos</h3>
          <div className="sum-actions doc-row-actions">
            {docs.map((doc) => (
              <button
                key={doc.id}
                type="button"
                className="sum-action"
                onClick={() => open(doc.id)}
              >
                {documentActionLabel(doc.type)}
              </button>
            ))}
          </div>
        </div>
      )}

      {Viewer}
    </section>
  )
}
