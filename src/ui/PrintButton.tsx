import { printDocumentTitle } from '../application/printTitle'

type PrintButtonProps = {
  /** Trip title or subject for the PDF file name. */
  subject: string
  /** Container whose collapsed sections (<details>) are expanded for printing. */
  scopeSelector?: string
  disabled?: boolean
}

/**
 * Opens the browser print dialog ("Guardar como PDF") for the proposal.
 * Collapsed sections are expanded only while printing.
 */
export function PrintButton({
  subject,
  scopeSelector = '.agent-proposal',
  disabled,
}: PrintButtonProps) {
  function handlePrint() {
    const closed = Array.from(
      document.querySelectorAll<HTMLDetailsElement>(`${scopeSelector} details`),
    ).filter((d) => !d.open)
    for (const d of closed) d.open = true
    const previousTitle = document.title
    document.title = printDocumentTitle(subject)
    const restore = () => {
      window.removeEventListener('afterprint', restore)
      for (const d of closed) d.open = false
      document.title = previousTitle
    }
    window.addEventListener('afterprint', restore)
    window.print()
  }

  return (
    <button
      type="button"
      className="no-print"
      onClick={handlePrint}
      disabled={disabled}
    >
      Exportar PDF
    </button>
  )
}
