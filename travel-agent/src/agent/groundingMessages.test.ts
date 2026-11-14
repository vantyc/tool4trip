import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ToolTraceEntry } from '../../shared/agentContracts.ts'
import { validateClaimsAgainstToolTrace } from './claims.ts'

const URL = 'https://villa-alba.example/programa-2026'
const trace: ToolTraceEntry[] = [
  {
    tool: 'fetchUrl',
    args: { url: URL },
    ok: true,
    sources: [{ url: URL, snippet: 'Serenata en Villa Alba el 7 de octubre de 2026 en la plaza principal.' }],
    checkedAt: '2026-09-28T18:01:00+00:00',
  },
]
const claim = (statement: string) => ({
  kind: 'other_factual' as const,
  statement,
  sourceType: 'web' as const,
  sourceUrl: URL,
  evidenceIndex: 0,
  verificationStatus: 'verified' as const,
  confidence: 'high' as const,
})

describe('status-word grounding message (e8dfc667)', () => {
  it('an unsupported "confirmada" is rejected without the unrelated flight hint', () => {
    const r = validateClaimsAgainstToolTrace([claim('Serenata confirmada en Villa Alba el 7 de octubre de 2026.')], trace)
    assert.equal(r.valid.length, 0)
    assert.equal(r.invalid[0]?.code, 'status_ungrounded')
    assert.match(r.invalid[0]!.message, /\[confirmada\]/)
    assert.doesNotMatch(r.invalid[0]!.message, /0 salidas/)
  })

  it('a suspension claim keeps the "0 salidas" hint', () => {
    const r = validateClaimsAgainstToolTrace([claim('Serenata suspendida en Villa Alba el 7 de octubre de 2026.')], trace)
    assert.equal(r.invalid[0]?.code, 'status_ungrounded')
    assert.match(r.invalid[0]!.message, /"0 salidas" does not imply suspensión/)
  })
})
