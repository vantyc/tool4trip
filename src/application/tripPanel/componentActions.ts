import type { TripPanelCardKind } from './types'

export type CardActionIntent = 'adjust' | 'verify' | 'find_alternative'

const CAPABILITIES: Record<
  TripPanelCardKind,
  readonly CardActionIntent[]
> = {
  flight_out: ['adjust', 'verify', 'find_alternative'],
  flight_return: ['adjust', 'verify', 'find_alternative'],
  ground: ['adjust', 'verify', 'find_alternative'],
  lodging: ['adjust', 'verify', 'find_alternative'],
  activity: ['adjust', 'verify'],
  checklist: ['adjust'],
  note: ['adjust'],
  source: [],
  missing_slot: ['adjust', 'find_alternative'],
}

export function actionsForCardKind(
  kind: TripPanelCardKind,
): readonly CardActionIntent[] {
  return CAPABILITIES[kind] ?? []
}

export const ACTION_LABEL: Record<CardActionIntent, string> = {
  adjust: 'Ajustar',
  verify: 'Verificar',
  find_alternative: 'Buscar alternativa',
}
