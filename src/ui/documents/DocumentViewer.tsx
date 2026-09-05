import { useEffect, useId, useRef } from 'react'
import {
  isImageMime,
  isPdfMime,
  revokeObjectUrl,
} from '../../application/documents'
import type { ViewerState } from './openDocument'

/**
 * In-app viewer: creates Object URL on open, revokes on close.
 * Prefer this over persisting URLs.
 */
export function DocumentViewer({
  open,
  onClose,
}: {
  open: ViewerState | null
  onClose: () => void
}) {
  const titleId = useId()
  const urlRef = useRef<string | null>(null)

  useEffect(() => {
    urlRef.current = open?.url ?? null
    return () => {
      if (urlRef.current) {
        revokeObjectUrl(urlRef.current)
        urlRef.current = null
      }
    }
  }, [open?.url])

  if (!open) return null

  const image = isImageMime(open.mimeType)
  const pdf = isPdfMime(open.mimeType)

  return (
    <div
      className="doc-viewer-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div className="doc-viewer">
        <header className="doc-viewer-header">
          <h2 id={titleId}>{open.name}</h2>
          <button type="button" className="sum-action" onClick={onClose}>
            Cerrar
          </button>
        </header>
        <div className="doc-viewer-body">
          {image && (
            <img src={open.url} alt={open.name} className="doc-preview-img" />
          )}
          {pdf && (
            <iframe
              title={open.name}
              src={open.url}
              className="doc-preview-frame"
            />
          )}
          {!image && !pdf && (
            <p className="muted">
              Vista previa no disponible.{' '}
              <a href={open.url} download={open.name}>
                Descargar
              </a>
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
