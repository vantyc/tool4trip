/**
 * Document title while printing: browsers use it as the default PDF file
 * name, so it carries the trip and the moment and avoids path characters.
 */
export function printDocumentTitle(subject: string, now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())}`
  const clean = subject
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .trim()
  return ['Tool4Trip', clean, stamp].filter(Boolean).join(' - ')
}
