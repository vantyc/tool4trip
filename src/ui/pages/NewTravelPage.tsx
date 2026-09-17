import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { services } from '../../application'
import {
  applyAgentProposal,
  newTravelAgent,
  previewAgentProposal,
  type AgentProposal,
} from '../../application/agentClient'
import type { ImportUpdatePlan } from '../../application/packageImport'
import {
  discardNewTravelProposal,
  prepareNewTravelPackage,
  summarizeNewTravelProposal,
  UNKNOWN,
} from '../../application/newTravelProposal'
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

  const summary = useMemo(
    () => (proposal ? summarizeNewTravelProposal(proposal) : null),
    [proposal],
  )

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
      const prepared = prepareNewTravelPackage(p)
      if (!prepared.ok) {
        throw new Error(prepared.errors.join('; '))
      }
      const preview = await previewAgentProposal(services, prepared.proposal)
      setProposal(prepared.proposal)
      setPlan(preview.plan)
      setJobStatus(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al planear')
      setJobStatus(null)
    } finally {
      setBusy(false)
    }
  }

  async function handleCreate() {
    if (!proposal) return
    setBusy(true)
    setError(null)
    try {
      const prepared = prepareNewTravelPackage(proposal)
      if (!prepared.ok) {
        throw new Error(prepared.errors.join('; '))
      }
      const { tripId: tid } = await applyAgentProposal(
        services,
        prepared.proposal,
      )
      navigate(`/trips/${tid}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al crear viaje')
    } finally {
      setBusy(false)
    }
  }

  function handleDiscard() {
    setProposal(discardNewTravelProposal())
    setPlan(null)
    setError(null)
  }

  return (
    <section className="page">
      <p>
        <Link to="/">← Tool4Trip</Link>
      </p>
      <h1>Nuevo viaje</h1>
      <p className="muted">
        Describe el viaje en lenguaje natural. El agente investiga y arma una
        propuesta estructurada (fechas, origen, destinos, transporte, hospedaje,
        itinerario, notas y pendientes). Los datos no confirmados quedan como{' '}
        {UNKNOWN} / pendiente de verificar — no se inventan precios ni
        reservaciones. Nada se guarda hasta que pulses <strong>Crear viaje</strong>.
      </p>

      {!online && (
        <p className="offline-note">
          Sin conexión — Nuevo viaje requiere red para el agente y la nube.
        </p>
      )}

      <label htmlFor="new-travel-prompt">
        ¿Qué viaje quieres?
        <textarea
          id="new-travel-prompt"
          rows={8}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={busy || !online}
          placeholder={
            'Ej. Arma un viaje de dos semanas a Filipinas entre noviembre y diciembre, saliendo desde Ciudad de México; busca fechas con menor calor, humedad y lluvia, además de vuelos y hospedajes.'
          }
        />
      </label>

      <div className="actions">
        <button
          type="button"
          onClick={() => void handlePlan()}
          disabled={busy || !online || !prompt.trim()}
        >
          {busy && !proposal ? 'Investigando…' : 'Generar propuesta'}
        </button>
      </div>

      {busy && jobStatus && (
        <p className="muted" aria-live="polite">
          {jobStatus === 'queued'
            ? 'En cola…'
            : jobStatus === 'running'
              ? 'Investigando y armando propuesta…'
              : `Estado: ${jobStatus}`}
        </p>
      )}

      {error && <p className="status-bad">{error}</p>}

      {proposal && summary && (
        <div className="agent-proposal">
          <h2>Propuesta (borrador)</h2>
          <p>{proposal.narrative}</p>
          {summary.warnings.length > 0 && (
            <ul>
              {summary.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}

          <dl className="new-travel-summary">
            <div>
              <dt>Título</dt>
              <dd>{summary.title}</dd>
            </div>
            <div>
              <dt>Estado</dt>
              <dd>
                {summary.draftLabel} → al crear: {summary.domainStatus} (sin
                reservas)
              </dd>
            </div>
            <div>
              <dt>Ventana</dt>
              <dd>
                {summary.startDate} → {summary.endDate} (
                {summary.durationDays > 0
                  ? `${summary.durationDays} día(s)`
                  : UNKNOWN}
                )
              </dd>
            </div>
            <div>
              <dt>Origen</dt>
              <dd>{summary.origin}</dd>
            </div>
            <div>
              <dt>Destinos</dt>
              <dd>{summary.destinations.join(' · ')}</dd>
            </div>
            <div>
              <dt>Transporte</dt>
              <dd>
                {summary.transport.length === 0
                  ? UNKNOWN
                  : summary.transport
                      .map(
                        (t) =>
                          `${t.title} [${t.type}/${t.verification}]`,
                      )
                      .join('; ')}
              </dd>
            </div>
            <div>
              <dt>Hospedaje</dt>
              <dd>
                {summary.lodging.length === 0
                  ? UNKNOWN
                  : summary.lodging
                      .map((l) => `${l.title} [${l.verification}]`)
                      .join('; ')}
              </dd>
            </div>
            <div>
              <dt>Itinerario</dt>
              <dd>
                {summary.itinerary.length === 0
                  ? UNKNOWN
                  : summary.itinerary
                      .map((i) => i.title)
                      .slice(0, 8)
                      .join('; ')}
                {summary.itinerary.length > 8
                  ? ` (+${summary.itinerary.length - 8})`
                  : ''}
              </dd>
            </div>
            <div>
              <dt>Notas</dt>
              <dd>
                {summary.notes.length === 0
                  ? UNKNOWN
                  : summary.notes.map((n) => n.body).join(' · ')}
              </dd>
            </div>
            <div>
              <dt>Pendientes</dt>
              <dd>
                {summary.pending.length === 0
                  ? UNKNOWN
                  : summary.pending.map((p) => p.label).join('; ')}
              </dd>
            </div>
            <div>
              <dt>Fuentes</dt>
              <dd>
                {summary.sources.length === 0
                  ? 'Sin URLs (esqueleto estimado / pendiente de verificar)'
                  : summary.sources.join(' · ')}
              </dd>
            </div>
          </dl>

          {plan && (
            <p className="muted">
              Vista previa import: nuevas {plan.created}, actualizadas{' '}
              {plan.updated}, sin cambios {plan.unchanged}
              {!plan.isUpdate ? ' · crea viaje nuevo' : ''}
            </p>
          )}

          <div className="actions">
            <button
              type="button"
              onClick={() => void handleCreate()}
              disabled={busy || !online}
            >
              Crear viaje
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
