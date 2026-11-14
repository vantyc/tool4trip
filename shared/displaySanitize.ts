/**
 * Strip disallowed C0/DEL controls for safe UI display.
 * Preserves tab / LF / CR. Mirrors trip-api postgresSanitize policy.
 */

function isAllowedControl(codePoint: number): boolean {
  return codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d
}

function isDisallowedControl(codePoint: number): boolean {
  if (codePoint === 0x7f) return true
  if (codePoint <= 0x1f) return !isAllowedControl(codePoint)
  return false
}

/** Remove disallowed controls from a string (safe for React text nodes). */
export function stripDisallowedControlsForDisplay(s: string): string {
  let out = ''
  for (const ch of s) {
    const cp = ch.codePointAt(0)!
    if (cp === 0) continue
    if (isDisallowedControl(cp)) continue
    out += ch
  }
  return out
}

/** Coerce unknown to display string without control chars. */
export function safeDisplayText(
  value: unknown,
  emptyFallback = '—',
): string {
  if (value === undefined || value === null) return emptyFallback
  const s = String(value)
  if (!s) return emptyFallback
  return stripDisallowedControlsForDisplay(s)
}
