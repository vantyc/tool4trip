/**
 * Implementation validation: MEX→GDL via FlightScheduleProvider + tool path.
 * NOT the spike script.
 *
 * Usage:
 *   set -a && source /tmp/adb-key.env && set +a
 *   npx tsx scripts/validate-flight-schedule-provider.ts
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { AeroDataBoxScheduleProvider } from '../travel-agent/src/flights/aerodatabox.ts'
import { searchFlightSchedules } from '../travel-agent/src/tools/searchFlightSchedules.ts'
import { mergePublishedSchedulesFromTrace } from '../travel-agent/src/flights/mergeSchedules.ts'
import {
  assessResearchGoals,
  deriveResearchGoals,
} from '../travel-agent/src/agent/researchCoverage.ts'
import { buildTripPanelFromPackage } from '../src/application/tripPanel/buildTripPanel.ts'
import type { SharedTripPackageV1 } from '../shared/agentContracts.ts'

function loadKeyFromSecretYaml(): void {
  if (process.env.AERODATABOX_RAPIDAPI_KEY) return
  const p = resolve('k8s/secrets/aerodatabox-secret.yaml')
  if (!existsSync(p)) return
  const text = readFileSync(p, 'utf8')
  const m = text.match(/AERODATABOX_RAPIDAPI_KEY:\s*(\S+)/)
  if (m) process.env.AERODATABOX_RAPIDAPI_KEY = m[1]
}

async function main() {
  loadKeyFromSecretYaml()
  const provider = new AeroDataBoxScheduleProvider()
  const result = await provider.searchSchedules({
    origin: 'MEX',
    destination: 'GDL',
    date: '2026-09-19',
  })
  const carriers = new Set(
    result.flights.map((f) => f.carrierCode).filter(Boolean),
  )
  console.log(
    JSON.stringify(
      {
        via: 'FlightScheduleProvider',
        ok: result.ok,
        elapsedMs: result.elapsedMs,
        httpStatuses: result.httpStatuses,
        count: result.flights.length,
        carriers: [...carriers],
        hasAM: carriers.has('AM'),
        hasY4: carriers.has('Y4'),
        hasVB: carriers.has('VB'),
        sample: result.flights.slice(0, 5).map((f) => ({
          flightNumber: f.flightNumber,
          carrierCode: f.carrierCode,
          departureAt: f.departureAt,
          arrivalAt: f.arrivalAt,
          sourceType: f.sourceType,
        })),
        error: result.error ?? null,
      },
      null,
      2,
    ),
  )

  const tool = await searchFlightSchedules({
    origin: 'MEX',
    destination: 'GDL',
    date: '2026-09-19',
  })
  const basePkg = {
    schemaVersion: 1 as const,
    packageId: 'val-mex-gdl',
    revision: 1,
    trip: {
      id: 't-val',
      title: 'MEX GDL val',
      destination: 'Guadalajara',
      startDate: '2026-09-19',
      endDate: '2026-09-19',
      timezone: 'America/Mexico_City',
      goals: [] as string[],
      status: 'planned' as const,
    },
    travelOptions: [
      {
        externalId: 'flt-out',
        type: 'flight' as const,
        status: 'shortlisted' as const,
        title: 'MEX → GDL',
        origin: 'MEX',
        destination: 'GDL',
        verificationStatus: 'estimated' as const,
        sourceType: 'agent' as const,
      },
    ],
    itineraryItems: [],
    checklistItems: [],
    notes: [],
  }
  const merged = mergePublishedSchedulesFromTrace(basePkg, [tool.trace])
  const opt = (merged.package.travelOptions as Record<string, unknown>[])[0]!
  const goals = deriveResearchGoals(
    'Vuelo MEX a GDL el 19 de septiembre 2026 desde Ciudad de México a Guadalajara',
  )
  const assessed = assessResearchGoals(goals, [tool.trace], {
    package: merged.package,
    tripDates: ['2026-09-19'],
  })
  const flight = assessed.find((g) => g.kind === 'flight_day_specific')
  const panel = buildTripPanelFromPackage(merged.package as SharedTripPackageV1)
  const card = panel.flightsOut[0]
  console.log(
    JSON.stringify(
      {
        toolOk: tool.trace.ok,
        toolFlights:
          (tool.trace.args as { flights?: unknown[] })?.flights?.length ??
          tool.trace.sources?.length,
        mergedSourceType: opt.sourceType,
        mergedStartAt: opt.startAt,
        notesHasHorario: /HORARIO PUBLICADO/.test(String(opt.notes ?? '')),
        flightGoal: flight?.status,
        panelCard: {
          status: card?.status,
          startAt: card?.startAt,
          sourceType: card?.sourceType,
          price: card?.price ?? null,
        },
      },
      null,
      2,
    ),
  )

  if (!result.ok || result.flights.length === 0) {
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
