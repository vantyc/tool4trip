import { useEffect, useState } from 'react'
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
import { useCloudQuery } from '../useCloudQuery'

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

  const { data: options = [], loading, error: loadError, reload } =
    useCloudQuery(tripId ? `options:${tripId}` : null, async () => {
      return services.travelOptions.listByTrip(tripId!)
    })

  async function setStatus(
    id: string,
    status: TravelOption['status'],
  ) {
    setBusyId(id)
    setError(null)
    try {
      await services.travelOptions.setStatus(id, status)
      reload()
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
      reload()
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
      reload()
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
      {(error || loadError) && (
        <p className="status-bad">{error ?? loadError?.message}</p>
      )}

      {loading ? (
        <p className="muted">Cargando…</p>
      ) : options.length === 0 ? (
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
                    onSaved={reload}
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
  onSaved,
}: {
  option: TravelOption
  busy: boolean
  onStatus: (id: string, status: TravelOption['status']) => void
  onConvert: () => void
  onNotes: () => void
  onSaved: () => void
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
        {o.budgetRole ? ` · ${budgetRoleLabel(o.budgetRole)}` : ''}
        {o.countsInBudget === false ? ' · no se suma' : ''}
        {o.amountPaid ? ` · pagado ${formatPriceObserved(o.amountPaid, o.currency)}` : ''}
      </div>
      {o.nextAction && (
        <p className="note-block small">Siguiente acción: {o.nextAction}</p>
      )}
      {o.priceHistory?.map((prior) => (
        <p key={`${prior.checkedAt}-${prior.amount}`} className="entity-meta">
          Precio anterior: {formatPriceObserved(prior.amount, prior.currency)}
          {' · '}
          {formatLocalFromIso(prior.checkedAt)}
          {prior.sourceUrl ? ' · misma fuente de esa consulta' : ''}
        </p>
      ))}
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
      <div className="sum-actions doc-row-actions" data-write>
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
      <QuoteEditor option={o} busy={busy} onSaved={onSaved} />
    </li>
  )
}

function budgetRoleLabel(role: NonNullable<TravelOption['budgetRole']>): string {
  if (role === 'primary') return 'entra al subtotal'
  if (role === 'alternative') return 'alternativa, fuera del subtotal'
  return 'pendiente, fuera del subtotal'
}

function QuoteEditor({
  option,
  busy,
  onSaved,
}: {
  option: TravelOption
  busy: boolean
  onSaved: () => void
}) {
  const [price, setPrice] = useState(
    option.priceObserved === undefined ? '' : String(option.priceObserved),
  )
  const [sourceUrl, setSourceUrl] = useState(option.sourceUrl ?? '')
  const [nextAction, setNextAction] = useState(option.nextAction ?? '')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setPrice(option.priceObserved === undefined ? '' : String(option.priceObserved))
    setSourceUrl(option.sourceUrl ?? '')
    setNextAction(option.nextAction ?? '')
  }, [option.updatedAt, option.priceObserved, option.sourceUrl, option.nextAction])

  async function save() {
    setError(null)
    const trimmed = price.trim()
    let priceObserved: number | null
    if (!trimmed) {
      priceObserved = null
    } else {
      const parsed = Number(trimmed.replace(',', '.'))
      if (!Number.isFinite(parsed) || parsed < 0) {
        setError('Precio inválido')
        return
      }
      priceObserved = parsed
    }
    setSaving(true)
    try {
      await services.travelOptions.updateQuote(option.id, {
        priceObserved,
        currency: option.currency ?? 'MXN',
        sourceUrl,
        nextAction,
      })
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al guardar')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      className="doc-form"
      data-write
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <label className="doc-field">
        Precio MXN
        <input
          aria-label={`Precio de ${option.title}`}
          inputMode="decimal"
          value={price}
          onChange={(event) => setPrice(event.target.value)}
        />
      </label>
      <label className="doc-field">
        Enlace
        <input
          aria-label={`Enlace de ${option.title}`}
          type="url"
          value={sourceUrl}
          onChange={(event) => setSourceUrl(event.target.value)}
        />
      </label>
      <label className="doc-field">
        Siguiente acción
        <input
          aria-label={`Siguiente acción de ${option.title}`}
          value={nextAction}
          onChange={(event) => setNextAction(event.target.value)}
        />
      </label>
      {error && <p className="status-bad">{error}</p>}
      <button type="submit" className="sum-action" disabled={busy || saving}>
        Guardar cotización
      </button>
    </form>
  )
}
