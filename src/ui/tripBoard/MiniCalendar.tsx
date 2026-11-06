const MONTHS = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
]
const WEEKDAYS = ['lu', 'ma', 'mi', 'ju', 'vi', 'sá', 'do']

export type DayRange = { from: string; to: string }

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function todayLocal(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function inRange(day: string, r?: DayRange): boolean {
  return Boolean(r && day >= r.from && day <= r.to)
}

/** Months (year, month 1-12) touched by the range, in order. */
function monthsOf(r: DayRange): Array<[number, number]> {
  const out: Array<[number, number]> = []
  let y = Number(r.from.slice(0, 4))
  let m = Number(r.from.slice(5, 7))
  const endY = Number(r.to.slice(0, 4))
  const endM = Number(r.to.slice(5, 7))
  while ((y < endY || (y === endY && m <= endM)) && out.length < 3) {
    out.push([y, m])
    m += 1
    if (m > 12) {
      m = 1
      y += 1
    }
  }
  return out
}

function Month({
  year,
  month,
  mark,
  maybe,
  trip,
  limit,
  today,
  markLabel,
}: {
  year: number
  month: number
  mark?: DayRange
  maybe?: DayRange
  trip?: DayRange
  limit?: string
  today: string
  markLabel: string
}) {
  const first = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const cells: Array<number | null> = [...Array<null>(first).fill(null)]
  for (let d = 1; d <= days; d++) cells.push(d)
  while (cells.length % 7) cells.push(null)
  const weeks: Array<Array<number | null>> = []
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))

  return (
    <table className="tb-cal">
      <caption>
        {MONTHS[month - 1]} {year}
      </caption>
      <thead>
        <tr>
          {WEEKDAYS.map((w) => (
            <th key={w} scope="col">
              {w}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {weeks.map((week, i) => (
          <tr key={i}>
            {week.map((d, j) => {
              if (d === null) return <td key={j} />
              const iso = `${year}-${pad(month)}-${pad(d)}`
              const marked = inRange(iso, mark)
              const cls = [
                marked && 'tb-cal-mark',
                marked && iso === mark!.from && 'tb-cal-start',
                marked && iso === mark!.to && 'tb-cal-end',
                !marked && inRange(iso, maybe) && 'tb-cal-maybe',
                !marked && inRange(iso, trip) && 'tb-cal-trip',
                iso === limit && 'tb-cal-limit',
                iso === today && 'tb-cal-today',
              ]
                .filter(Boolean)
                .join(' ')
              const notes = [
                marked && markLabel,
                !marked && inRange(iso, maybe) && 'fechas posibles',
                iso === limit && 'límite de regreso',
                iso === today && 'hoy',
              ].filter(Boolean)
              return (
                <td key={j} className={cls || undefined} title={notes.join(' · ') || undefined}>
                  <span>{d}</span>
                </td>
              )
            })}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** Month grid that marks a stop's days against the rest of the trip. */
export function MiniCalendar({
  mark,
  maybe,
  trip,
  limit,
  markLabel,
  bare = false,
}: {
  mark?: DayRange
  maybe?: DayRange
  trip?: DayRange
  limit?: string
  markLabel: string
  /** Without its own frame, for use inside another card. */
  bare?: boolean
}) {
  const focus = mark && maybe
    ? { from: mark.from < maybe.from ? mark.from : maybe.from, to: mark.to > maybe.to ? mark.to : maybe.to }
    : (mark ?? maybe)
  if (!focus) return null
  const today = todayLocal()
  const months = monthsOf(focus)
  const showToday = months.some(([y, m]) => today.startsWith(`${y}-${pad(m)}`))
  return (
    <figure className={`tb-cal-wrap${bare ? ' tb-cal-bare' : ''}`} aria-label={`Calendario: ${markLabel}`}>
      {months.map(([y, m]) => (
        <Month
          key={`${y}-${m}`}
          year={y}
          month={m}
          mark={mark}
          maybe={maybe}
          trip={trip}
          limit={limit}
          today={today}
          markLabel={markLabel}
        />
      ))}
      <figcaption className="tb-cal-legend">
        {mark && (
          <span>
            <i className="tb-cal-key tb-cal-key-mark" /> {markLabel}
          </span>
        )}
        {maybe && (
          <span>
            <i className="tb-cal-key tb-cal-key-maybe" /> por definir
          </span>
        )}
        {trip && (
          <span>
            <i className="tb-cal-key tb-cal-key-trip" /> viaje
          </span>
        )}
        {limit && (
          <span>
            <i className="tb-cal-key tb-cal-key-limit" /> límite
          </span>
        )}
        {showToday && (
          <span>
            <i className="tb-cal-key tb-cal-key-today" /> hoy
          </span>
        )}
      </figcaption>
    </figure>
  )
}
