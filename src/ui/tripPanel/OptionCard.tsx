import type { TripPanelCard, VisualStatus } from '../../application/tripPanel'
import { VISUAL_STATUS_LABEL } from '../../application/tripPanel'

function formatWhen(iso?: string): string | undefined {
  if (!iso) return undefined
  // Prefer compact local display without inventing
  const m = iso.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/,
  )
  if (m) return `${m[1]} ${m[2]}:${m[3]}`
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso
  return iso
}

function formatPrice(price?: number, currency?: string): string | undefined {
  if (price === undefined) return undefined
  if (currency) return `${price} ${currency}`
  return String(price)
}

export function StatusBadge({ status }: { status: VisualStatus }) {
  return (
    <span className={`tp-badge tp-badge-${status}`}>
      {VISUAL_STATUS_LABEL[status]}
    </span>
  )
}

export function OptionCard({ card }: { card: TripPanelCard }) {
  const when = formatWhen(card.startAt)
  const until = formatWhen(card.endAt)
  const price = formatPrice(card.price, card.currency)
  const rows: Array<{ label: string; value: string }> = []
  if (when) rows.push({ label: 'Inicio', value: until ? `${when} → ${until}` : when })
  if (card.origin) rows.push({ label: 'Origen', value: card.origin })
  if (card.destination) rows.push({ label: 'Destino', value: card.destination })
  if (card.place) rows.push({ label: 'Lugar', value: card.place })
  if (card.provider) rows.push({ label: 'Proveedor', value: card.provider })
  if (price) rows.push({ label: 'Precio', value: price })
  if (card.sourceUrl) rows.push({ label: 'Fuente', value: card.sourceUrl })
  if (card.body) rows.push({ label: 'Texto', value: card.body })
  if (card.notes) rows.push({ label: 'Notas', value: card.notes })

  return (
    <article className={`tp-card tp-card-${card.status}`}>
      <header className="tp-card-head">
        <h4 className="tp-card-title">{card.title}</h4>
        <StatusBadge status={card.status} />
      </header>
      {rows.length > 0 && (
        <dl className="tp-card-fields">
          {rows.map((r) => (
            <div key={r.label}>
              <dt>{r.label}</dt>
              <dd>
                {r.label === 'Fuente' && card.sourceUrl ? (
                  <a href={card.sourceUrl} target="_blank" rel="noreferrer">
                    {card.sourceUrl}
                  </a>
                ) : (
                  r.value
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </article>
  )
}

export function CardSection({
  title,
  cards,
  emptyLabel,
}: {
  title: string
  cards: TripPanelCard[]
  emptyLabel?: string
}) {
  if (cards.length === 0) {
    if (!emptyLabel) return null
    return (
      <section className="tp-section">
        <h3 className="tp-section-title">{title}</h3>
        <p className="muted tp-empty">{emptyLabel}</p>
      </section>
    )
  }
  return (
    <section className="tp-section">
      <h3 className="tp-section-title">{title}</h3>
      <div className="tp-card-grid">
        {cards.map((c) => (
          <OptionCard key={c.id} card={c} />
        ))}
      </div>
    </section>
  )
}
