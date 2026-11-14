import { useEffect, useState } from 'react'
import { Link, Navigate, Route, Routes } from 'react-router-dom'
import { db } from '../data/db'
import { ConnectionIndicator } from '../ui/ConnectionIndicator'
import { AskTravelPage } from '../ui/pages/AskTravelPage'
import { NewTravelPage } from '../ui/pages/NewTravelPage'
import { BookingsPage } from '../ui/pages/BookingsPage'
import { ChecklistPage } from '../ui/pages/ChecklistPage'
import { DocumentsPage } from '../ui/pages/DocumentsPage'
import { ImportResearchPage } from '../ui/pages/ImportResearchPage'
import { ItemDetailPage } from '../ui/pages/ItemDetailPage'
import { ItineraryPage } from '../ui/pages/ItineraryPage'
import { NotesPage } from '../ui/pages/NotesPage'
import { OptionsPage } from '../ui/pages/OptionsPage'
import { TripLayout } from '../ui/pages/TripLayout'
import { TripListPage } from '../ui/pages/TripListPage'
import { TripOverviewPage } from '../ui/pages/TripOverviewPage'
import { ThemeToggle } from '../ui/ThemeToggle'
import { Glyph } from '../ui/tripBoard/Glyph'
import { TripBoardPage } from '../ui/tripBoard/TripBoardPage'
import { useReadOnly } from '../ui/useReadOnly'
import './App.css'

export function App() {
  const [dbReady, setDbReady] = useState(false)
  const [dbError, setDbError] = useState<string | null>(null)
  const readOnly = useReadOnly()

  useEffect(() => {
    document.documentElement.classList.toggle('read-only', readOnly)
  }, [readOnly])

  useEffect(() => {
    let cancelled = false
    void db
      .open()
      .then(() => {
        if (!cancelled) setDbReady(true)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setDbError(
            err instanceof Error ? err.message : 'Error al abrir IndexedDB',
          )
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (dbError) {
    return (
      <div className="app-shell">
        <p className="status-bad">IndexedDB: {dbError}</p>
      </div>
    )
  }

  if (!dbReady) {
    return (
      <div className="app-shell">
        <p className="muted">Abriendo base local…</p>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <Link to="/" className="brand" title="Mis viajes">
          <span className="brand-mark" aria-hidden="true">
            <Glyph name="plane" rotate={45} />
          </span>
          Tool4Trip
        </Link>
        <div className="app-header-meta">
          {readOnly && (
            <span className="read-only-chip" title="Puedes ver este viaje, pero no cambiarlo">
              Solo lectura
            </span>
          )}
          <ThemeToggle />
          <ConnectionIndicator />
          <a className="logout-link" href="/logout">
            Cerrar sesión
          </a>
        </div>
      </header>

      <main className="app-main">
        <Routes>
          <Route path="/" element={<TripListPage />} />
          <Route path="/new" element={readOnly ? <Navigate to="/" replace /> : <NewTravelPage />} />
          <Route path="/ask" element={readOnly ? <Navigate to="/" replace /> : <AskTravelPage />} />
          <Route path="/import" element={readOnly ? <Navigate to="/" replace /> : <ImportResearchPage />} />
          <Route path="/trips/:tripId" element={<TripLayout />}>
            <Route index element={<TripBoardPage />} />
            <Route path="tablero" element={<Navigate to=".." relative="path" replace />} />
            <Route path="detalle" element={<TripOverviewPage />} />
            <Route path="options" element={<OptionsPage />} />
            <Route path="bookings" element={<BookingsPage />} />
            <Route path="itinerary" element={<ItineraryPage />} />
            <Route path="checklist" element={<ChecklistPage />} />
            <Route path="notes" element={<NotesPage />} />
            <Route path="docs" element={<DocumentsPage />} />
            <Route path="items/:itemId" element={<ItemDetailPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  )
}
