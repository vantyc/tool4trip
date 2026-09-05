import { services } from '../../application'
import {
  createObjectUrl,
} from '../../application/documents'

export interface ViewerState {
  url: string
  name: string
  mimeType: string
}

export async function loadDocumentViewerState(
  documentId: string,
): Promise<ViewerState | null> {
  const record = await services.documents.getBlob(documentId)
  const meta = await services.documents.get(documentId)
  if (!record || !meta) return null
  return {
    url: createObjectUrl(record.blob),
    name: meta.name,
    mimeType: meta.mimeType,
  }
}
