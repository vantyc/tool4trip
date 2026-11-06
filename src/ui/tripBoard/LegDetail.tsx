import { useState } from 'react'
import { Link } from 'react-router-dom'
import { services } from '../../application'
import type { BoardLeg, TripBoard } from '../../application/tripBoard/buildTripBoard'
import {
  applyPlan,
  canSwapAlternative,
  chooseRoutePlan,
  swapAlternativePlan,
} from '../../application/tripBoard/boardEdits'
import {
  formatDayEs,
  formatDuration,
  formatWhenEs,
  minutesBetween,
} from '../../application/tripBoard/time'
import { AddLegOptionForm } from './BoardForms'
import { legGlyph, money, STATUS_LABEL } from './boardFormat'
import { Glyph } from './Glyph'
import { ItemBlock, type GetActionProps } from './ItemBlock'

export function LegDetail({
  leg,
  board,
  tripId,
  onChanged,
  onOpenStop,
  getActionProps,
}: {
  leg: BoardLeg
  board: TripBoard
  tripId: string
  onChanged: () => void
  onOpenStop: (id: string) => void
  getActionProps: GetActionProps
}) {
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const from = board.stops.find((s) => s.id === leg.fromStopId)!
  const to = board.stops.find((s) => s.id === leg.toStopId)!
  const chosenTotal = leg.segments.reduce(
    (sum, s) => (s.price !== undefined && !s.includedWith ? sum + s.price : sum),
    0,
  )

  async function run(plan: Parameters<typeof applyPlan>[1]) {
    setBusy(true)
    setError(null)
    try {
      await applyPlan(services.travelOptions, plan)
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo guardar')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="tb-detail">
      <p className="tb-leg-head">
        <span className={`tb-leg-icon tb-leg-${leg.status}`}>
          <Glyph name={legGlyph(leg.mode)} rotate={legGlyph(leg.mode) === 'plane' ? 90 : 0} size={22} />
        </span>
        <span>
          <button type="button" className="tb-linkish" onClick={() => onOpenStop(from.id)}>
            {leg.fromLabel}
          </button>{' '}
          →{' '}
          <button type="button" className="tb-linkish" onClick={() => onOpenStop(to.id)}>
            {leg.toLabel}
          </button>
          <br />
          <small>
            {leg.departAt
              ? `${formatWhenEs(leg.departAt)} → ${formatWhenEs(leg.arriveAt) ?? '¿?'} (horas locales)`
              : leg.dateHint
                ? `${formatDayEs(leg.dateHint)} · horario por definir`
                : 'Fecha por definir'}
            {leg.durationMinutes !== undefined && ` · ${formatDuration(leg.durationMinutes)}`}
          </small>
        </span>
        <span className={`tb-pill tb-pill-${leg.status}`}>{STATUS_LABEL[leg.status]}</span>
      </p>

      {leg.segments.length > 0 && (
        <section className="tb-sec">
          <h3>{leg.segments.length > 1 ? 'Tramos elegidos' : 'Elegido'}</h3>
          {leg.segments.map((s, i) => (
            <div key={s.id}>
              {i > 0 && (
                <p className="tb-connection">
                  Conexión: {formatDuration(minutesBetween(leg.segments[i - 1]!.endAt, s.startAt)) ?? '¿?'}
                </p>
              )}
              <ItemBlock item={s} onChanged={onChanged} getActionProps={getActionProps} />
            </div>
          ))}
        </section>
      )}

      {leg.segments.length === 0 && (
        <section className="tb-sec">
          <h3>Opciones para este tramo</h3>
          {leg.routes.length === 0 && (
            <p className="tb-pending-line">
              No hay opciones guardadas. Agrega una o pídelas en{' '}
              <Link to={`/ask?tripId=${encodeURIComponent(tripId)}`}>Ask Travel</Link>.
            </p>
          )}
          {leg.routes.map((r, idx) => (
            <div key={r.id} className="tb-route">
              <header className="tb-route-head">
                <strong>Opción {String.fromCharCode(65 + idx)}</strong>
                <span>
                  {r.items.length > 1 ? `${r.items.length} partes · ` : ''}
                  {money(r.price, r.currency) ?? 'sin cotizar'}
                </span>
                <button type="button" disabled={busy} onClick={() => void run(chooseRoutePlan(leg, r.id))}>
                  Elegir esta ruta
                </button>
              </header>
              {r.items.map((i) => (
                <ItemBlock key={i.id} item={i} onChanged={onChanged} getActionProps={getActionProps} />
              ))}
            </div>
          ))}
        </section>
      )}

      {leg.alternatives.length > 0 && (
        <details className="tb-more">
          <summary>Alternativas guardadas ({leg.alternatives.length})</summary>
          {leg.alternatives.map((a) => {
            const swap = canSwapAlternative(leg, a)
            const diff =
              a.price !== undefined && chosenTotal > 0 ? a.price - chosenTotal : undefined
            return (
              <ItemBlock
                key={a.id}
                item={a}
                onChanged={onChanged}
                getActionProps={getActionProps}
                extraActions={
                  <>
                    {diff !== undefined && (
                      <span className="tb-diff">
                        {diff >= 0 ? '+' : '−'}
                        {money(Math.abs(diff), a.currency)} vs. elegido
                      </span>
                    )}
                    {swap ? (
                      <button type="button" disabled={busy} onClick={() => void run(swapAlternativePlan(leg, a.id))}>
                        Usar en lugar del elegido
                      </button>
                    ) : (
                      <span className="tb-hint">
                        Cambia varios tramos (ida y regreso); para usarla, pide «Ajustar» en el vuelo elegido.
                      </span>
                    )}
                  </>
                }
              />
            )
          })}
        </details>
      )}

      {leg.extras.length > 0 && (
        <section className="tb-sec">
          <h3>Pendientes de este tramo</h3>
          {leg.extras.map((x) => (
            <ItemBlock key={x.id} item={x} onChanged={onChanged} getActionProps={getActionProps} />
          ))}
        </section>
      )}

      {error && <p className="status-bad">{error}</p>}

      <section className="tb-sec">
        {adding ? (
          <AddLegOptionForm
            tripId={tripId}
            from={from.place?.code ?? from.label}
            to={to.place?.code ?? to.label}
            date={leg.dateHint ?? leg.departAt?.slice(0, 10)}
            onCancel={() => setAdding(false)}
            onDone={() => {
              setAdding(false)
              onChanged()
            }}
          />
        ) : (
          <button type="button" className="tb-btn-quiet" onClick={() => setAdding(true)}>
            Agregar opción para este tramo
          </button>
        )}
      </section>
    </div>
  )
}
