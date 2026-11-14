/**
 * Researched lodging candidates added next to the trip's current lodging.
 * The compiler writes this note when it adds one; it is how a persisted
 * candidate stays distinguishable from the primary lodging on later edits.
 */
export const LODGING_CANDIDATE_NOTE =
  'Candidato de hospedaje investigado — no seleccionado; no reemplaza el hospedaje actual.'

export function isLodgingCandidateNote(notes: string | null | undefined): boolean {
  return typeof notes === 'string' && notes.includes(LODGING_CANDIDATE_NOTE)
}
