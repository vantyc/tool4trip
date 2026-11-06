import { useState } from 'react'
import type { PlaceMedia } from './placeMedia'

function hue(text: string): number {
  let h = 0
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % 360
  return h
}

/** Drawn stand-in when there is no photo (or no network). */
function Illustration({ label }: { label: string }) {
  const h = hue(label)
  const initials = label
    .split(/\s+/)
    .filter((w) => /^\p{Lu}/u.test(w))
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
  return (
    <svg
      className="tb-illustration"
      viewBox="0 0 160 100"
      preserveAspectRatio="xMidYMid slice"
      role="img"
      aria-label={`Ilustración de ${label}`}
    >
      <defs>
        <linearGradient id={`sky-${h}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={`hsl(${h} 45% 78%)`} />
          <stop offset="1" stopColor={`hsl(${(h + 40) % 360} 40% 90%)`} />
        </linearGradient>
      </defs>
      <rect width="160" height="100" fill={`url(#sky-${h})`} />
      <circle cx="122" cy="28" r="12" fill={`hsl(${(h + 180) % 360} 60% 85%)`} />
      <path
        d="M0 78 L30 52 L52 70 L82 40 L112 66 L134 50 L160 72 L160 100 L0 100 Z"
        fill={`hsl(${h} 30% 45%)`}
        opacity="0.75"
      />
      <path
        d="M0 88 Q40 76 80 86 T160 84 L160 100 L0 100 Z"
        fill={`hsl(${h} 35% 30%)`}
        opacity="0.8"
      />
      <text
        x="14"
        y="34"
        fontSize="22"
        fontFamily="Georgia, serif"
        fontWeight="700"
        fill={`hsl(${h} 40% 25%)`}
      >
        {initials || label.slice(0, 2)}
      </text>
    </svg>
  )
}

export function PlaceImage({
  label,
  media,
  showCredit = false,
}: {
  label: string
  media?: PlaceMedia
  showCredit?: boolean
}) {
  const [failed, setFailed] = useState(false)
  const photo = !failed ? media?.photo : undefined
  return (
    <figure className="tb-photo">
      {photo ? (
        <img
          src={photo}
          alt={label}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <Illustration label={label} />
      )}
      {showCredit && photo && media?.pageUrl && (
        <figcaption className="tb-credit">
          Foto:{' '}
          <a href={media.pageUrl} target="_blank" rel="noreferrer">
            Wikipedia · {media.pageTitle}
          </a>
        </figcaption>
      )}
    </figure>
  )
}
