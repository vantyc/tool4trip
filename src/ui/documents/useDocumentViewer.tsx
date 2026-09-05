import { useState } from 'react'
import { DocumentViewer } from './DocumentViewer'
import {
  loadDocumentViewerState,
  type ViewerState,
} from './openDocument'

export function useDocumentViewer() {
  const [viewer, setViewer] = useState<ViewerState | null>(null)

  function close() {
    setViewer(null)
  }

  return {
    viewer,
    open: (documentId: string) => {
      void loadDocumentViewerState(documentId).then((state) => {
        if (state) setViewer(state)
      })
    },
    close,
    Viewer: <DocumentViewer open={viewer} onClose={close} />,
  }
}
