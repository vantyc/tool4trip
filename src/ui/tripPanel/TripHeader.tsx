import type {
  IntegrityLight,
  TripPanelDiagnostics,
  TripPanelHeader,
} from '../../application/tripPanel'

const LIGHT_LABEL: Record<IntegrityLight, string> = {
  green: 'Integridad alta',
  amber: 'Integridad media',
  red: 'Integridad baja',
}

export function TripHeader({ header }: { header: TripPanelHeader }) {
  return (
    <header className="tp-header">
      <div className="tp-header-main">
        <h2 className="tp-title">{header.title}</h2>
        <p className="tp-status muted">{header.statusLabel}</p>
      </div>
      <dl className="tp-header-meta">
        {header.origin && (
          <div>
            <dt>Origen</dt>
            <dd>{header.origin}</dd>
          </div>
        )}
        <div>
          <dt>Destinos</dt>
          <dd>{header.destinations.join(' · ')}</dd>
        </div>
        {(header.startDate || header.endDate) && (
          <div>
            <dt>Fechas</dt>
            <dd>
              {header.startDate ?? '—'} → {header.endDate ?? '—'}
              {header.days !== undefined
                ? ` · ${header.days} día(s)`
                : ''}
              {header.nights !== undefined
                ? ` · ${header.nights} noche(s)`
                : ''}
            </dd>
          </div>
        )}
        {header.budgetAmount !== undefined && (
          <div>
            <dt>Presupuesto</dt>
            <dd>
              {header.budgetAmount}
              {header.budgetCurrency ? ` ${header.budgetCurrency}` : ''}
              {header.budgetConfidence
                ? ` (${header.budgetConfidence})`
                : ''}
            </dd>
          </div>
        )}
        <div>
          <dt>Progreso</dt>
          <dd>
            <div
              className="tp-progress"
              role="progressbar"
              aria-valuenow={header.progressPct}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className="tp-progress-bar"
                style={{ width: `${header.progressPct}%` }}
              />
            </div>
            <span className="tp-progress-label">{header.progressPct}%</span>
          </dd>
        </div>
      </dl>
    </header>
  )
}

export function IntegritySummary({
  diagnostics,
}: {
  diagnostics: TripPanelDiagnostics
}) {
  return (
    <section
      className={`tp-integrity tp-integrity-${diagnostics.integrityLight}`}
      aria-label="Diagnóstico de integridad"
    >
      <div className="tp-integrity-light" aria-hidden>
        <span className="tp-light-dot" />
        <span className="tp-light-label">
          {LIGHT_LABEL[diagnostics.integrityLight]}
        </span>
      </div>
      <ul className="tp-integrity-counts">
        <li>
          <strong>{diagnostics.verifiedCount}</strong> verificados
        </li>
        <li>
          <strong>{diagnostics.pendingCount}</strong> pendientes
        </li>
        <li>
          <strong>{diagnostics.missingCount}</strong> faltantes
        </li>
        <li>
          <strong>{diagnostics.sourceCount}</strong> fuentes
        </li>
      </ul>
      {diagnostics.warnings.length > 0 && (
        <details className="tp-integrity-warnings">
          <summary>
            {diagnostics.warnings.length} advertencia
            {diagnostics.warnings.length === 1 ? '' : 's'}
          </summary>
          <ul>
            {diagnostics.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}
