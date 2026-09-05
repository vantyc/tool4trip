import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { services } from '../../application'
import type { TravelOption, TravelOptionType } from '../../domain/types'
import {
  formatLocalFromIso,
  formatPriceObserved,
  formatTravelOptionStatus,
  formatTravelOptionType,
  formatVerificationStatus,
} from '../format'

const GROUPS: { key: string; types: TravelOptionType[]; title: string }[] = [
  { key: 'flights', types: ['flight'], title: 'Vuelos' },
  { key: 'lodging', types: ['lodging'], title: 'Hospedaje' },
  {
    key: 'transport',
    types: ['bus', 'train', 'transfer', 'car_rental'],
    title: 'Transporte',
  },
  {
    key: 'activities',
    types: ['activity', 'event', 'restaurant'],
    title: 'Actividades',
  },
  { key: 'other', types: ['other'], title: 'Otros' },
]

export function OptionsPage() {
  const { tripId } = useParams<{ tripId: string }>()
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const options =
    useLiveQuery(async () => {
      if (!tripId) return []
      return services.travelOptions.listByTrip(tripId)
    }, [tripId]) ?? []

  async function setStatus(
    id: string,
    status: TravelOption['status'],
  ) {
    setBusyId(id)
    setError(null)
    try {
      await services.travelOptions.setStatus(id, status)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error')
    } finally {
      setBusyId(null)
    }
  }

  async function convert(id: string) {
    const ok = window.confirm(
      '¿Convertir esta opción investigada en una reserva gestionada?\n\nNo se borrará la opción; quedará marcada como convertida y vinculada al Booking.',
    )
    if (!ok) return
    setBusyId(id)
    setError(null)
    try {
      await services.travelOptions.convertToBooking(id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al convertir')
    } finally {
      setBusyId(null)
    }
  }

  async function editNotes(opt: TravelOption) {
    const next = window.prompt('Notas de la opción', opt.notes ?? '')
    if (next === null) return
    setBusyId(opt.id)
    setError(null)
    try {
      await services.travelOptions.updateNotes(opt.id, next)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <section className="page">
      <h2>Opciones</h2>
      <p className="muted">
        Investigación — no son reservas confirmadas hasta convertirlas.
      </p>
      {error && <p className="status-bad">{error}</p>}

      {options.length === 0 ? (
        <p className="muted">
          Sin opciones. Importa un TripPackage desde la lista de viajes.
        </p>
      ) : (
        GROUPS.map((group) => {
          const items = options
            .filter((o) => group.types.includes(o.type))
            .sort((a, b) => a.title.localeCompare(b.title))
          if (items.length === 0) return null
          return (
            <div key={group.key} className="option-group">
              <h3>{group.title}</h3>
              <ul className="entity-list option-list">
                {items.map((opt) => (
                  <OptionRow
                    key={opt.id}
                    option={opt}
                    busy={busyId === opt.id}
                    onStatus={setStatus}
                    onConvert={() => void convert(opt.id)}
                    onNotes={() => void editNotes(opt)}
                  />
                ))}
              </ul>
            </div>
          )
        })
      )}
    </section>
  )
}

function OptionRow({
  option: o,
  busy,
  onStatus,
  onConvert,
  onNotes,
}: {
  option: TravelOption
  busy: boolean
  onStatus: (id: string, status: TravelOption['status']) => void
  onConvert: () => void
  onNotes: () => void
}) {
  return (
    <li className={`option-row status-${o.status}`}>
      <div className="entity-title">{o.title}</div>
      <div className="entity-meta">
        {formatTravelOptionType(o.type)}
        {o.provider ? ` · ${o.provider}` : ''}
        {' · '}
        <span className={`opt-badge opt-${o.status}`}>
          {formatTravelOptionStatus(o.status)}
        </span>
      </div>
      <div className="entity-meta">
        {formatLocalFromIso(o.startAt)}
        {o.endAt ? ` → ${formatLocalFromIso(o.endAt)}` : ''}
      </div>
      {(o.origin || o.destination) && (
        <div className="entity-meta">
          {o.origin ?? '—'} → {o.destination ?? '—'}
        </div>
      )}
      <div className="entity-meta">
        Precio obs.: {formatPriceObserved(o.priceObserved, o.currency)}
        {' · '}
        {formatVerificationStatus(o.verificationStatus)}
        {o.checkedAt ? ` · consultado ${formatLocalFromIso(o.checkedAt)}` : ''}
      </div>
      {o.sourceUrl && (
        <div className="entity-meta">
          <a href={o.sourceUrl} target="_blank" rel="noreferrer">
            Abrir fuente
          </a>
          {o.sourceType ? ` · ${o.sourceType}` : ''}
        </div>
      )}
      {o.notes && <p className="note-block small">{o.notes}</p>}
      {o.bookingId && (
        <p className="status-ok small">
          Convertida a reserva gestionada ({o.bookingId.slice(0, 8)}…)
        </p>
      )}
      <div className="sum-actions doc-row-actions">
        {o.status !== 'shortlisted' && o.status !== 'booked' && (
          <button
            type="button"
            className="sum-action"
            disabled={busy}
            onClick={() => onStatus(o.id, 'shortlisted')}
          >
            Shortlist
          </button>
        )}
        {o.status !== 'selected' && o.status !== 'booked' && (
          <button
            type="button"
            className="sum-action"
            disabled={busy}
            onClick={() => onStatus(o.id, 'selected')}
          >
            Seleccionar
          </button>
        )}
        {o.status !== 'rejected' && o.status !== 'booked' && (
          <button
            type="button"
            className="sum-action"
            disabled={busy}
            onClick={() => onStatus(o.id, 'rejected')}
          >
            Rechazar
          </button>
        )}
        {o.status !== 'booked' && (
          <button
            type="button"
            className="sum-action"
            disabled={busy}
            onClick={onConvert}
          >
            Convertir a reserva
          </button>
        )}
        <button
          type="button"
          className="sum-action"
          disabled={busy}
          onClick={onNotes}
        >
          Notas
        </button>
      </div>
    </li>
  )
}
