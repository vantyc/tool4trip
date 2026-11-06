import { GLYPH_PATH, type GlyphName } from './boardFormat'

export function Glyph({
  name,
  rotate = 0,
  size = 18,
}: {
  name: GlyphName
  rotate?: number
  size?: number
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      style={rotate ? { transform: `rotate(${rotate}deg)` } : undefined}
    >
      <path fill="currentColor" d={GLYPH_PATH[name]} />
    </svg>
  )
}
