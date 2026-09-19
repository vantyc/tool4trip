import { useLiveQuery } from 'dexie-react-hooks'
import {
  type FormEvent,
  type RefObject,
  useId,
  useRef,
  useState,
} from 'react'
import { useParams } from 'react-router-dom'
import { services } from '../../application'
import {
  DocumentValidationError,
  documentTypeLabel,
  formatBytes,
} from '../../application/documents'
import { summarizeDocumentStorage } from '../../application/storageStats'
import type {
  Booking,
  DocumentMeta,
  DocumentType,
  ItineraryItem,
} from '../../domain/types'
import { useDocumentViewer } from '../documents/useDocumentViewer'
import { useCloudQuery } from '../useCloudQuery'

const DOC_TYPES: DocumentType[] = [
  'reservation',
  'boarding_pass',
  'ticket',
  'receipt',
  'insurance',
  'id_scan',
  'photo',
  'other',
]

type FormMode =
  | { kind: 'closed' }
  | { kind: 'attach' }
  | { kind: 'edit'; doc: DocumentMeta }

export function DocumentsPage() {
  const { tripId } = useParams<{ tripId: string }>()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [form, setForm] = useState<FormMode>({ kind: 'closed' })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const { open, Viewer } = useDocumentViewer()

  const docs =
    useLiveQuery(async () => {
      if (!tripId) return []
      const list = await services.documents.listByTrip(tripId)
      return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    }, [tripId]) ?? []

  const { data: bookings = [] } = useCloudQuery(
    tripId ? `docs-bookings:${tripId}` : null,
    () => services.bookings.listByTrip(tripId!),
  )

  const { data: items = [] } = useCloudQuery(
    tripId ? `docs-items:${tripId}` : null,
    () => services.itinerary.listByTrip(tripId!),
  )

  const bookingTitle = new Map(bookings.map((b) => [b.id, b.title]))
  const itemTitle = new Map(
    items.map((i) => [i.id, i.title ?? i.id.slice(0, 8)]),
  )
  const storage = summarizeDocumentStorage(docs)

  async function handleDelete(doc: DocumentMeta) {
    const ok = window.confirm(`¿Eliminar «${doc.name}»? Esta acción no se puede deshacer.`)
    if (!ok) return
    await services.documents.remove(doc.id)
  }

  return (
    <section className="page">
      <div className="docs-header">
        <h2>Documentos</h2>
        <button
          type="button"
          className="sum-action"
          onClick={() => {
            setError(null)
            setForm({ kind: 'attach' })
          }}
        >
          Adjuntar
        </button>
      </div>
      <p className="muted">
        Gaveta digital local (IndexedDB). PDF e imágenes — offline una vez
        guardados.
      </p>
      <p className="docs-storage muted">
        {storage.count === 0
          ? '0 documentos · 0 B'
          : `${storage.count} documento${storage.count === 1 ? '' : 's'} · ${storage.totalLabel} local`}
      </p>

      {error && <p className="status-bad">{error}</p>}

      {form.kind !== 'closed' && tripId && (
        <DocumentForm
          tripId={tripId}
          mode={form}
          bookings={bookings}
          items={items}
          fileInputRef={fileInputRef}
          busy={busy}
          onCancel={() => setForm({ kind: 'closed' })}
          onBusy={setBusy}
          onError={setError}
          onDone={() => setForm({ kind: 'closed' })}
        />
      )}

      {docs.length === 0 ? (
        <p className="muted">Sin documentos. Adjunta un PDF o una imagen.</p>
      ) : (
        <ul className="entity-list docs-list">
          {docs.map((doc) => (
            <li key={doc.id} className="doc-row">
              <div className="entity-title">{doc.name}</div>
              <div className="entity-meta">
                {documentTypeLabel(doc.type)} · {formatBytes(doc.sizeBytes)}
              </div>
              <div className="entity-meta">
                {doc.capturedAt?.slice(0, 10) ?? doc.createdAt.slice(0, 10)}
                {doc.mimeType ? ` · ${doc.mimeType}` : ''}
              </div>
              {(doc.bookingId || doc.itineraryItemId) && (
                <div className="entity-meta">
                  {doc.bookingId && (
                    <span>Reserva: {bookingTitle.get(doc.bookingId) ?? '—'}</span>
                  )}
                  {doc.bookingId && doc.itineraryItemId && ' · '}
                  {doc.itineraryItemId && (
                    <span>
                      Ítem: {itemTitle.get(doc.itineraryItemId) ?? '—'}
                    </span>
                  )}
                </div>
              )}
              {doc.notes && <p className="note-block small">{doc.notes}</p>}
              <div className="sum-actions doc-row-actions">
                <button
                  type="button"
                  className="sum-action"
                  onClick={() => open(doc.id)}
                >
                  Abrir
                </button>
                <button
                  type="button"
                  className="sum-action"
                  onClick={() => {
                    setError(null)
                    setForm({ kind: 'edit', doc })
                  }}
                >
                  Editar
                </button>
                <button
                  type="button"
                  className="sum-action"
                  onClick={() => void handleDelete(doc)}
                >
                  Eliminar
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {Viewer}
    </section>
  )
}

function DocumentForm({
  tripId,
  mode,
  bookings,
  items,
  fileInputRef,
  busy,
  onCancel,
  onBusy,
  onError,
  onDone,
}: {
  tripId: string
  mode: Exclude<FormMode, { kind: 'closed' }>
  bookings: Booking[]
  items: ItineraryItem[]
  fileInputRef: RefObject<HTMLInputElement | null>
  busy: boolean
  onCancel: () => void
  onBusy: (v: boolean) => void
  onError: (msg: string | null) => void
  onDone: () => void
}) {
  const formId = useId()
  const isEdit = mode.kind === 'edit'
  const [name, setName] = useState(isEdit ? mode.doc.name : '')
  const [type, setType] = useState<DocumentType>(
    isEdit ? mode.doc.type : 'reservation',
  )
  const [bookingId, setBookingId] = useState(isEdit ? mode.doc.bookingId ?? '' : '')
  const [itineraryItemId, setItineraryItemId] = useState(
    isEdit ? mode.doc.itineraryItemId ?? '' : '',
  )
  const [notes, setNotes] = useState(isEdit ? mode.doc.notes ?? '' : '')

  async function submit(e: FormEvent) {
    e.preventDefault()
    onError(null)
    onBusy(true)
    try {
      if (isEdit) {
        await services.documents.updateMeta({
          id: mode.doc.id,
          name,
          type,
          bookingId: bookingId || undefined,
          itineraryItemId: itineraryItemId || undefined,
          notes: notes || undefined,
        })
      } else {
        const file = fileInputRef.current?.files?.[0]
        if (!file) {
          onError('Elige un archivo.')
          return
        }
        await services.documents.attachFromFile({
          tripId,
          file,
          name: name || undefined,
          type,
          bookingId: bookingId || undefined,
          itineraryItemId: itineraryItemId || undefined,
          notes: notes || undefined,
        })
      }
      onDone()
    } catch (err) {
      const msg =
        err instanceof DocumentValidationError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'No se pudo guardar'
      onError(msg)
    } finally {
      onBusy(false)
    }
  }

  return (
    <form className="doc-form" onSubmit={(e) => void submit(e)}>
      <h3>{isEdit ? 'Editar documento' : 'Adjuntar documento'}</h3>

      {!isEdit && (
        <label className="doc-field">
          Archivo
          <input
            ref={fileInputRef}
            id={`${formId}-file`}
            type="file"
            accept="application/pdf,image/jpeg,image/png,image/webp,image/gif,.pdf,.jpg,.jpeg,.png,.webp,.gif"
            required
          />
        </label>
      )}

      <label className="doc-field">
        Nombre
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={isEdit ? undefined : 'Opcional — usa el nombre del archivo'}
        />
      </label>

      <label className="doc-field">
        Tipo
        <select
          value={type}
          onChange={(e) => setType(e.target.value as DocumentType)}
        >
          {DOC_TYPES.map((t) => (
            <option key={t} value={t}>
              {documentTypeLabel(t)}
            </option>
          ))}
        </select>
      </label>

      <label className="doc-field">
        Reserva (opcional)
        <select
          value={bookingId}
          onChange={(e) => setBookingId(e.target.value)}
        >
          <option value="">— Ninguna —</option>
          {bookings.map((b) => (
            <option key={b.id} value={b.id}>
              {b.title}
            </option>
          ))}
        </select>
      </label>

      <label className="doc-field">
        Ítem de itinerario (opcional)
        <select
          value={itineraryItemId}
          onChange={(e) => setItineraryItemId(e.target.value)}
        >
          <option value="">— Ninguno —</option>
          {items.map((i) => (
            <option key={i.id} value={i.id}>
              {i.title ?? i.id}
            </option>
          ))}
        </select>
      </label>

      <label className="doc-field">
        Notas
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
        />
      </label>

      <div className="sum-actions">
        <button type="submit" className="sum-action" disabled={busy}>
          {busy ? 'Guardando…' : 'Guardar'}
        </button>
        <button
          type="button"
          className="sum-action"
          onClick={onCancel}
          disabled={busy}
        >
          Cancelar
        </button>
      </div>
    </form>
  )
}
