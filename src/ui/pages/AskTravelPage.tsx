import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { services } from '../../application'
import {
  applyAgentProposal,
  askTravelAgent,
  previewAgentProposal,
  type AgentProposal,
} from '../../application/agentClient'
import type { ImportUpdatePlan } from '../../application/packageImport'
import type { Trip } from '../../domain/types'
import { useOnline } from '../useOnline'

export function AskTravelPage() {
  const online = useOnline()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const initialTripId = searchParams.get('tripId') ?? ''

  const [trips, setTrips] = useState<Trip[]>([])
  const [tripId, setTripId] = useState(initialTripId)
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [proposal, setProposal] = useState<AgentProposal | null>(null)
  const [plan, setPlan] = useState<ImportUpdatePlan | null>(null)

  useEffect(() => {
    void services.trips.list().then((list) => {
      const sorted = list.sort((a, b) =>
        a.startDate.localeCompare(b.startDate),
      )
      setTrips(sorted)
      if (!tripId && sorted[0]) setTripId(sorted[0].id)
    })
  }, [tripId])

  async function handleAsk() {
    if (!tripId || !prompt.trim()) return
    setBusy(true)
    setError(null)
    setProposal(null)
    setPlan(null)
    try {
      const p = await askTravelAgent(services, {
        tripId,
        prompt: prompt.trim(),
      })
      const preview = await previewAgentProposal(services, p)
      setProposal(p)
      setPlan(preview.plan)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al consultar')
    } finally {
      setBusy(false)
    }
  }

  async function handleApply() {
    if (!proposal) return
    setBusy(true)
    setError(null)
    try {
      const { tripId: tid } = await applyAgentProposal(services, proposal)
      navigate(`/trips/${tid}/options`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al aplicar')
    } finally {
      setBusy(false)
    }
  }

  function handleDiscard() {
    setProposal(null)
    setPlan(null)
    setError(null)
  }

  return (
    <section className="page">
      <p>
        <Link to="/">← Tool4Trip</Link>
      </p>
      <h1>Ask Travel</h1>
      <p className="muted">
        Describe un cambio o pregunta sobre tu viaje. Verás una propuesta antes
        de aplicar nada. Sin investigación externa en esta fase el agente solo
        usa datos ya guardados (salvo tools webSearch/fetchUrl cuando estén
        disponibles).
      </p>

      {!online && (
        <p className="offline-note">
          Sin conexión — Ask Travel requiere red para el agente.
        </p>
      )}

      <label htmlFor="trip">
        Viaje
        <select
          id="trip"
          value={tripId}
          onChange={(e) => setTripId(e.target.value)}
          disabled={busy || trips.length === 0}
        >
          {trips.length === 0 && <option value="">Sin viajes</option>}
          {trips.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
            </option>
          ))}
        </select>
      </label>

      <label htmlFor="prompt">
        Prompt
        <textarea
          id="prompt"
          rows={5}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={busy || !online}
          placeholder="Ej. Cambia el vuelo de regreso al jueves 1 de octubre."
        />
      </label>

      <div className="actions">
        <button
          type="button"
          onClick={() => void handleAsk()}
          disabled={busy || !online || !tripId || !prompt.trim()}
        >
          {busy ? 'Consultando…' : 'Preguntar'}
        </button>
      </div>

      {error && <p className="status-bad">{error}</p>}

      {proposal && (
        <div className="agent-proposal">
          <h2>Propuesta</h2>
          <p>{proposal.narrative}</p>

          {proposal.warnings.length > 0 && (
            <ul className="muted">
              {proposal.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}

          {proposal.diffSummary.length > 0 && (
            <table className="diff-table">
              <thead>
                <tr>
                  <th>Qué</th>
                  <th>Antes</th>
                  <th>Después</th>
                </tr>
              </thead>
              <tbody>
                {proposal.diffSummary.map((d, i) => (
                  <tr key={`${d.entityKind}-${i}`}>
                    <td>
                      {d.entityRef ?? d.entityKind}
                      {d.note ? ` — ${d.note}` : ''}
                    </td>
                    <td>{d.before ?? '—'}</td>
                    <td>{d.after ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {plan && (
            <p className="muted">
              Vista previa import: nuevas {plan.created}, actualizadas{' '}
              {plan.updated}, sin cambios {plan.unchanged}, decisiones
              preservadas {plan.decisionsPreserved}
              {plan.isUpdate ? ` · revisión ${plan.revision}` : ''}
            </p>
          )}

          {proposal.toolTrace.length > 0 && (
            <details>
              <summary>Tool trace ({proposal.toolTrace.length})</summary>
              <ul>
                {proposal.toolTrace.map((t, i) => (
                  <li key={`${t.tool}-${i}`}>
                    {t.tool}: {t.ok ? 'ok' : t.error ?? 'fail'}
                    {t.sources?.[0]?.url ? ` — ${t.sources[0].url}` : ''}
                  </li>
                ))}
              </ul>
            </details>
          )}

          <div className="actions">
            <button
              type="button"
              onClick={() => void handleApply()}
              disabled={busy}
            >
              Aplicar cambios
            </button>
            <button type="button" onClick={handleDiscard} disabled={busy}>
              Descartar
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
