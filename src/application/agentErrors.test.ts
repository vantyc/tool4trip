import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  formatAgentCaughtError,
  formatProposalValidationUserError,
} from './agentErrors.ts'

describe('agentErrors', () => {
  it('hides raw Zod datetime dump', () => {
    const raw =
      'AgentProposal JSON inválido tras repair: [ { "code": "custom", "message": "Datetime debe ser ISO 8601 con offset", "path": [ "package", "travelOptions", 3, "startAt" ] } ]'
    const msg = formatProposalValidationUserError(raw)
    assert.match(msg, /fechas u horas/i)
    assert.match(msg, /Reintentar/)
    assert.ok(!/"path"/.test(msg))
  })

  it('formatAgentCaughtError wraps Error', () => {
    const msg = formatAgentCaughtError(
      new Error('AgentProposal JSON inválido tras repair: Zod boom'),
    )
    assert.match(msg, /Reintentar/)
  })
})
