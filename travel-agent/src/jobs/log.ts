/** Structured job logs — never include secrets or full prompts. */
export function logJobEvent(
  event: string,
  fields: Record<string, string | number | boolean | null | undefined>,
): void {
  const payload: Record<string, unknown> = {
    ts: new Date().toISOString(),
    event,
  }
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue
    payload[k] = v
  }
  console.log(JSON.stringify(payload))
}
