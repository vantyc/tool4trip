import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { services } from '../../application'
import type { ResolvedItineraryItem } from '../../domain/types'
import type { Reminder } from '../../domain/types'
import {
  formatLocalFromIso,
  groupByDate,
  importanceLabel,
} from '../format'

export function ItineraryPage() {
  const { tripId } = useParams<{ tripId: string }>()
  const [resolved, setResolved] = useState<ResolvedItineraryItem[]>([])
  const [reminders, setReminders] = useState<
    { reminder: Reminder; triggerAt?: string }[]
  >([])

  useEffect(() => {
    if (!tripId) return
    void Promise.all([
      services.itinerary.listResolvedByTrip(tripId),
      services.reminders.listResolvedByTrip(tripId),
    ]).then(([items, rems]) => {
      setResolved(items)
      setReminders(rems)
    })
  }, [tripId])

  const groups = groupByDate(resolved)

  return (
    <section className="page">
      <h2>Itinerario</h2>
      <p className="muted">
        Orden cronológico en memoria. Ítems con reserva leen hora del Booking.
      </p>

      {groups.length === 0 ? (
        <p className="muted">Sin ítems.</p>
      ) : (
        groups.map((group) => (
          <div key={group.date} className="day-group">
            <h3>{group.date}</h3>
            <ul className="entity-list">
              {group.items.map((r) => (
                <li key={r.item.id}>
                  <div className="entity-title">
                    {importanceLabel(r.importance)} {r.title}
                  </div>
                  <div className="entity-meta">
                    {formatLocalFromIso(r.startAt)}
                    {r.endAt ? ` → ${formatLocalFromIso(r.endAt)}` : ''}
                  </div>
                  {r.place && <div className="entity-meta">{r.place}</div>}
                  {r.item.bookingId && (
                    <div className="entity-meta">
                      → Booking ({r.item.bookingAnchor ?? 'start'})
                    </div>
                  )}
                  {r.item.notes && (
                    <p className="note-block small">{r.item.notes}</p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))
      )}

      <h3>Recordatorios</h3>
      {reminders.length === 0 ? (
        <p className="muted">Sin recordatorios.</p>
      ) : (
        <ul className="entity-list">
          {reminders.map(({ reminder, triggerAt }) => (
            <li key={reminder.id}>
              <div className="entity-title">{reminder.label}</div>
              <div className="entity-meta">
                {reminder.kind === 'relative'
                  ? `relativo: ${reminder.offsetMinutes} min @ ${reminder.anchor}`
                  : 'absoluto'}
              </div>
              <div className="entity-meta">
                Dispara: {formatLocalFromIso(triggerAt)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
