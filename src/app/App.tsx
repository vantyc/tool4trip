import { useEffect, useState } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { db } from '../data/db'
import { ConnectionIndicator } from '../ui/ConnectionIndicator'
import { AskTravelPage } from '../ui/pages/AskTravelPage'
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
import './App.css'

export function App() {
  const [dbReady, setDbReady] = useState(false)
  const [dbError, setDbError] = useState<string | null>(null)

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
        <div className="app-header-top">
          <p className="brand">Tool4Trip</p>
          <ConnectionIndicator />
        </div>
        <p className="tagline">Fuente operativa de tu viaje</p>
      </header>

      <main className="app-main">
        <Routes>
          <Route path="/" element={<TripListPage />} />
          <Route path="/ask" element={<AskTravelPage />} />
          <Route path="/import" element={<ImportResearchPage />} />
          <Route path="/trips/:tripId" element={<TripLayout />}>
            <Route index element={<TripOverviewPage />} />
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
