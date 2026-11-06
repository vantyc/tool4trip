import { useState, type FormEvent } from 'react'
import { services } from '../../application'
import type { BoardItem } from '../../application/tripBoard/buildTripBoard'
import {
  markOptionBooked,
  newLegOption,
  newStayOption,
  saveOptionEdit,
  type OptionPatch,
} from '../../application/tripBoard/boardEdits'
import { resolvePlace } from '../../application/tripBoard/places'
import {
  daysBetween,
  formatDayEs,
  instantMs,
  isoOffset,
  isoToWall,
  wallToIso,
} from '../../application/tripBoard/time'
import type { TravelOptionType } from '../../domain/types'

function parseAmount(raw: string): number | undefined | null {
  const t = raw.replace(/[\s,$]/g, '')
  if (!t) return undefined
  const n = Number(t)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'No se pudo guardar'
}

type RoleChoice = 'chosen' | 'pending' | 'alternative'

function FormActions({ busy, onCancel, label = 'Guardar' }: { busy: boolean; onCancel: () => void; label?: string }) {
  return (
    <div className="tb-form-actions">
      <button type="submit" disabled={busy}>
        {busy ? 'Guardando…' : label}
      </button>
      <button type="button" className="tb-btn-quiet" onClick={onCancel} disabled={busy}>
        Cancelar
      </button>
    </div>
  )
}

export function ItemEditForm({
  item,
  onDone,
  onCancel,
}: {
  item: BoardItem
  onDone: () => void
  onCancel: () => void
}) {
  const o = item.option
  const b = item.booking
  const isLodging = item.kind === 'lodging'
  const isTransport = item.kind === 'flight' || item.kind === 'ground'
  const [f, setF] = useState({
    title: o?.title ?? item.title,
    provider: o?.provider ?? '',
    origin: o?.origin ?? '',
    destination: o?.destination ?? '',
    address: o?.address ?? '',
    phone: o?.phone ?? '',
    start: isoToWall(o?.startAt),
    end: isoToWall(o?.endAt),
    price: o?.priceObserved !== undefined ? String(o.priceObserved) : '',
    currency: o?.currency ?? 'MXN',
    paid: o?.amountPaid !== undefined ? String(o.amountPaid) : '',
    url: o?.sourceUrl ?? '',
    nextAction: o?.nextAction ?? '',
    notes: o?.notes ?? '',
    role: item.role as RoleChoice,
    confirmation: b?.confirmationNumber ?? '',
    seat: b?.seat ?? '',
    terminal: b?.terminal ?? '',
    gate: b?.gate ?? '',
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF((prev) => ({ ...prev, [k]: e.target.value }))

  function toIso(wall: string, place: string, previous?: string, other?: string): string | undefined | null {
    if (!wall) return undefined
    const iso = wallToIso(wall, {
      tz: resolvePlace(place)?.tz,
      fallbackOffset: isoOffset(previous) ?? isoOffset(other),
    })
    return iso ?? null
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const patch: OptionPatch = {}
    if (o) {
      const text = (k: 'title' | 'provider' | 'origin' | 'destination' | 'address' | 'phone' | 'sourceUrl' | 'nextAction' | 'notes', value: string) => {
        const next = value.trim() || undefined
        if (next !== (o[k] ?? undefined)) (patch as Record<string, unknown>)[k] = next
      }
      if (!f.title.trim()) return setError('El título no puede quedar vacío.')
      text('title', f.title)
      text('provider', f.provider)
      if (isTransport) {
        text('origin', f.origin)
        text('destination', f.destination)
      }
      if (isLodging) {
        text('destination', f.destination)
        text('address', f.address)
        text('phone', f.phone)
      }
      text('sourceUrl', f.url)
      text('nextAction', f.nextAction)
      text('notes', f.notes)

      const startPlace = isLodging ? f.destination : f.origin
      const endPlace = f.destination
      if (f.start !== isoToWall(o.startAt)) {
        const iso = toIso(f.start, startPlace, o.startAt, o.endAt)
        if (iso === null) return setError(`No sé la zona horaria de «${startPlace || 'origen'}». Usa el código de aeropuerto (p. ej. MNL).`)
        patch.startAt = iso
      }
      if (f.end !== isoToWall(o.endAt)) {
        const iso = toIso(f.end, endPlace, o.endAt, o.startAt)
        if (iso === null) return setError(`No sé la zona horaria de «${endPlace || 'destino'}». Usa el código de aeropuerto (p. ej. MNL).`)
        patch.endAt = iso
      }
      const start = instantMs('startAt' in patch ? patch.startAt : o.startAt)
      const end = instantMs('endAt' in patch ? patch.endAt : o.endAt)
      if (start !== undefined && end !== undefined && end <= start) {
        return setError(isLodging ? 'El check-out debe ser después del check-in.' : 'La llegada debe ser después de la salida.')
      }

      const price = parseAmount(f.price)
      if (price === null) return setError('Precio inválido.')
      if (price !== o.priceObserved) patch.priceObserved = price
      if (price !== undefined && f.currency.trim().toUpperCase() !== (o.currency ?? '')) {
        patch.currency = f.currency.trim().toUpperCase() || 'MXN'
      }
      const paid = parseAmount(f.paid)
      if (paid === null) return setError('Monto pagado inválido.')
      if (paid !== o.amountPaid) patch.amountPaid = paid

      if (f.role !== item.role && item.status !== 'booked') {
        patch.budgetRole = f.role === 'chosen' ? 'primary' : f.role
        patch.status = f.role === 'chosen' ? 'selected' : f.role === 'alternative' ? 'shortlisted' : 'researched'
      }
    }

    setBusy(true)
    try {
      if (o && Object.keys(patch).length > 0) {
        await saveOptionEdit(services.travelOptions, o, patch)
      }
      if (b) {
        const next = {
          confirmationNumber: f.confirmation.trim() || undefined,
          seat: f.seat.trim() || undefined,
          terminal: f.terminal.trim() || undefined,
          gate: f.gate.trim() || undefined,
        }
        const changed = (Object.keys(next) as Array<keyof typeof next>).some(
          (k) => next[k] !== (b[k] ?? undefined),
        )
        if (changed) {
          const fresh = (await services.bookings.get(b.id)) ?? b
          await services.bookings.save({ ...fresh, ...next })
        }
      }
      onDone()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="tb-form" onSubmit={(e) => void submit(e)}>
      {o && (
        <>
          <label>
            Título
            <input value={f.title} onChange={set('title')} required />
          </label>
          <label>
            {item.kind === 'flight' ? 'Aerolínea' : isLodging ? 'Hotel' : 'Proveedor'}
            <input value={f.provider} onChange={set('provider')} />
          </label>
          {isTransport && (
            <div className="tb-form-row">
              <label>
                Origen
                <input value={f.origin} onChange={set('origin')} placeholder="MNL o Manila" />
              </label>
              <label>
                Destino
                <input value={f.destination} onChange={set('destination')} placeholder="ENI o El Nido" />
              </label>
            </div>
          )}
          {isLodging && (
            <>
              <label>
                Ciudad
                <input value={f.destination} onChange={set('destination')} />
              </label>
              <label>
                Dirección
                <input value={f.address} onChange={set('address')} />
              </label>
              <label>
                Teléfono
                <input value={f.phone} onChange={set('phone')} inputMode="tel" />
              </label>
            </>
          )}
          {(isTransport || isLodging) && (
            <div className="tb-form-row">
              <label>
                {isLodging ? 'Check-in' : 'Sale'} <small>(hora local)</small>
                <input type="datetime-local" value={f.start} onChange={set('start')} />
              </label>
              <label>
                {isLodging ? 'Check-out' : 'Llega'} <small>(hora local)</small>
                <input type="datetime-local" value={f.end} onChange={set('end')} />
              </label>
            </div>
          )}
          <div className="tb-form-row">
            <label>
              Precio
              <input value={f.price} onChange={set('price')} inputMode="decimal" placeholder="Sin cotizar" />
            </label>
            <label className="tb-form-narrow">
              Moneda
              <input value={f.currency} onChange={set('currency')} maxLength={3} />
            </label>
            <label>
              Pagado
              <input value={f.paid} onChange={set('paid')} inputMode="decimal" placeholder="0" />
            </label>
          </div>
          <label>
            Liga para reservar o ver tarifa
            <input value={f.url} onChange={set('url')} type="url" placeholder="https://…" />
          </label>
          {item.status !== 'booked' && (
            <label>
              Decisión
              <select value={f.role} onChange={set('role')}>
                <option value="chosen">Elegido (cuenta en el presupuesto)</option>
                <option value="pending">Por decidir</option>
                <option value="alternative">Alternativa</option>
              </select>
            </label>
          )}
          <label>
            Siguiente paso
            <input value={f.nextAction} onChange={set('nextAction')} />
          </label>
          <label>
            Notas
            <textarea value={f.notes} onChange={set('notes')} rows={3} />
          </label>
        </>
      )}
      {b && (
        <fieldset className="tb-fieldset">
          <legend>Reserva</legend>
          <div className="tb-form-row">
            <label>
              Confirmación
              <input value={f.confirmation} onChange={set('confirmation')} />
            </label>
            {item.kind === 'flight' && (
              <label>
                Asiento
                <input value={f.seat} onChange={set('seat')} />
              </label>
            )}
          </div>
          {item.kind === 'flight' && (
            <div className="tb-form-row">
              <label>
                Terminal
                <input value={f.terminal} onChange={set('terminal')} />
              </label>
              <label>
                Puerta
                <input value={f.gate} onChange={set('gate')} />
              </label>
            </div>
          )}
        </fieldset>
      )}
      {error && <p className="status-bad">{error}</p>}
      <FormActions busy={busy} onCancel={onCancel} />
    </form>
  )
}

export function BookForm({
  item,
  onDone,
  onCancel,
}: {
  item: BoardItem
  onDone: () => void
  onCancel: () => void
}) {
  const [confirmation, setConfirmation] = useState('')
  const [fullyPaid, setFullyPaid] = useState(true)
  const [paid, setPaid] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!item.option) return
    const amount = parseAmount(paid)
    if (!fullyPaid && amount === null) return setError('Monto pagado inválido.')
    setBusy(true)
    setError(null)
    try {
      await markOptionBooked(
        { travelOptions: services.travelOptions, bookings: services.bookings },
        item.option,
        { confirmation, fullyPaid, amountPaid: amount ?? undefined },
      )
      onDone()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="tb-form" onSubmit={(e) => void submit(e)}>
      <p className="tb-form-note">
        Registra en Tool4Trip una reserva que ya hiciste. No compra ni reserva nada.
      </p>
      <label>
        Número de confirmación
        <input value={confirmation} onChange={(e) => setConfirmation(e.target.value)} />
      </label>
      <label className="tb-check">
        <input type="checkbox" checked={fullyPaid} onChange={(e) => setFullyPaid(e.target.checked)} />
        Pagado completo{item.price !== undefined ? ` (${item.price} ${item.currency ?? ''})` : ''}
      </label>
      {!fullyPaid && (
        <label>
          Monto pagado hasta ahora
          <input value={paid} onChange={(e) => setPaid(e.target.value)} inputMode="decimal" placeholder="0" />
        </label>
      )}
      {error && <p className="status-bad">{error}</p>}
      <FormActions busy={busy} onCancel={onCancel} label="Marcar reservado" />
    </form>
  )
}

/** Where an undated stay goes: after `title`, somewhere between from and to. */
export type StaySlotChoice = { id: string; title: string; from: string; to: string }

export function AddStayForm({
  tripId,
  initial,
  fallbackOffset,
  places,
  after = [],
  onDone,
  onCancel,
}: {
  tripId: string
  initial?: { place?: string; checkIn?: string; checkOut?: string }
  fallbackOffset?: (date: string) => string | undefined
  places: string[]
  /** Stays an undated stay can follow. Empty hides the "no dates yet" choice. */
  after?: StaySlotChoice[]
  onDone: () => void
  onCancel: () => void
}) {
  const [undated, setUndated] = useState(false)
  const [afterId, setAfterId] = useState('')
  const [place, setPlace] = useState(initial?.place ?? '')
  const [checkIn, setCheckIn] = useState(initial?.checkIn ?? '')
  const [checkOut, setCheckOut] = useState(initial?.checkOut ?? '')
  const [hotel, setHotel] = useState('')
  const [address, setAddress] = useState('')
  const [price, setPrice] = useState('')
  const [currency, setCurrency] = useState('MXN')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nights = daysBetween(checkIn, checkOut)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!place.trim()) return setError('Escribe el lugar.')
    const slot = after.find((a) => a.id === afterId)
    if (undated && !slot) return setError('Elige después de qué estancia va.')
    if (!undated && (!checkIn || !checkOut || (nights ?? 0) <= 0)) {
      return setError('La salida debe ser al menos un día después de la llegada.')
    }
    const amount = parseAmount(price)
    if (amount === null) return setError('Precio inválido.')
    setBusy(true)
    setError(null)
    const common = {
      place,
      hotel,
      address,
      price: amount,
      currency: currency.trim().toUpperCase() || 'MXN',
    }
    try {
      await services.travelOptions.save(
        undated
          ? newStayOption(tripId, { ...common, window: { from: slot!.from, to: slot!.to } })
          : newStayOption(tripId, {
              ...common,
              checkIn,
              checkOut,
              fallbackOffset: resolvePlace(place) ? undefined : fallbackOffset?.(checkIn),
            }),
      )
      onDone()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="tb-form" onSubmit={(e) => void submit(e)}>
      <p className="tb-form-note">
        Se guarda como estancia pendiente. Los tramos para llegar y salir aparecen
        en el tablero como «por elegir».
      </p>
      <label>
        Lugar
        <input value={place} onChange={(e) => setPlace(e.target.value)} list="tb-places" required placeholder="Cebú" />
        <datalist id="tb-places">
          {places.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
      </label>
      {after.length > 0 && (
        <label className="tb-check">
          <input type="checkbox" checked={undated} onChange={(e) => setUndated(e.target.checked)} />
          Todavía no sé las fechas
        </label>
      )}
      {undated ? (
        <>
          <label>
            Va después de
            <select value={afterId} onChange={(e) => setAfterId(e.target.value)} required>
              <option value="">Elegir estancia…</option>
              {after.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.title} · entre {formatDayEs(a.from, false)} y {formatDayEs(a.to, false)}
                </option>
              ))}
            </select>
          </label>
          <p className="tb-form-note">
            Queda como estancia con fechas por definir. Después repartes las noches con la estancia anterior.
          </p>
        </>
      ) : (
        <>
          <div className="tb-form-row">
            <label>
              Llegada (check-in)
              <input type="date" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} required />
            </label>
            <label>
              Salida (check-out)
              <input type="date" value={checkOut} onChange={(e) => setCheckOut(e.target.value)} required />
            </label>
          </div>
          {nights !== undefined && nights > 0 && (
            <p className="tb-form-note">
              {nights} {nights === 1 ? 'noche' : 'noches'}
            </p>
          )}
        </>
      )}
      <label>
        Hotel <small>(opcional)</small>
        <input value={hotel} onChange={(e) => setHotel(e.target.value)} />
      </label>
      <label>
        Dirección <small>(opcional)</small>
        <input value={address} onChange={(e) => setAddress(e.target.value)} />
      </label>
      <div className="tb-form-row">
        <label>
          Precio total <small>(opcional)</small>
          <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" />
        </label>
        <label className="tb-form-narrow">
          Moneda
          <input value={currency} onChange={(e) => setCurrency(e.target.value)} maxLength={3} />
        </label>
      </div>
      {error && <p className="status-bad">{error}</p>}
      <FormActions busy={busy} onCancel={onCancel} label="Agregar estancia" />
    </form>
  )
}

const LEG_TYPES: Array<{ value: TravelOptionType; label: string }> = [
  { value: 'flight', label: 'Vuelo' },
  { value: 'transfer', label: 'Traslado / auto' },
  { value: 'bus', label: 'Autobús' },
  { value: 'train', label: 'Tren' },
  { value: 'other', label: 'Ferry u otro' },
]

export function AddLegOptionForm({
  tripId,
  from,
  to,
  date,
  onDone,
  onCancel,
}: {
  tripId: string
  from: string
  to: string
  date?: string
  onDone: () => void
  onCancel: () => void
}) {
  const [type, setType] = useState<TravelOptionType>('flight')
  const [origin, setOrigin] = useState(from)
  const [destination, setDestination] = useState(to)
  const [provider, setProvider] = useState('')
  const [title, setTitle] = useState('')
  const [price, setPrice] = useState('')
  const [currency, setCurrency] = useState('MXN')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const amount = parseAmount(price)
    if (amount === null) return setError('Precio inválido.')
    setBusy(true)
    setError(null)
    try {
      await services.travelOptions.save(
        newLegOption(tripId, {
          type,
          origin,
          destination,
          date,
          title,
          provider,
          price: amount,
          currency: currency.trim().toUpperCase() || 'MXN',
          sourceUrl: url,
        }),
      )
      onDone()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="tb-form" onSubmit={(e) => void submit(e)}>
      <label>
        Tipo
        <select value={type} onChange={(e) => setType(e.target.value as TravelOptionType)}>
          {LEG_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      <div className="tb-form-row">
        <label>
          Origen
          <input value={origin} onChange={(e) => setOrigin(e.target.value)} required />
        </label>
        <label>
          Destino
          <input value={destination} onChange={(e) => setDestination(e.target.value)} required />
        </label>
      </div>
      <label>
        Título <small>(opcional)</small>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Cebu Pacific 5J 123" />
      </label>
      <label>
        Proveedor
        <input value={provider} onChange={(e) => setProvider(e.target.value)} />
      </label>
      <div className="tb-form-row">
        <label>
          Precio <small>(opcional)</small>
          <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" />
        </label>
        <label className="tb-form-narrow">
          Moneda
          <input value={currency} onChange={(e) => setCurrency(e.target.value)} maxLength={3} />
        </label>
      </div>
      <label>
        Liga <small>(opcional)</small>
        <input value={url} onChange={(e) => setUrl(e.target.value)} type="url" placeholder="https://…" />
      </label>
      <p className="tb-form-note">Se guarda como opción por decidir; luego puedes elegirla y poner horarios.</p>
      {error && <p className="status-bad">{error}</p>}
      <FormActions busy={busy} onCancel={onCancel} label="Agregar opción" />
    </form>
  )
}
