import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  forceUserSuppliedProvenance,
  resolveOperationFromIntent,
} from './componentAction.ts'

describe('componentAction gates', () => {
  it('EDIT provenance gate strips verified + sourceUrl', () => {
    const { after, provenance, history } = forceUserSuppliedProvenance(
      {
        title: 'Vuelo',
        startAt: '2026-09-19T19:40:00-06:00',
        verificationStatus: 'verified',
        sourceType: 'agent',
        sourceUrl: 'https://example.com/x',
      },
      ['startAt'],
      'mi vuelo sale a las 19:40',
    )
    assert.equal(after.verificationStatus, 'unverified')
    assert.equal(after.sourceType, 'manual')
    assert.equal(after.sourceUrl, undefined)
    assert.equal(provenance.sourceType, 'manual')
    assert.equal(history.event, 'user_edit')
  })

  it('intent mapping is structural not regex', () => {
    assert.equal(resolveOperationFromIntent('verify', 'EDIT'), 'VERIFY')
    assert.equal(
      resolveOperationFromIntent('find_alternative', 'EDIT'),
      'RESEARCH_REPLAN',
    )
  })
})
