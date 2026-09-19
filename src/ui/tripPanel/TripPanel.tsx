import type { ReactNode } from 'react'
import type { TripPanelModel } from '../../application/tripPanel'
import { CardSection } from './OptionCard'
import { IntegritySummary, TripHeader } from './TripHeader'

export type TripPanelProps = {
  model: TripPanelModel
  /** Extra actions (Crear / Descartar) rendered under the panel. */
  actions?: ReactNode
  /** Show empty-section placeholders. */
  showEmptySections?: boolean
  /**
   * When embedded under an existing trip header, omit the duplicate title
   * and tighten vertical rhythm.
   */
  embedded?: boolean
}

export function TripPanel({
  model,
  actions,
  showEmptySections = true,
  embedded = false,
}: TripPanelProps) {
  const empty = showEmptySections ? 'Sin datos en la propuesta.' : undefined
  const techWarnings = model.technical?.warnings.filter((w) => w.trim()) ?? []

  return (
    <div className={`tp-panel${embedded ? ' tp-panel-embedded' : ''}`}>
      <TripHeader header={model.header} hideTitle={embedded} />
      <IntegritySummary diagnostics={model.diagnostics} />

      {model.executiveSummary && (
        <p className="tp-executive">{model.executiveSummary}</p>
      )}

      <div className="tp-sections">
        <CardSection
          title="Vuelos de ida"
          cards={model.flightsOut}
          emptyLabel={empty}
        />
        <CardSection
          title="Vuelos de regreso"
          cards={model.flightsReturn}
          emptyLabel={empty}
        />
        <CardSection
          title="Traslados terrestres"
          cards={model.ground}
          emptyLabel={empty}
        />
        <CardSection
          title="Hospedaje"
          cards={model.lodging}
          emptyLabel={empty}
        />
        <CardSection
          title="Actividades e itinerario"
          cards={model.activities}
          emptyLabel={empty}
        />
        <CardSection
          title="Pendientes"
          cards={model.checklist}
          emptyLabel={empty}
        />
        <CardSection title="Notas" cards={model.notes} emptyLabel={empty} />
        <CardSection
          title="Fuentes"
          cards={model.sources}
          emptyLabel={showEmptySections ? 'Sin URLs verificables.' : undefined}
        />
      </div>

      {model.technical && (
        <details className="tp-technical">
          <summary>Ver detalle técnico</summary>
          {model.technical.narrative && (
            <div className="tp-tech-block">
              <h4>Narrativa</h4>
              <p className="tp-tech-pre">{model.technical.narrative}</p>
            </div>
          )}
          {techWarnings.length > 0 && (
            <div className="tp-tech-block">
              <h4>Advertencias del agente</h4>
              <ul>
                {techWarnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          )}
          {model.technical.jsonText && (
            <div className="tp-tech-block">
              <h4>JSON del paquete</h4>
              <pre className="tp-json">{model.technical.jsonText}</pre>
            </div>
          )}
        </details>
      )}

      {actions && <div className="tp-actions">{actions}</div>}
    </div>
  )
}
