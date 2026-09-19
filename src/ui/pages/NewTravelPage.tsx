import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { services } from '../../application'
import {
  applyAgentProposal,
  newTravelAgent,
  previewAgentProposal,
  type AgentProposal,
} from '../../application/agentClient'
import { formatAgentCaughtError } from '../../application/agentErrors'
import type { ImportUpdatePlan } from '../../application/packageImport'
import {
  discardNewTravelProposal,
  prepareNewTravelPackage,
  UNKNOWN,
} from '../../application/newTravelProposal'
import { buildTripPanelFromProposal } from '../../application/tripPanel'
import { TripPanel } from '../tripPanel'
import { useOnline } from '../useOnline'

const CREATE_CONFIRM =
  'Esta propuesta contiene componentes pendientes o faltantes y no tiene fuentes verificables. Puedes guardarla como borrador para completarla después.\n\n¿Crear el viaje de todos modos?'

export function NewTravelPage() {
  const online = useOnline()
  const navigate = useNavigate()

  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [jobStatus, setJobStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [proposal, setProposal] = useState<AgentProposal | null>(null)
  const [plan, setPlan] = useState<ImportUpdatePlan | null>(null)

  const panel = useMemo(
    () => (proposal ? buildTripPanelFromProposal(proposal) : null),
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
      setError(formatAgentCaughtError(err))
      setJobStatus(null)
    } finally {
      setBusy(false)
    }
  }

  async function handleCreate() {
    if (!proposal || !panel) return
    if (panel.diagnostics.needsCreateConfirm) {
      const ok = window.confirm(CREATE_CONFIRM)
      if (!ok) return
    }
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
      setError(formatAgentCaughtError(err))
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
          {busy && !proposal
            ? 'Investigando…'
            : error
              ? 'Reintentar'
              : 'Generar propuesta'}
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

      {error && (
        <p className="status-bad" role="alert">
          {error}
        </p>
      )}

      {proposal && panel && (
        <div className="agent-proposal">
          <TripPanel
            model={panel}
            actions={
              <>
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
                <button
                  type="button"
                  onClick={() => void handlePlan()}
                  disabled={busy || !online || !prompt.trim()}
                >
                  Reintentar
                </button>
                {plan && (
                  <span className="muted small">
                    Vista previa: +{plan.created} · ~{plan.updated} · ={plan.unchanged}
                    {!plan.isUpdate ? ' · crea viaje nuevo' : ''}
                  </span>
                )}
              </>
            }
          />
        </div>
      )}
    </section>
  )
}
