import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { services } from '../../application'
import type { Note } from '../../domain/types'

export function NotesPage() {
  const { tripId } = useParams<{ tripId: string }>()
  const [notes, setNotes] = useState<Note[]>([])

  useEffect(() => {
    if (!tripId) return
    let cancelled = false
    function load() {
      void services.notes.listByTrip(tripId!).then((list) => {
        if (!cancelled) setNotes(list)
      })
    }
    load()
    function onVis() {
      if (document.visibilityState === 'visible') load()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [tripId])

  return (
    <section className="page">
      <h2>Notas</h2>
      {notes.length === 0 ? (
        <p className="muted">Sin notas.</p>
      ) : (
        <ul className="entity-list">
          {notes.map((note) => (
            <li key={note.id}>
              {note.title && <div className="entity-title">{note.title}</div>}
              <pre className="note-pre">{note.body}</pre>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
