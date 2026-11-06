import { useState } from 'react'
import { services } from '../../application'
import { componentActionAgent } from '../../application/agentClient'
import type { TripPanelCard } from '../../application/tripPanel'
import {
  buildRelatedSnapshots,
  cardComponentType,
  optionToSnapshot,
  persistedToPackage,
} from '../../application/tripPanel/componentActionContext'
import type { CardActionIntent } from '../../application/tripPanel/componentActions'
import {
  buildPromotePreview,
  mergeComponentActionIntoPackage,
  StaleRevisionError,
} from '../../application/tripPanel/mergeComponentAction'
import { buildTripContextSnapshot } from '../../application/tripContextSnapshot'
import { httpRepositories } from '../../data/repositories/httpRepositories'
import type { Trip } from '../../domain/types'
import type { ComponentActionResult } from '../../../shared/agentContracts'
import type { ComponentActionControlsProps } from './ComponentActionControls'

/** Agent card actions (verify, find alternative, adjust) on persisted options. */
export function useCardActions(trip: Trip, onApplied: () => void) {
  const [actionBusyId, setActionBusyId] = useState<string | null>(null)
  const [pendingByCard, setPendingByCard] = useState<
    Record<string, ComponentActionResult>
  >({})
  const [actionError, setActionError] = useState<string | null>(null)

  async function loadActionContext() {
    const [options, itinerary, imports] = await Promise.all([
      services.travelOptions.listByTrip(trip.id),
      services.itinerary.listByTrip(trip.id),
      httpRepositories.packageImports.listByTrip(trip.id),
    ])
    const rev =
      imports.length > 0
        ? Math.max(...imports.map((i) => i.revision || 1))
        : 1
    const packageId = imports[0]?.id ?? `persisted-${trip.id}`
    return { options, itinerary, revision: rev, packageId }
  }

  async function runCardAction(
    card: TripPanelCard,
    intent: CardActionIntent,
    instruction?: string,
  ) {
    const componentId = card.externalId || card.id
    setActionError(null)
    setActionBusyId(componentId)
    try {
      const { options, itinerary, revision } = await loadActionContext()
      const opt = options.find(
        (o) => (o.externalId ?? o.id) === componentId || o.id === card.id,
      )
      if (!opt) throw new Error('Opción no encontrada en el viaje')
      const context = await buildTripContextSnapshot(httpRepositories, trip.id)
      const result = await componentActionAgent(services, {
        tripId: trip.id,
        prompt: instruction?.trim() || `[${intent}] ${card.title}`,
        context,
        componentAction: {
          contextSource: 'persisted',
          baseRevision: revision,
          componentId: opt.externalId ?? opt.id,
          entityId: opt.id,
          componentKind: 'travelOption',
          componentType: cardComponentType(card),
          actionIntent: intent,
          instruction: instruction?.trim(),
          snapshot: optionToSnapshot(opt),
          relatedSnapshots: buildRelatedSnapshots(opt, options, itinerary),
          tripHeader: {
            title: trip.title,
            startDate: trip.startDate,
            endDate: trip.endDate,
            timezone: trip.timezone,
            destination: trip.destination,
          },
        },
      })
      setPendingByCard((prev) => ({ ...prev, [componentId]: result }))
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Error de acción')
    } finally {
      setActionBusyId(null)
    }
  }

  async function applyPending(
    card: TripPanelCard,
    opts: {
      acceptedPatchComponentIds: string[]
      acceptedImpactIds: string[]
      acceptedAlternativeIds: string[]
      promoteAlternativeId?: string
    },
  ) {
    const componentId = card.externalId || card.id
    const result = pendingByCard[componentId]
    if (!result) return
    setActionError(null)
    setActionBusyId(componentId)
    try {
      const { options, itinerary, revision, packageId } =
        await loadActionContext()
      const pkg = persistedToPackage({
        trip,
        options,
        itinerary,
        packageId,
        revision,
      })
      const merged = mergeComponentActionIntoPackage(pkg, {
        result,
        acceptedPatchComponentIds: opts.acceptedPatchComponentIds,
        acceptedImpactIds: opts.acceptedImpactIds,
        acceptedAlternativeIds: opts.acceptedAlternativeIds,
        promoteAlternativeId: opts.promoteAlternativeId,
        currentRevision: revision,
      })
      await services.packages.importPackage(merged)
      setPendingByCard((prev) => {
        const n = { ...prev }
        delete n[componentId]
        return n
      })
      onApplied()
    } catch (err) {
      if (err instanceof StaleRevisionError) {
        setActionError(err.message)
      } else {
        setActionError(err instanceof Error ? err.message : 'Error al aplicar')
      }
    } finally {
      setActionBusyId(null)
    }
  }

  function promoteAlternative(card: TripPanelCard, alternativeId: string) {
    const componentId = card.externalId || card.id
    const research = pendingByCard[componentId]
    if (!research) return
    const preview = buildPromotePreview(research, alternativeId)
    setPendingByCard((prev) => ({ ...prev, [componentId]: preview }))
  }

  function getActionProps(
    card: TripPanelCard,
  ): Omit<ComponentActionControlsProps, 'card'> {
    const cid = card.externalId || card.id
    return {
      busy: actionBusyId === cid,
      pendingResult: pendingByCard[cid] ?? null,
      onAction: (intent, instruction) =>
        void runCardAction(card, intent, instruction),
      onPromoteAlternative: (altId) => promoteAlternative(card, altId),
      onAcceptResult: (opts) => {
        const pending = pendingByCard[cid]
        const promoteId = pending?.resultId.includes('-promote-')
          ? pending.alternatives[0]?.provisionalExternalId
          : undefined
        void applyPending(card, {
          ...opts,
          promoteAlternativeId: promoteId,
          acceptedAlternativeIds: promoteId
            ? [...new Set([...opts.acceptedAlternativeIds, promoteId])]
            : opts.acceptedAlternativeIds,
        })
      },
      onCancelResult: () =>
        setPendingByCard((prev) => {
          const n = { ...prev }
          delete n[cid]
          return n
        }),
    }
  }

  return { actionError, getActionProps }
}
