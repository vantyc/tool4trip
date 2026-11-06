import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { LODGING_CANDIDATE_NOTE } from '../../shared/lodgingCandidate.ts'
import { optionDetailLines } from './askTravelProposalView.ts'

describe('Ask Travel preview — option detail lines', () => {
  it('J: a lodging candidate shows phone, address, source and status without opening evidence', () => {
    const lines = optionDetailLines({
      externalId: 'hotel-jardin',
      type: 'lodging',
      title: 'Hotel Jardín',
      phone: '+52 4379640079',
      address: 'Centro, Totatiche, Jalisco',
      sourceUrl: 'https://mexico.pueblosamerica.com/h/hotel-jardin-16',
      status: 'researched',
      verificationStatus: 'unverified',
      notes: LODGING_CANDIDATE_NOTE,
    })
    assert.deepEqual(lines, [
      'Candidato de hospedaje — no reemplaza tu hospedaje actual',
      'Tel: +52 4379640079',
      'Dirección: Centro, Totatiche, Jalisco',
      'Fuente: https://mexico.pueblosamerica.com/h/hotel-jardin-16',
      'Estado: investigado · sin verificar',
    ])
  })

  it('omits lines for missing fields and never labels the current lodging as a candidate', () => {
    const lines = optionDetailLines({
      externalId: 'lodging-totatiche-1',
      type: 'lodging',
      title: 'Hospedaje en Totatiche (estimado)',
      status: 'researched',
      verificationStatus: 'estimated',
    })
    assert.deepEqual(lines, ['Estado: investigado · estimado'])
  })
})
