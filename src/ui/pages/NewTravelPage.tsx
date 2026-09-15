import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { services } from '../../application'
import {
  applyAgentProposal,
  newTravelAgent,
  previewAgentProposal,
  type AgentProposal,
} from '../../application/agentClient'
import type { ImportUpdatePlan } from '../../application/packageImport'
import { useOnline } from '../useOnline'

export function NewTravelPage() {
  const online = useOnline()
  const navigate = useNavigate()

  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [jobStatus, setJobStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [proposal, setProposal] = useState<AgentProposal | null>(null)
  const [plan, setPlan] = useState<ImportUpdatePlan | null>(null)

  async function handlePlan() {
    if (!prompt.trim()) return
    setBusy(true)
    setError(null)
    setProposal(null)
    setPlan(null)
    setJobStatus('queued')
    try {
      const p = await newTravelAgent(
        services,
        { prompt: prompt.trim() },
        {
          onProgress: (prog) => setJobStatus(prog.status),
        },
      )
      const preview = await previewAgentProposal(services, p)
      setProposal(p)
      setPlan(preview.plan)
      setJobStatus(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al planear')
      setJobStatus(null)
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
      navigate(`/trips/${tid}/itinerary`)
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

  const flightCount =
    proposal?.package.travelOptions.filter((o) => o.type === 'flight').length ??
    0
  const lodgingCount =
    proposal?.package.travelOptions.filter((o) => o.type === 'lodging')
      .length ?? 0
  const arrivalCount =
    proposal?.package.itineraryItems.filter((i) =>
      i.externalId.startsWith('airport-arrival-'),
    ).length ?? 0

  return (
    <section className="page">
      <p>
        <Link to="/">← Tool4Trip</Link>
      </p>
      <h1>Nuevo viaje</h1>
      <p className="muted">
        Describe el viaje en una frase. Tool4Trip arma un paquete operativo
        (aeropuertos, vuelos y hospedaje estimados, eventos si hay fuentes, y
        recordatorios de arribo al aeropuerto). Nada se guarda hasta que
        pulses Aplicar.
      </p>

      {!online && (
        <p className="offline-note">
          Sin conexión — Nuevo viaje requiere red para el agente.
        </p>
      )}

      <label htmlFor="new-travel-prompt">
        ¿Qué viaje quieres?
        <textarea
          id="new-travel-prompt"
          rows={6}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={busy || !online}
          placeholder={
            'Ej. Quiero un viaje de CDMX a Guadalajara para el 15 de septiembre para pasar el grito, con estancia en San Miguel el Alto desde el viernes 18 y regreso a CDMX el lunes 21.'
          }
        />
      </label>

      <div className="actions">
        <button
          type="button"
          onClick={() => void handlePlan()}
          disabled={busy || !online || !prompt.trim()}
        >
          {busy ? 'Armando itinerario…' : 'Armar itinerario'}
        </button>
      </div>

      {busy && jobStatus && (
        <p className="muted" aria-live="polite">
          {jobStatus === 'queued'
            ? 'En cola…'
            : jobStatus === 'running'
              ? 'Planificando… (puedes dejar esta pestaña abierta)'
              : `Estado: ${jobStatus}`}
        </p>
      )}

      {error && <p className="status-bad">{error}</p>}

      {proposal && (
        <div className="agent-proposal">
          <h2>Propuesta</h2>
          <p>{proposal.narrative}</p>
          {proposal.warnings.length > 0 && (
            <ul>
              {proposal.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          <p className="muted">
            Viaje: <strong>{proposal.package.trip.title}</strong> (
            {proposal.package.trip.startDate} → {proposal.package.trip.endDate}
            )
          </p>
          <p className="muted">
            Esqueleto: {flightCount} vuelo(s), {lodgingCount} hospedaje(s),{' '}
            {arrivalCount} recordatorio(s) de arribo al aeropuerto. Los vuelos
            y hoteles son estimados — confirma horarios y precios antes de
            reservar.
          </p>
          {plan && (
            <p className="muted">
              Import: +{plan.created} / ~{plan.updated} / ={plan.unchanged}
              {!plan.isUpdate ? ' (crea viaje nuevo)' : ''}
            </p>
          )}
          <div className="actions">
            <button
              type="button"
              onClick={() => void handleApply()}
              disabled={busy}
            >
              Aplicar
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
