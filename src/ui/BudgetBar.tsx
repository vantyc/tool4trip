import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { services } from '../application'
import { checkBudget, type BudgetCheck } from '../application/tripBoard/budgetCheck'
import { buildTripBoard } from '../application/tripBoard/buildTripBoard'
import type { Trip } from '../domain/types'
import { money } from './tripBoard/boardFormat'
import { useCloudQuery } from './useCloudQuery'
import { useReadOnly } from './useReadOnly'

/** Fired after the plan changes (an option chosen, priced or booked) so the budget refreshes. */
export const PLAN_CHANGED_EVENT = 'tool4trip:plan-changed'

const NUMBER = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 0 })

function amountText(n?: number): string {
  return n === undefined ? '' : NUMBER.format(n)
}

function parseAmount(text: string): number | undefined {
  const digits = text.replace(/[^\d]/g, '')
  return digits ? Number(digits) : undefined
}

function PlanDetails({ check }: { check: BudgetCheck }) {
  const cur = check.currency
  const other = check.quoted - check.quotedTransport - check.quotedLodging
  return (
    <details className="budget-details">
      <summary>Qué incluye y qué falta</summary>
      <h4>Cotizado y elegido</h4>
      <ul>
        <li>
          Vuelos y traslados <strong>{money(check.quotedTransport, cur)}</strong>
        </li>
        <li>
          Hospedaje <strong>{money(check.quotedLodging, cur)}</strong>
        </li>
        {other > 0 && (
          <li>
            Otros <strong>{money(other, cur)}</strong>
          </li>
        )}
      </ul>
      {check.projected.length > 0 && (
        <>
          <h4>Sumado con el candidato más barato (aún sin elegir)</h4>
          <ul>
            {check.projected.map((l) => (
              <li key={l.id}>
                {l.text} <strong>{money(l.amount, l.currency)}</strong>
              </li>
            ))}
          </ul>
        </>
      )}
      {check.unpriced.length > 0 && (
        <>
          <h4>Sin precio todavía: los gastos van a subir</h4>
          <ul>
            {check.unpriced.map((l) => (
              <li key={l.id}>{l.text}</li>
            ))}
          </ul>
        </>
      )}
      {check.otherCurrency.length > 0 && (
        <>
          <h4>En otra moneda, no sumado</h4>
          <ul>
            {check.otherCurrency.map((l) => (
              <li key={l.id}>
                {l.text} <strong>{money(l.amount, l.currency)}</strong>
              </li>
            ))}
          </ul>
        </>
      )}
    </details>
  )
}

export function BudgetBar({
  trip,
  refreshKey,
  onSaved,
}: {
  trip: Trip
  /** Changes when the user moves between trip pages, so the plan is read again. */
  refreshKey: string
  onSaved: (trip: Trip) => void
}) {
  const currency = trip.budget?.currency ?? 'MXN'
  const [capText, setCapText] = useState(() => amountText(trip.budget?.cap))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { data, loading, reload } = useCloudQuery(`budget:${trip.id}:${refreshKey}`, async () => {
    const [options, bookings, checklist] = await Promise.all([
      services.travelOptions.listByTrip(trip.id),
      services.bookings.listByTrip(trip.id),
      services.checklist.listByTrip(trip.id),
    ])
    return { options, bookings, checklist, at: new Date() }
  })

  useEffect(() => {
    window.addEventListener(PLAN_CHANGED_EVENT, reload)
    return () => window.removeEventListener(PLAN_CHANGED_EVENT, reload)
  }, [reload])

  const cap = parseAmount(capText)
  const check = useMemo(() => {
    if (!data) return undefined
    const board = buildTripBoard({ ...data, trip, now: data.at })
    return checkBudget(board, { cap, currency })
  }, [data, trip, cap, currency])

  const readOnly = useReadOnly()
  const savedCap = useRef(trip.budget?.cap)
  async function saveCap(): Promise<void> {
    const previous = savedCap.current
    if (readOnly || cap === previous) return
    savedCap.current = cap
    try {
      const fresh = (await services.trips.get(trip.id)) ?? trip
      const next = { ...fresh }
      if (cap) next.budget = { cap, currency }
      else delete next.budget
      onSaved(await services.trips.save(next))
    } catch (err) {
      savedCap.current = previous
      throw err
    }
  }

  async function recalc(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      await saveCap()
      setCapText(amountText(cap))
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo guardar el tope.')
    } finally {
      setSaving(false)
    }
  }

  const used = check && cap ? check.total / cap : undefined
  const tone = !check || used === undefined ? 'none' : check.over ? 'over' : used >= 0.9 ? 'near' : 'ok'
  const busy = saving || loading

  return (
    <section className="budget-bar" aria-label="Presupuesto del viaje">
      <form className="budget-form" onSubmit={(e) => void recalc(e)}>
        <label className="budget-field">
          <span>Presupuesto tope</span>
          <span className="budget-input">
            <input
              inputMode="numeric"
              autoComplete="off"
              placeholder="0"
              readOnly={readOnly}
              value={capText}
              onChange={(e) => setCapText(e.target.value)}
              onBlur={() => {
                setCapText(amountText(cap))
                void saveCap().catch((err: unknown) =>
                  setError(err instanceof Error ? err.message : 'No se pudo guardar el tope.'),
                )
              }}
            />
            <span>{currency}</span>
          </span>
        </label>
        <div className={`budget-field budget-plan budget-${tone}`}>
          <span>Gastos del plan</span>
          <output className="budget-input" aria-live="polite">
            <strong>{check ? money(check.total, currency) : '…'}</strong>
          </output>
          {check && (
            <span className="budget-field-note">
              {check.remaining === undefined
                ? 'vuelos y hospedaje'
                : check.over
                  ? `te pasas por ${money(-check.remaining, currency)}`
                  : `quedan ${money(check.remaining, currency)}`}
              {check.unpriced.length > 0 && ` · faltan ${check.unpriced.length} sin precio`}
            </span>
          )}
        </div>
        <div className="budget-field budget-field-action">
          <span aria-hidden="true">&nbsp;</span>
          <button type="submit" className="budget-recalc" disabled={busy}>
            {busy ? 'Recalculando…' : 'Recalcular'}
          </button>
          {data && (
            <span className="budget-field-note budget-when">
              revisado {data.at.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </div>
      </form>
      {error && <p className="status-bad budget-error">{error}</p>}
      {check && <PlanDetails check={check} />}
    </section>
  )
}
