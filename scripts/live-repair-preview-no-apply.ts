/**
 * FINAL LIVE REPAIR preview — Ask Travel + compileMutationPlan, NO Apply.
 * Trip: bd4d0e9a-b5df-4dbc-bb7e-ce6f869aae28
 */
import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { compileMutationPlan } from '../trip-api/src/compileMutationPlan.ts'
import type { TravelOption, Trip } from '../trip-api/src/domainTypes.ts'
import type { TripPackageV1 } from '../trip-api/src/tripPackage.ts'
import type { AgentOpRecord } from '../shared/agentContracts.ts'

const TRIP_ID = 'bd4d0e9a-b5df-4dbc-bb7e-ce6f869aae28'

const PROMPT = `Revisa este mismo viaje después del cambio de fechas al 25–28 de septiembre.

Las opciones de vuelo correspondientes al 20, 21 y 22 de septiembre pertenecen al itinerario anterior y ya no deben formar parte de este viaje.

Conserva los vuelos actuales del 25 y 28 de septiembre y toda la información vigente que siga siendo válida.

No crees otro viaje.

Antes de aplicar cualquier cambio, muéstrame claramente qué propones modificar.`

function kubectlJson(path: string): unknown {
  const out = execSync(
    `kubectl -n tool4trip exec deploy/trip-api -- wget -qO- "http://127.0.0.1:8080${path}"`,
    { encoding: 'utf8', maxBuffer: 20_000_000 },
  )
  return JSON.parse(out)
}

function tripFingerprint() {
  const trip = kubectlJson(`/api/trips/${TRIP_ID}`) as Record<string, unknown>
  const opts = kubectlJson(
    `/api/trips/${TRIP_ID}/travel-options`,
  ) as Array<Record<string, unknown>>
  const sorted = [...opts].sort((a, b) =>
    String(a.externalId ?? a.id).localeCompare(String(b.externalId ?? b.id)),
  )
  return {
    tripUpdatedAt: trip.updatedAt ?? null,
    startDate: trip.startDate,
    endDate: trip.endDate,
    optionCount: opts.length,
    optionIds: sorted.map((o) => ({
      id: o.id,
      externalId: o.externalId,
      type: o.type,
      startAt: o.startAt ?? null,
      sourceType: o.sourceType ?? null,
      updatedAt: o.updatedAt ?? null,
    })),
    optionUpdatedAts: sorted.map((o) => String(o.updatedAt ?? '')).join('|'),
  }
}

function buildContext() {
  return {
    trip: kubectlJson(`/api/trips/${TRIP_ID}`),
    travelOptions: kubectlJson(`/api/trips/${TRIP_ID}/travel-options`),
    itineraryItems: kubectlJson(`/api/trips/${TRIP_ID}/itinerary-items`),
    checklistItems: kubectlJson(`/api/trips/${TRIP_ID}/checklist-items`),
    notes: kubectlJson(`/api/trips/${TRIP_ID}/notes`),
    bookings: kubectlJson(`/api/trips/${TRIP_ID}/bookings`),
    packageImports: kubectlJson(`/api/trips/${TRIP_ID}/package-imports`),
  }
}

function postAsk(body: unknown): { jobId: string } {
  const payload = JSON.stringify(body).replace(/'/g, `'\\''`)
  const out = execSync(
    `kubectl -n tool4trip exec deploy/travel-agent -- sh -c 'wget -qO- --header="Content-Type: application/json" --post-data='"'"'${payload}'"'"' http://127.0.0.1:8080/api/agent/ask'`,
    { encoding: 'utf8', maxBuffer: 5_000_000 },
  )
  return JSON.parse(out) as { jobId: string }
}

function getJob(jobId: string): Record<string, unknown> {
  const out = execSync(
    `kubectl -n tool4trip exec deploy/travel-agent -- wget -qO- "http://127.0.0.1:8080/api/agent/jobs/${jobId}"`,
    { encoding: 'utf8', maxBuffer: 20_000_000 },
  )
  return JSON.parse(out) as Record<string, unknown>
}

function sleep(ms: number) {
  execSync(`sleep ${Math.ceil(ms / 1000)}`)
}

async function main() {
  const before = tripFingerprint()
  console.error('BEFORE', JSON.stringify(before, null, 2))

  const context = buildContext()
  const askBody = {
    prompt: PROMPT,
    tripId: TRIP_ID,
    locale: 'es-MX',
    mode: 'ask',
    context,
  }

  // Write body to a file inside travel-agent pod to avoid shell escaping issues
  const bodyPath = '/tmp/live-repair-ask-body.json'
  writeFileSync('/tmp/live-repair-ask-body.json', JSON.stringify(askBody))
  execSync(
    `kubectl -n tool4trip cp /tmp/live-repair-ask-body.json $(kubectl -n tool4trip get pod -l app=travel-agent -o jsonpath='{.items[0].metadata.name}'):${bodyPath}`,
    { encoding: 'utf8' },
  )

  const createOut = execSync(
    `kubectl -n tool4trip exec deploy/travel-agent -- sh -c 'wget -qO- --header="Content-Type: application/json" --post-file=${bodyPath} http://127.0.0.1:8080/api/agent/ask'`,
    { encoding: 'utf8', maxBuffer: 5_000_000 },
  )
  const created = JSON.parse(createOut) as { jobId: string }
  console.error('JOB', created.jobId)

  let job: Record<string, unknown> = {}
  const t0 = Date.now()
  while (Date.now() - t0 < 5 * 60_000) {
    sleep(3000)
    job = getJob(created.jobId)
    const st = String(job.status ?? '')
    console.error('status', st, job.error ?? '')
    if (st === 'succeeded' || st === 'failed') break
  }

  if (job.status !== 'succeeded') {
    writeFileSync(
      '/tmp/live-repair-preview-report.json',
      JSON.stringify({ before, job, error: 'ask_failed' }, null, 2),
    )
    console.error('ASK FAILED', JSON.stringify(job, null, 2).slice(0, 4000))
    process.exit(1)
  }

  const proposal = (job.proposal ?? null) as {
    package: TripPackageV1
    ops?: AgentOpRecord[]
    diffSummary?: unknown[]
    narrative?: string
    warnings?: string[]
    proposalId?: string
  } | null

  if (!proposal?.package) {
    writeFileSync(
      '/tmp/live-repair-preview-report.json',
      JSON.stringify({ before, job, error: 'missing_proposal' }, null, 2),
    )
    console.error('MISSING PROPOSAL')
    process.exit(1)
  }

  const currentTrip = kubectlJson(`/api/trips/${TRIP_ID}`) as Trip
  const currentOptions = kubectlJson(
    `/api/trips/${TRIP_ID}/travel-options`,
  ) as TravelOption[]

  const compiled = compileMutationPlan({
    tripId: TRIP_ID,
    currentTrip,
    currentOptions,
    proposedPackage: proposal.package,
    llmOps: proposal.ops ?? [],
  })

  const after = tripFingerprint()

  const report = {
    before,
    userPrompt: PROMPT,
    proposalId: proposal.proposalId ?? null,
    rawProposalPackage: {
      trip: proposal.package?.trip,
      travelOptions: (proposal.package?.travelOptions ?? []).map((o) => ({
        externalId: o.externalId,
        type: o.type,
        title: o.title,
        startAt: o.startAt ?? null,
        endAt: o.endAt ?? null,
        sourceType: o.sourceType ?? null,
        logicalRole: (o as { logicalRole?: string }).logicalRole ?? null,
        status: o.status,
      })),
      itineraryCount: proposal.package?.itineraryItems?.length ?? 0,
      noteCount: proposal.package?.notes?.length ?? 0,
    },
    rawLlmOps: proposal.ops ?? [],
    userVisibleDiff: proposal.diffSummary ?? [],
    narrative: proposal.narrative ?? null,
    warnings: proposal.warnings ?? [],
    canonicalMutationPlan: {
      status: compiled.status,
      conflicts: compiled.conflicts,
      ops: compiled.ops,
      packageTravelOptions: compiled.package.travelOptions.map((o) => ({
        externalId: o.externalId,
        type: o.type,
        title: o.title,
        startAt: o.startAt ?? null,
        sourceType: o.sourceType ?? null,
        logicalRole: (o as { logicalRole?: string }).logicalRole ?? null,
      })),
    },
    after,
    previewNonMutation: {
      tripUpdatedAtSame: before.tripUpdatedAt === after.tripUpdatedAt,
      optionCountSame: before.optionCount === after.optionCount,
      optionIdsSame:
        JSON.stringify(before.optionIds.map((o) => o.id)) ===
        JSON.stringify(after.optionIds.map((o) => o.id)),
      optionUpdatedAtsSame: before.optionUpdatedAts === after.optionUpdatedAts,
    },
  }

  writeFileSync(
    '/tmp/live-repair-preview-report.json',
    JSON.stringify(report, null, 2),
  )
  console.log(JSON.stringify(report, null, 2))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
