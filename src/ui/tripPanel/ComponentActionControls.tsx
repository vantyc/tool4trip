import { useId, useState } from 'react'
import type { ComponentActionResult } from '../../../shared/agentContracts'
import type { TripPanelCard } from '../../application/tripPanel'
import {
  ACTION_LABEL,
  actionsForCardKind,
  type CardActionIntent,
} from '../../application/tripPanel/componentActions'

export type ComponentActionControlsProps = {
  card: TripPanelCard
  busy?: boolean
  onAction: (intent: CardActionIntent, instruction?: string) => void
  onPromoteAlternative?: (alternativeId: string) => void
  pendingResult?: ComponentActionResult | null
  onAcceptResult?: (opts: {
    acceptedPatchComponentIds: string[]
    acceptedImpactIds: string[]
    acceptedAlternativeIds: string[]
    promoteAlternativeId?: string
  }) => void
  onCancelResult?: () => void
}

export function ComponentActionControls({
  card,
  busy,
  onAction,
  onPromoteAlternative,
  pendingResult,
  onAcceptResult,
  onCancelResult,
}: ComponentActionControlsProps) {
  const menuId = useId()
  const [open, setOpen] = useState(false)
  const [adjustOpen, setAdjustOpen] = useState(false)
  const [instruction, setInstruction] = useState('')
  const [acceptedImpacts, setAcceptedImpacts] = useState<Set<string>>(
    () => new Set(),
  )
  const [acceptedAlts, setAcceptedAlts] = useState<Set<string>>(
    () => new Set(),
  )
  const actions = actionsForCardKind(card.kind)
  if (actions.length === 0 && !pendingResult) return null

  function start(intent: CardActionIntent) {
    setOpen(false)
    if (intent === 'adjust') {
      setAdjustOpen(true)
      return
    }
    onAction(intent)
  }

  function submitAdjust() {
    const t = instruction.trim()
    if (!t) return
    onAction('adjust', t)
    setAdjustOpen(false)
    setInstruction('')
  }

  const showSheet = Boolean(pendingResult && onAcceptResult)

  return (
    <div className="tp-card-actions">
      {actions.length > 0 && (
        <div className="tp-card-menu-wrap">
          <button
            type="button"
            className="tp-card-menu-btn"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={menuId}
            disabled={busy}
            onClick={() => setOpen((v) => !v)}
            title="Acciones"
          >
            ⋯
          </button>
          {open && (
            <ul id={menuId} className="tp-card-menu" role="menu">
              {actions.map((a) => (
                <li key={a} role="none">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => start(a)}
                  >
                    {ACTION_LABEL[a]}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {adjustOpen && (
        <div className="tp-adjust-box">
          <label>
            Ajuste
            <textarea
              rows={2}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="Ej. quiero salir después de las 11"
              disabled={busy}
            />
          </label>
          <div className="tp-adjust-actions">
            <button type="button" onClick={submitAdjust} disabled={busy || !instruction.trim()}>
              Enviar
            </button>
            <button
              type="button"
              className="muted"
              onClick={() => {
                setAdjustOpen(false)
                setInstruction('')
              }}
              disabled={busy}
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      {busy && <p className="muted tp-card-busy">Investigando…</p>}

      {showSheet && pendingResult && (
        <div className="tp-action-sheet" role="region" aria-label="Confirmar cambios">
          <p className="tp-action-op">
            Operación: <strong>{pendingResult.operation}</strong>
          </p>
          <p className="tp-action-narrative">{pendingResult.narrative}</p>

          {pendingResult.diffSummary.length > 0 && (
            <table className="diff-table tp-action-diff">
              <thead>
                <tr>
                  <th>Qué</th>
                  <th>Antes</th>
                  <th>Después</th>
                </tr>
              </thead>
              <tbody>
                {pendingResult.diffSummary.map((d, i) => (
                  <tr key={`${d.entityRef}-${i}`}>
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

          {pendingResult.patches[0]?.provenance && (
            <p className="muted small">
              Provenance: {pendingResult.patches[0].provenance.sourceType} /{' '}
              {pendingResult.patches[0].provenance.verificationStatus}
              {pendingResult.patches[0].provenance.note
                ? ` — ${pendingResult.patches[0].provenance.note}`
                : ''}
            </p>
          )}

          {pendingResult.alternatives.length > 0 && (
            <div className="tp-action-alts">
              <h5>Alternativas (researched — no sustituyen la actual)</h5>
              <ul>
                {pendingResult.alternatives.map((a) => (
                  <li key={a.provisionalExternalId}>
                    <label>
                      <input
                        type="checkbox"
                        checked={acceptedAlts.has(a.provisionalExternalId)}
                        onChange={(e) => {
                          setAcceptedAlts((prev) => {
                            const n = new Set(prev)
                            if (e.target.checked) n.add(a.provisionalExternalId)
                            else n.delete(a.provisionalExternalId)
                            return n
                          })
                        }}
                      />
                      <span>{a.summary}</span>
                    </label>
                    {onPromoteAlternative && (
                      <button
                        type="button"
                        className="tp-promote-btn"
                        onClick={() =>
                          onPromoteAlternative(a.provisionalExternalId)
                        }
                      >
                        Usar esta opción
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {pendingResult.impacts.length > 0 && (
            <div className="tp-action-impacts">
              <h5>Impactos (off por defecto)</h5>
              <ul>
                {pendingResult.impacts.map((imp) => (
                  <li key={imp.impactId}>
                    <label>
                      <input
                        type="checkbox"
                        checked={acceptedImpacts.has(imp.impactId)}
                        onChange={(e) => {
                          setAcceptedImpacts((prev) => {
                            const n = new Set(prev)
                            if (e.target.checked) n.add(imp.impactId)
                            else n.delete(imp.impactId)
                            return n
                          })
                        }}
                      />
                      <span>
                        [{imp.severity}] {imp.reason}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {pendingResult.warnings.length > 0 && (
            <ul className="muted">
              {pendingResult.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}

          <div className="tp-adjust-actions">
            <button
              type="button"
              onClick={() =>
                onAcceptResult!({
                  acceptedPatchComponentIds: pendingResult.patches.map(
                    (p) => p.componentId,
                  ),
                  acceptedImpactIds: [...acceptedImpacts],
                  acceptedAlternativeIds: [...acceptedAlts],
                })
              }
            >
              Aplicar cambios
            </button>
            <button type="button" className="muted" onClick={onCancelResult}>
              Cancelar
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
