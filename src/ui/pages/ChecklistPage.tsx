import { useLiveQuery } from 'dexie-react-hooks'
import { useParams } from 'react-router-dom'
import { services } from '../../application'
import type { ChecklistItem } from '../../domain/types'

export function ChecklistPage() {
  const { tripId } = useParams<{ tripId: string }>()

  const items =
    useLiveQuery(async () => {
      if (!tripId) return []
      const list = await services.checklist.listByTrip(tripId)
      return list.sort((a, b) => a.sortOrder - b.sortOrder)
    }, [tripId]) ?? []

  async function toggle(item: ChecklistItem) {
    await services.checklist.save({
      ...item,
      status: item.status === 'open' ? 'done' : 'open',
    })
  }

  return (
    <section className="page">
      <h2>Checklist</h2>
      {items.length === 0 ? (
        <p className="muted">Vacío.</p>
      ) : (
        <ul className="check-list">
          {items.map((item) => (
            <li key={item.id}>
              <label>
                <input
                  type="checkbox"
                  checked={item.status === 'done'}
                  onChange={() => void toggle(item)}
                />
                <span className={item.status === 'done' ? 'done' : undefined}>
                  {item.label}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
