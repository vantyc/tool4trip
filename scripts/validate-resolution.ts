import { validateResolutionInvariants } from '../src/seed/validateResolution.ts'
import { validateSummaryInvariants } from '../src/seed/validateSummary.ts'
import { validateDocumentInvariants } from '../src/seed/validateDocuments.ts'
import { validateTripPackageInvariants } from './validate-trip-package.ts'
import { validatePwaInvariants } from './validate-pwa.ts'

function report(
  label: string,
  result: {
    ok: boolean
    checks: { name: string; pass: boolean; detail: string }[]
  },
) {
  console.log(`\n=== ${label} ===`)
  for (const check of result.checks) {
    const mark = check.pass ? 'PASS' : 'FAIL'
    console.log(`[${mark}] ${check.name}: ${check.detail}`)
  }
  return result.ok
}

const okResolution = report('Resolution', validateResolutionInvariants())
const okSummary = report('Summary', validateSummaryInvariants())
const okDocuments = report('Documents', await validateDocumentInvariants())
const okTripPackage = report(
  'TripPackage',
  await validateTripPackageInvariants(),
)
const okPwa = report('PWA', validatePwaInvariants())

if (
  !okResolution ||
  !okSummary ||
  !okDocuments ||
  !okTripPackage ||
  !okPwa
) {
  console.error('\nValidation failed')
  process.exit(1)
}
console.log('\nAll invariants OK')
