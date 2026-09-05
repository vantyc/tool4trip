import { useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { services } from '../../application'
import {
  DuplicatePackageError,
  PackageValidationImportError,
} from '../../application/packageImport'
import {
  summarizePackage,
  type TripPackageV1,
  validateTripPackage,
} from '../../application/tripPackage'

type Phase =
  | { kind: 'pick' }
  | { kind: 'invalid'; errors: { path: string; message: string }[] }
  | { kind: 'preview'; pkg: TripPackageV1; duplicate: boolean }
  | { kind: 'done'; tripId: string; packageId: string }

export function ImportResearchPage() {
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)
  const [phase, setPhase] = useState<Phase>({ kind: 'pick' })
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function onFileSelected(file: File | undefined) {
    setMessage(null)
    if (!file) return
    try {
      const text = await file.text()
      let raw: unknown
      try {
        raw = JSON.parse(text) as unknown
      } catch {
        setPhase({
          kind: 'invalid',
          errors: [{ path: '(file)', message: 'JSON inválido' }],
        })
        return
      }
      const result = validateTripPackage(raw)
      if (!result.ok) {
        setPhase({ kind: 'invalid', errors: result.errors })
        return
      }
      const existing = await services.packages.getById(result.package.packageId)
      setPhase({
        kind: 'preview',
        pkg: result.package,
        duplicate: Boolean(existing),
      })
    } catch (err) {
      setPhase({
        kind: 'invalid',
        errors: [
          {
            path: '(file)',
            message: err instanceof Error ? err.message : 'Error al leer',
          },
        ],
      })
    }
  }

  async function handleImport(force = false) {
    if (phase.kind !== 'preview') return
    setBusy(true)
    setMessage(null)
    try {
      const result = await services.packages.importPackage(phase.pkg, {
        force,
      })
      setPhase({
        kind: 'done',
        tripId: result.tripId,
        packageId: result.packageId,
      })
    } catch (err) {
      if (err instanceof DuplicatePackageError) {
        setMessage(err.message)
      } else if (err instanceof PackageValidationImportError) {
        setPhase({ kind: 'invalid', errors: err.errors })
      } else {
        setMessage(err instanceof Error ? err.message : 'Error al importar')
      }
    } finally {
      setBusy(false)
    }
  }

  function reset() {
    setPhase({ kind: 'pick' })
    setMessage(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  return (
    <section className="page">
      <Link to="/" className="back">
        ← Viajes
      </Link>
      <h1>Importar investigación</h1>
      <p className="muted">
        Carga un TripPackage v1 (.json). Las opciones quedan como investigación,
        no como reservas confirmadas.
      </p>

      {phase.kind === 'pick' && (
        <div className="actions">
          <label className="sum-action file-pick">
            Seleccionar archivo JSON
            <input
              ref={inputRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(e) => void onFileSelected(e.target.files?.[0])}
            />
          </label>
        </div>
      )}

      {phase.kind === 'invalid' && (
        <div>
          <p className="status-bad">Paquete inválido — no se importó nada.</p>
          <ul className="error-list">
            {phase.errors.map((e) => (
              <li key={`${e.path}:${e.message}`}>
                <code>{e.path}</code>: {e.message}
              </li>
            ))}
          </ul>
          <div className="actions">
            <button type="button" className="sum-action" onClick={reset}>
              Elegir otro archivo
            </button>
          </div>
        </div>
      )}

      {phase.kind === 'preview' && (
        <PreviewBlock
          pkg={phase.pkg}
          duplicate={phase.duplicate}
          busy={busy}
          message={message}
          onCancel={reset}
          onImport={() => void handleImport(false)}
          onForce={() => void handleImport(true)}
        />
      )}

      {phase.kind === 'done' && (
        <div>
          <p className="status-ok">
            Importación lista ({phase.packageId}).
          </p>
          <div className="actions">
            <button
              type="button"
              className="sum-action"
              onClick={() =>
                navigate(`/trips/${phase.tripId}/options`)
              }
            >
              Ver opciones
            </button>
            <button type="button" className="sum-action" onClick={reset}>
              Importar otro
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

function PreviewBlock({
  pkg,
  duplicate,
  busy,
  message,
  onCancel,
  onImport,
  onForce,
}: {
  pkg: TripPackageV1
  duplicate: boolean
  busy: boolean
  message: string | null
  onCancel: () => void
  onImport: () => void
  onForce: () => void
}) {
  const s = summarizePackage(pkg)
  return (
    <div className="import-preview">
      <h2>Vista previa</h2>
      <dl className="preview-dl">
        <dt>Viaje</dt>
        <dd>{s.title}</dd>
        <dt>Destino</dt>
        <dd>{s.destination ?? '—'}</dd>
        <dt>Fechas</dt>
        <dd>
          {s.startDate} → {s.endDate}
        </dd>
        <dt>packageId</dt>
        <dd>
          <code>{s.packageId}</code>
        </dd>
        <dt>Opciones</dt>
        <dd>{s.optionCount}</dd>
        <dt>Vuelos</dt>
        <dd>{s.flights}</dd>
        <dt>Hospedaje</dt>
        <dd>{s.lodging}</dd>
        <dt>Transporte</dt>
        <dd>{s.transport}</dd>
        <dt>Actividades</dt>
        <dd>{s.activities}</dd>
        <dt>Itinerario / checklist / notas</dt>
        <dd>
          {s.itineraryCount} / {s.checklistCount} / {s.notesCount}
        </dd>
      </dl>

      {duplicate && (
        <p className="status-bad">
          Este packageId ya fue importado. No se duplicará en silencio. Puedes
          cancelar o reemplazar las opciones de ese paquete.
        </p>
      )}
      {message && <p className="status-bad">{message}</p>}

      <div className="actions">
        <button
          type="button"
          className="sum-action"
          onClick={onCancel}
          disabled={busy}
        >
          Cancelar
        </button>
        {!duplicate ? (
          <button
            type="button"
            className="sum-action"
            onClick={onImport}
            disabled={busy}
          >
            {busy ? 'Importando…' : 'Importar'}
          </button>
        ) : (
          <button
            type="button"
            className="sum-action"
            onClick={onForce}
            disabled={busy}
          >
            {busy ? 'Reemplazando…' : 'Reemplazar importación'}
          </button>
        )}
      </div>
    </div>
  )
}
