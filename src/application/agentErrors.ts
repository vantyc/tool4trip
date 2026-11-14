/** Friendly agent errors for the PWA — never dump raw Zod JSON to the user. */
export function formatProposalValidationUserError(raw: string): string {
  if (/Datetime debe ser ISO|ISO 8601 con offset/i.test(raw)) {
    return 'No se pudo armar la propuesta: algunas fechas u horas vinieron mal formadas. Puedes pulsar Reintentar sin perder el texto.'
  }
  if (/ungrounded|evidence|sourceUrl/i.test(raw)) {
    return 'No se pudo verificar alguna afirmación con las fuentes disponibles. Puedes pulsar Reintentar.'
  }
  if (/JSON inválido|invalid_proposal|Zod|safeParse/i.test(raw)) {
    return 'No se pudo armar la propuesta (formato incompleto). Puedes pulsar Reintentar sin perder el texto.'
  }
  const oneLine = raw.replace(/\s+/g, ' ').trim()
  if (oneLine.length > 180) return `${oneLine.slice(0, 177)}…`
  return oneLine || 'No se pudo armar la propuesta. Puedes pulsar Reintentar.'
}

export function formatAgentCaughtError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return formatProposalValidationUserError(raw)
}
