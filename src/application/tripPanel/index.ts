export {
  buildTripPanelFromPackage,
  buildTripPanelFromProposal,
  buildTripPanelFromPersisted,
  computeTripPanelDiagnostics,
  dedupeDestinations,
  deriveAirportArrival,
  isAirportArrivalActivity,
  normPlace,
} from './buildTripPanel'
export type {
  TripPanelModel,
  TripPanelCard,
  TripPanelDiagnostics,
  TripPanelHeader,
  VisualStatus,
  IntegrityLight,
  AirportArrivalInfo,
} from './types'
export { VISUAL_STATUS_LABEL } from './types'
