import { useState, type FormEvent } from 'react'
import { services } from '../../application'
import {
  stopTitle,
  type BoardStop,
  type NightSplit,
  type TripBoard,
} from '../../application/tripBoard/buildTripBoard'
import {
  applyPlan,
  splitNightsPlan,
  stayDatesPlan,
  stayHasBooking,
} from '../../application/tripBoard/boardEdits'
import { addDays, daysBetween, formatDayEs, localDate } from '../../application/tripBoard/time'

function nightsText(n: number): string {
  return `${n} ${n === 1 ? 'noche' : 'noches'}`
}

function SplitControl({
  split,
  board,
  onChanged,
}: {
  split: NightSplit
  board: TripBoard
  onChanged: () => void
}) {
  const a = board.stops.find((s) => s.id === split.firstStopId)!
  const b = board.stops.find((s) => s.id === split.secondStopId)!
  const [value, setValue] = useState(split.firstNights !== undefined ? String(split.firstNights) : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const locked = stayHasBooking(a) || stayHasBooking(b)
  const n = Number(value)
  const changed = value !== '' && n !== split.firstNights

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!changed) return
    setBusy(true)
    setError(null)
    try {
      await applyPlan(services.travelOptions, splitNightsPlan(board, split, n))
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo guardar')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="tb-split" onSubmit={(e) => void save(e)}>
      <p className="tb-split-head">
        <strong>
          {stopTitle(a)} y {stopTitle(b)}
        </strong>{' '}
        comparten {nightsText(split.total)} ({formatDayEs(split.from)} → {formatDayEs(split.to)}).
        {split.firstNights === undefined && <span className="tb-pending-line"> Reparto por definir.</span>}
      </p>
      {locked ? (
        <p className="tb-form-note">Hay un hotel reservado; cambia esas fechas con el hotel y luego aquí.</p>
      ) : (
        <div className="tb-split-row" data-write>
          <label>
            Noches en {stopTitle(a)}
            <select value={value} onChange={(e) => setValue(e.target.value)}>
              {split.firstNights === undefined && <option value="">Elegir…</option>}
              {Array.from({ length: split.total - 1 }, (_, i) => i + 1).map((k) => (
                <option key={k} value={k}>
                  {k} en {a.label} · {split.total - k} en {b.label} — cambio el {formatDayEs(addDays(split.from, k))}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" disabled={!changed || busy}>
            {busy ? 'Guardando…' : 'Guardar reparto'}
          </button>
        </div>
      )}
      {error && <p className="status-bad">{error}</p>}
    </form>
  )
}

function DatesForm({
  stop,
  fallbackOffset,
  onDone,
  onCancel,
}: {
  stop: BoardStop
  fallbackOffset: (date: string) => string | undefined
  onDone: () => void
  onCancel: () => void
}) {
  const [checkIn, setCheckIn] = useState(localDate(stop.checkIn) ?? stop.window?.from ?? '')
  const [checkOut, setCheckOut] = useState(localDate(stop.checkOut) ?? stop.window?.to ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nights = daysBetween(checkIn, checkOut)

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!checkIn || !checkOut || !(nights! > 0)) {
      return setError('La salida debe ser al menos un día después de la llegada.')
    }
    setBusy(true)
    setError(null)
    try {
      await applyPlan(
        services.travelOptions,
        stayDatesPlan(stop, checkIn, checkOut, fallbackOffset(checkIn)),
      )
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo guardar')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="tb-form" onSubmit={(e) => void save(e)}>
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
      <p className="tb-form-note">
        {nights !== undefined && nights > 0 ? `${nightsText(nights)}. ` : ''}
        Se mueven todos los hoteles de esta estancia; las horas de entrada y salida se conservan.
      </p>
      {error && <p className="status-bad">{error}</p>}
      <div className="tb-form-actions">
        <button type="submit" disabled={busy}>
          {busy ? 'Guardando…' : 'Guardar fechas'}
        </button>
        <button type="button" className="tb-btn-quiet" onClick={onCancel} disabled={busy}>
          Cancelar
        </button>
      </div>
    </form>
  )
}

export function StayDates({
  stop,
  board,
  onChanged,
  fallbackOffset,
}: {
  stop: BoardStop
  board: TripBoard
  onChanged: () => void
  fallbackOffset: (date: string) => string | undefined
}) {
  const [editing, setEditing] = useState(false)
  const splits = board.splits.filter(
    (s) => s.firstStopId === stop.id || s.secondStopId === stop.id,
  )
  const arrival = board.legs.find((l) => l.id === stop.arrivalLegId)
  const departure = board.legs.find((l) => l.id === stop.departureLegId)
  const from = localDate(stop.checkIn) ?? localDate(stop.arriveAt) ?? arrival?.dateHint
  const to = localDate(stop.checkOut) ?? localDate(stop.departAt) ?? departure?.dateHint
  const canEdit = stop.lodging.some((l) => l.option) && !stayHasBooking(stop)

  return (
    <>
      {stop.datesPending ? (
        <p>
          {stop.window && !stop.checkIn ? (
            <>
              Fechas por definir, entre el {formatDayEs(stop.window.from)} y el {formatDayEs(stop.window.to)}
            </>
          ) : (
            <>
              {from ? formatDayEs(from) : 'Llegada por definir'} → {to ? formatDayEs(to) : 'salida por definir'}
            </>
          )}
          <span className="tb-pending-line"> · noches por definir</span>
        </p>
      ) : (
        <p>
          {from ? formatDayEs(from) : '¿?'} → {to ? formatDayEs(to) : '¿?'}
          {stop.nights !== undefined && (
            <>
              {' '}
              · <strong>{nightsText(stop.nights)}</strong>
            </>
          )}
        </p>
      )}
      {splits.map((s) => (
        <SplitControl key={`${s.id}-${s.firstNights ?? 'x'}`} split={s} board={board} onChanged={onChanged} />
      ))}
      {canEdit &&
        (editing ? (
          <DatesForm
            stop={stop}
            fallbackOffset={fallbackOffset}
            onCancel={() => setEditing(false)}
            onDone={() => {
              setEditing(false)
              onChanged()
            }}
          />
        ) : (
          <button type="button" className="tb-btn-quiet" data-write onClick={() => setEditing(true)}>
            Cambiar fechas de la estancia
          </button>
        ))}
    </>
  )
}
