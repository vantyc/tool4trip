import { useEffect, useMemo, useState } from 'react'
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
import {
  buildCanonicalNarrative,
  collectStructuredEvidence,
  countCanonicalDiff,
  detectDependencyWarnings,
  flightScheduleConfidenceLabels,
  formatDateLongEs,
  type TravelOptionLike,
} from '../../application/askTravelProposalView'
import type { Trip } from '../../domain/types'
import { useOnline } from '../useOnline'
import { safeDisplayText } from '../../../shared/displaySanitize'

function optionPrimarySource(o: TravelOptionLike): string {
  const parts: string[] = []
  if (o.sourceType) parts.push(o.sourceType)
  if (o.provider) parts.push(o.provider)
  if (o.sourceUrl) parts.push(o.sourceUrl)
  if (o.checkedAt) parts.push(`checked ${o.checkedAt}`)
  const confidence = flightScheduleConfidenceLabels(o)
  if (confidence.length) parts.push(confidence.join(' · '))
  return parts.join(' · ') || 'sin fuente estructurada'
}

function opLabel(kind: string): string {
  if (kind === 'add') return 'Alta'
  if (kind === 'remove') return 'Eliminación'
  if (kind === 'update') return 'Actualización'
  return kind
}

export function AskTravelPage() {
  const online = useOnline()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const initialTripId = searchParams.get('tripId') ?? ''

  const [trips, setTrips] = useState<Trip[]>([])
  const [tripId, setTripId] = useState(initialTripId)
  const [prompt, setPrompt] = useState('')
  const [submittedPrompt, setSubmittedPrompt] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [jobStatus, setJobStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [staleMessage, setStaleMessage] = useState<string | null>(null)
  const [proposal, setProposal] = useState<AgentProposal | null>(null)
  const [canonical, setCanonical] = useState<CanonicalPreview | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const selectedTrip = trips.find((t) => t.id === tripId)

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
    setStaleMessage(null)
  }

  async function handleAsk() {
    if (!tripId || !prompt.trim()) return
    setBusy(true)
    setError(null)
    setStaleMessage(null)
    setProposal(null)
    setCanonical(null)
    setConfirmOpen(false)
    setSubmittedPrompt(prompt.trim())
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

  async function handleApplyConfirmed() {
    if (!proposal || !canonical || canonical.status !== 'ok') return
    setBusy(true)
    setError(null)
    setStaleMessage(null)
    setConfirmOpen(false)
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
    setSubmittedPrompt(null)
    setConfirmOpen(false)
    setError(null)
    setStaleMessage(null)
  }

  const normalizedOptions: TravelOptionLike[] =
    (
      canonical?.normalizedPackage as
        | { travelOptions?: TravelOptionLike[] }
        | undefined
    )?.travelOptions ?? []

  const proposedTrip = (
    canonical?.normalizedPackage as
      | { trip?: { startDate?: string; endDate?: string; title?: string } }
      | undefined
  )?.trip

  const counts = useMemo(
    () =>
      canonical
        ? countCanonicalDiff(canonical.diff, normalizedOptions.length)
        : null,
    [canonical, normalizedOptions.length],
  )

  const dependencyWarnings = useMemo(
    () => detectDependencyWarnings(normalizedOptions),
    [normalizedOptions],
  )

  const canonicalNarrative = useMemo(() => {
    if (!canonical || !selectedTrip || !proposedTrip?.startDate) return null
    return buildCanonicalNarrative({
      tripTitle: selectedTrip.title,
      currentWindow: {
        startDate: selectedTrip.startDate,
        endDate: selectedTrip.endDate,
      },
      proposedWindow: {
        startDate: proposedTrip.startDate,
        endDate: proposedTrip.endDate ?? proposedTrip.startDate,
      },
      diff: canonical.diff,
      normalizedOptions,
    })
  }, [canonical, selectedTrip, proposedTrip, normalizedOptions])

  const evidenceRows = useMemo(() => {
    if (!proposal) return []
    return collectStructuredEvidence({
      warnings: proposal.warnings ?? [],
      diffSummary: proposal.diffSummary ?? [],
      toolTrace: proposal.toolTrace ?? [],
    })
  }, [proposal])

  const applyEnabled =
    Boolean(proposal) &&
    Boolean(canonical) &&
    canonical?.status === 'ok' &&
    Boolean(canonical.fingerprint) &&
    Boolean(canonical.planHash) &&
    !staleMessage &&
    !busy

  function requestApply() {
    if (!applyEnabled) return
    setConfirmOpen(true)
  }

  return (
    <section className="page ask-travel-page">
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
          <header className="ask-proposal-header">
            <h2>Propuesta</h2>
            <p className="ask-status-pill" role="status">
              Pendiente de aplicar — nada se ha persistido todavía
            </p>
            <dl className="ask-proposal-meta">
              <div>
                <dt>Viaje</dt>
                <dd>{safeDisplayText(selectedTrip?.title ?? '—')}</dd>
              </div>
              <div>
                <dt>Ventana</dt>
                <dd>
                  {selectedTrip
                    ? `${formatDateLongEs(selectedTrip.startDate)} → ${formatDateLongEs(selectedTrip.endDate)}`
                    : '—'}
                  {proposedTrip?.startDate
                    ? `  ⇒  ${formatDateLongEs(proposedTrip.startDate)} → ${formatDateLongEs(proposedTrip.endDate ?? proposedTrip.startDate)}`
                    : ''}
                </dd>
              </div>
              <div>
                <dt>Operaciones</dt>
                <dd>{counts?.totalOps ?? 0}</dd>
              </div>
              <div>
                <dt>Conflictos</dt>
                <dd>
                  {(canonical?.conflicts.length ?? 0) +
                    dependencyWarnings.length}
                </dd>
              </div>
            </dl>
          </header>

          <details className="ask-collapsible">
            <summary>Solicitud original</summary>
            <pre className="ask-pre">
              {safeDisplayText(submittedPrompt ?? prompt)}
            </pre>
          </details>

          <h3>Resumen canónico</h3>
          <p>{safeDisplayText(canonicalNarrative ?? 'Sin resumen canónico.')}</p>

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
                  <li key={c}>{safeDisplayText(c)}</li>
                ))}
              </ul>
            </div>
          )}

          {dependencyWarnings.length > 0 && (
            <div className="ask-warnings" role="alert">
              <h3>Advertencias de dependencia</h3>
              <ul>
                {dependencyWarnings.map((w) => (
                  <li key={w.code}>{safeDisplayText(w.message)}</li>
                ))}
              </ul>
              <p className="muted">
                No se ajustan nodos dependientes automáticamente — revisa antes
                de aplicar.
              </p>
            </div>
          )}

          {(canonical?.warnings?.length ?? 0) > 0 && (
            <ul className="muted">
              {canonical!.warnings.map((w) => (
                <li key={w}>{safeDisplayText(w)}</li>
              ))}
            </ul>
          )}

          {canonical && counts && (
            <p className="ask-counts">
              Altas {counts.adds} · Actualizaciones {counts.updates} ·
              Eliminaciones {counts.removes} · Sin cambios {counts.unchanged} ·
              Total operaciones {counts.totalOps}
            </p>
          )}

          {canonical && canonical.diff.length > 0 && (
            <>
              <h3>Cambios canónicos</h3>
              <div className="ask-diff-desktop">
                <table className="ask-diff-table">
                  <thead>
                    <tr>
                      <th scope="col">Operación</th>
                      <th scope="col">Entidad</th>
                      <th scope="col">Detalle</th>
                    </tr>
                  </thead>
                  <tbody>
                    {canonical.diff.map((d, i) => (
                      <tr key={`${d.kind}-${d.externalId}-${i}`}>
                        <td data-label="Operación">
                          {safeDisplayText(opLabel(d.kind))}
                        </td>
                        <td data-label="Entidad">
                          {safeDisplayText(d.externalId)}
                        </td>
                        <td data-label="Detalle">
                          {d.fields?.length
                            ? d.fields
                                .map(
                                  (f) =>
                                    `${safeDisplayText(f.field, '')}: ${safeDisplayText(f.before)} → ${safeDisplayText(f.after)}`,
                                )
                                .join('; ')
                            : safeDisplayText(d.note)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ul className="ask-diff-cards">
                {canonical.diff.map((d, i) => (
                  <li
                    key={`card-${d.kind}-${d.externalId}-${i}`}
                    className="ask-diff-card"
                  >
                    <p>
                      <strong>Operación:</strong>{' '}
                      {safeDisplayText(opLabel(d.kind))}
                    </p>
                    <p>
                      <strong>Entidad:</strong>{' '}
                      {safeDisplayText(d.externalId)}
                    </p>
                    <p>
                      <strong>Detalle:</strong>{' '}
                      {d.fields?.length
                        ? d.fields
                            .map(
                              (f) =>
                                `${safeDisplayText(f.field, '')}: ${safeDisplayText(f.before)} → ${safeDisplayText(f.after)}`,
                            )
                            .join('; ')
                        : safeDisplayText(d.note)}
                    </p>
                  </li>
                ))}
              </ul>
            </>
          )}

          {canonical && normalizedOptions.length > 0 && (
            <>
              <h3>Estado deseado (canónico)</h3>
              <ul className="ask-desired-list">
                {normalizedOptions.map((o) => {
                  const ext = String(o.externalId ?? '')
                  const labels = flightScheduleConfidenceLabels(o)
                  return (
                    <li key={ext}>
                      <strong>{safeDisplayText(o.title ?? ext)}</strong>
                      {o.startAt
                        ? ` · ${safeDisplayText(o.startAt, '')}`
                        : ''}
                      <br />
                      <span className="muted">
                        {safeDisplayText(
                          optionPrimarySource(o),
                          'sin fuente estructurada',
                        )}
                      </span>
                      {labels.length > 0 && (
                        <ul className="ask-confidence">
                          {labels.map((l) => (
                            <li key={l}>{l}</li>
                          ))}
                        </ul>
                      )}
                    </li>
                  )
                })}
              </ul>
            </>
          )}

          <details className="ask-collapsible">
            <summary>Evidencia del agente</summary>
            {evidenceRows.length === 0 ? (
              <p className="muted">Sin evidencia adicional</p>
            ) : (
              <ul className="ask-evidence-cards">
                {evidenceRows.map((row, i) => (
                  <li key={`${row.kind}-${i}`} className="ask-evidence-card">
                    <p>
                      <strong>{safeDisplayText(row.kind)}</strong> —{' '}
                      {safeDisplayText(row.title)}
                    </p>
                    {row.detail && (
                      <p className="muted">{safeDisplayText(row.detail)}</p>
                    )}
                    {row.url && (
                      <p className="muted">{safeDisplayText(row.url)}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <details className="ask-collapsible ask-raw-block">
              <summary>RAW / debug (escapado)</summary>
              <pre className="ask-pre">
                {safeDisplayText(
                  JSON.stringify(
                    {
                      narrative: proposal.narrative,
                      warnings: proposal.warnings,
                      diffSummary: proposal.diffSummary,
                      toolTrace: proposal.toolTrace,
                    },
                    null,
                    2,
                  ),
                )}
              </pre>
            </details>
          </details>

          <div className="actions">
            <button
              type="button"
              onClick={requestApply}
              disabled={!applyEnabled}
            >
              Aplicar cambios
            </button>
            <button type="button" onClick={handleDiscard} disabled={busy}>
              Descartar
            </button>
          </div>

          {confirmOpen && counts && (
            <div className="ask-confirm" role="dialog" aria-modal="true">
              <h3>Confirmar Apply</h3>
              <p className="muted">
                Nada se ha persistido todavía. Revisa el resumen antes de
                continuar.
              </p>
              <ul>
                <li>Entidades agregadas: {counts.adds}</li>
                <li>Entidades actualizadas: {counts.updates}</li>
                <li>Entidades eliminadas: {counts.removes}</li>
                <li>
                  Conflictos pendientes:{' '}
                  {(canonical?.conflicts.length ?? 0) +
                    dependencyWarnings.length}
                </li>
              </ul>
              {dependencyWarnings.length > 0 && (
                <div className="ask-warnings">
                  <p>
                    Hay conflictos temporales o de traslado. Confirma
                    explícitamente que quieres aplicar de todos modos.
                  </p>
                  <ul>
                    {dependencyWarnings.map((w) => (
                      <li key={`c-${w.code}`}>{safeDisplayText(w.message)}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="actions">
                <button
                  type="button"
                  onClick={() => void handleApplyConfirmed()}
                  disabled={busy}
                >
                  {dependencyWarnings.length > 0
                    ? 'Confirmar Apply con conflictos'
                    : 'Confirmar Apply'}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmOpen(false)}
                  disabled={busy}
                >
                  Cancelar
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
