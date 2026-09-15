import { useParams } from 'react-router-dom'
import { services } from '../../application'
import type { ChecklistItem } from '../../domain/types'
import { useCloudQuery } from '../useCloudQuery'

export function ChecklistPage() {
  const { tripId } = useParams<{ tripId: string }>()

  const { data: items = [], loading, error, reload } = useCloudQuery(
    tripId ? `checklist:${tripId}` : null,
    async () => {
      const list = await services.checklist.listByTrip(tripId!)
      return list.sort((a, b) => a.sortOrder - b.sortOrder)
    },
  )

  async function toggle(item: ChecklistItem) {
    await services.checklist.save({
      ...item,
      status: item.status === 'open' ? 'done' : 'open',
    })
    reload()
  }

  return (
    <section className="page">
      <h2>Checklist</h2>
      {error && <p className="status-bad">{error.message}</p>}
      {loading ? (
        <p className="muted">Cargando…</p>
      ) : items.length === 0 ? (
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
