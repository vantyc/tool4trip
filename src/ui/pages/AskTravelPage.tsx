import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { services } from '../../application'
import {
  applyAgentProposal,
  askTravelAgent,
  previewAgentProposal,
  PreviewStaleApplyError,
  type AgentProposal,
  type CanonicalPreview,
} from '../../application/agentClient'
import type { ImportUpdatePlan } from '../../application/packageImport'
import type { Trip } from '../../domain/types'
import { useOnline } from '../useOnline'

function optionPrimarySource(o: {
  sourceUrl?: string
  provider?: string
  checkedAt?: string
  sourceType?: string
  title?: string
}): string {
  const parts: string[] = []
  if (o.sourceType) parts.push(o.sourceType)
  if (o.provider) parts.push(o.provider)
  if (o.sourceUrl) parts.push(o.sourceUrl)
  if (o.checkedAt) parts.push(`checked ${o.checkedAt}`)
  return parts.join(' · ') || 'sin fuente estructurada'
}

export function AskTravelPage() {
  const online = useOnline()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const initialTripId = searchParams.get('tripId') ?? ''

  const [trips, setTrips] = useState<Trip[]>([])
  const [tripId, setTripId] = useState(initialTripId)
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [jobStatus, setJobStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [staleMessage, setStaleMessage] = useState<string | null>(null)
  const [proposal, setProposal] = useState<AgentProposal | null>(null)
  const [canonical, setCanonical] = useState<CanonicalPreview | null>(null)
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

  async function refreshCanonicalPreview(p: AgentProposal, tid: string) {
    const preview = await previewAgentProposal(services, p, { tripId: tid })
    setCanonical(preview.canonical ?? null)
    setPlan(preview.plan)
    setStaleMessage(null)
  }

  async function handleAsk() {
    if (!tripId || !prompt.trim()) return
    setBusy(true)
    setError(null)
    setStaleMessage(null)
    setProposal(null)
    setCanonical(null)
    setPlan(null)
    setJobStatus('queued')
    try {
      const p = await askTravelAgent(
        services,
        {
          tripId,
          prompt: prompt.trim(),
        },
        {
          onProgress: (prog) => setJobStatus(prog.status),
        },
      )
      setProposal(p)
      await refreshCanonicalPreview(p, tripId)
      setJobStatus(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al consultar')
      setJobStatus(null)
    } finally {
      setBusy(false)
    }
  }

  async function handleRefreshPreview() {
    if (!proposal || !tripId) return
    setBusy(true)
    setError(null)
    try {
      await refreshCanonicalPreview(proposal, tripId)
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Error al actualizar vista previa',
      )
    } finally {
      setBusy(false)
    }
  }

  async function handleApply() {
    if (!proposal || !canonical || canonical.status !== 'ok') return
    setBusy(true)
    setError(null)
    setStaleMessage(null)
    try {
      const { tripId: tid } = await applyAgentProposal(services, proposal, {
        expectedFingerprint: canonical.fingerprint,
        expectedPlanHash: canonical.planHash,
        requirePreviewGate: true,
      })
      navigate(`/trips/${tid}/options`)
    } catch (err) {
      if (err instanceof PreviewStaleApplyError) {
        setStaleMessage(err.message)
      } else {
        setError(err instanceof Error ? err.message : 'Error al aplicar')
      }
    } finally {
      setBusy(false)
    }
  }

  function handleDiscard() {
    setProposal(null)
    setCanonical(null)
    setPlan(null)
    setError(null)
    setStaleMessage(null)
  }

  const applyEnabled =
    Boolean(proposal) &&
    Boolean(canonical) &&
    canonical?.status === 'ok' &&
    Boolean(canonical.fingerprint) &&
    Boolean(canonical.planHash) &&
    !staleMessage &&
    !busy

  const normalizedOptions =
    (
      canonical?.normalizedPackage as
        | { travelOptions?: Array<Record<string, unknown>> }
        | undefined
    )?.travelOptions ?? []

  return (
    <section className="page">
      <p>
        <Link to="/">← Tool4Trip</Link>
      </p>
      <h1>Ask Travel</h1>
      <p className="muted">
        Describe un cambio o pregunta sobre tu viaje. Verás una propuesta
        canónica (la misma que Apply usaría) antes de aplicar nada.
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
          {busy ? 'Investigando…' : 'Preguntar'}
        </button>
      </div>

      {busy && jobStatus && (
        <p className="muted" aria-live="polite">
          {jobStatus === 'queued'
            ? 'En cola…'
            : jobStatus === 'running'
              ? 'Investigando… (puedes dejar esta pestaña abierta)'
              : `Estado: ${jobStatus}`}
        </p>
      )}

      {error && <p className="status-bad">{error}</p>}

      {staleMessage && (
        <div className="status-bad" role="alert">
          <p>{staleMessage}</p>
          <button
            type="button"
            onClick={() => void handleRefreshPreview()}
            disabled={busy || !proposal}
          >
            Actualizar vista previa
          </button>
        </div>
      )}

      {proposal && (
        <div className="agent-proposal">
          <h2>Propuesta</h2>
          <p>{proposal.narrative}</p>

          {canonical?.status === 'review_required' && (
            <div className="status-bad">
              <p>
                Esta propuesta requiere revisión — Apply deshabilitado.
              </p>
              <ul>
                {(canonical.conflicts.length
                  ? canonical.conflicts
                  : ['Conflicto de mutación']
                ).map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          )}

          {(canonical?.warnings?.length ?? 0) > 0 && (
            <ul className="muted">
              {canonical!.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}

          {canonical && canonical.diff.length > 0 && (
            <>
              <h3>Cambios canónicos</h3>
              <table className="diff-table">
                <thead>
                  <tr>
                    <th>Op</th>
                    <th>Entidad</th>
                    <th>Detalle</th>
                  </tr>
                </thead>
                <tbody>
                  {canonical.diff.map((d, i) => (
                    <tr key={`${d.kind}-${d.externalId}-${i}`}>
                      <td>{d.kind}</td>
                      <td>{d.externalId}</td>
                      <td>
                        {d.fields?.length
                          ? d.fields
                              .map(
                                (f) =>
                                  `${f.field}: ${String(f.before ?? '—')} → ${String(f.after ?? '—')}`,
                              )
                              .join('; ')
                          : (d.note ?? '—')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {canonical && normalizedOptions.length > 0 && (
            <>
              <h3>Estado deseado (canónico)</h3>
              <ul>
                {normalizedOptions.map((o) => {
                  const ext = String(o.externalId ?? '')
                  return (
                    <li key={ext}>
                      <strong>{String(o.title ?? ext)}</strong>
                      {o.startAt ? ` · ${String(o.startAt)}` : ''}
                      <br />
                      <span className="muted">
                        {optionPrimarySource({
                          sourceUrl:
                            typeof o.sourceUrl === 'string'
                              ? o.sourceUrl
                              : undefined,
                          provider:
                            typeof o.provider === 'string'
                              ? o.provider
                              : undefined,
                          checkedAt:
                            typeof o.checkedAt === 'string'
                              ? o.checkedAt
                              : undefined,
                          sourceType:
                            typeof o.sourceType === 'string'
                              ? o.sourceType
                              : undefined,
                        })}
                      </span>
                    </li>
                  )
                })}
              </ul>
            </>
          )}

          {plan && (
            <p className="muted">
              Resumen canónico: altas {plan.created}, cambios {plan.updated},
              sin cambios de campo {plan.unchanged}
              {plan.isUpdate ? ` · revisión propuesta ${plan.revision}` : ''}
            </p>
          )}

          <details>
            <summary>Evidencia del agente (RAW / debug)</summary>
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
                    <th>Qué (RAW)</th>
                    <th>Antes</th>
                    <th>Después</th>
                  </tr>
                </thead>
                <tbody>
                  {proposal.diffSummary.map((d, i) => (
                    <tr key={`raw-${d.entityKind}-${i}`}>
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
            {proposal.toolTrace.length > 0 && (
              <ul>
                {proposal.toolTrace.map((t, i) => (
                  <li key={`${t.tool}-${i}`}>
                    {t.tool}: {t.ok ? 'ok' : t.error ?? 'fail'}
                    {t.sources && t.sources.length > 0 && (
                      <ul>
                        {t.sources.map((s, j) => (
                          <li key={`${i}-${j}`}>
                            {s.title ?? 'source'}
                            {s.url ? ` — ${s.url}` : ''}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </details>

          <div className="actions">
            <button
              type="button"
              onClick={() => void handleApply()}
              disabled={!applyEnabled}
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
