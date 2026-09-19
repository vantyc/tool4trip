import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { PackageImport, TravelOption } from '../domain/types'
import type { Repositories } from '../data/repositories/types'
import { createPackageImportService } from './packageImport.ts'
import { optionEntityId } from './tripPackage.ts'

describe('planImport preview probes', () => {
  it('new package: one package lookup, zero travel-option GETs', async () => {
    let packageGets = 0
    let optionGets = 0
    const repos = {
      packageImports: {
        getById: async () => {
          packageGets += 1
          return undefined
        },
      },
      travelOptions: {
        getById: async () => {
          optionGets += 1
          return undefined
        },
      },
    } as unknown as Repositories

    const svc = createPackageImportService(repos)
    const plan = await svc.planImport({
      schemaVersion: 1,
      packageId: 'new-pkg-1',
      revision: 1,
      trip: {
        id: 'trip-1',
        title: 'Nuevo',
        startDate: '2026-09-19',
        endDate: '2026-09-22',
        timezone: 'America/Mexico_City',
        goals: [],
        status: 'planned',
      },
      travelOptions: [
        {
          externalId: 'flt-out',
          type: 'flight',
          status: 'researched',
          title: 'MEX-GDL',
          sourceType: 'agent',
        },
        {
          externalId: 'lodge-1',
          type: 'lodging',
          status: 'researched',
          title: 'Hotel',
          sourceType: 'agent',
        },
      ],
      itineraryItems: [],
      checklistItems: [],
      notes: [],
    })

    assert.equal(plan.isUpdate, false)
    assert.equal(plan.created, 2)
    assert.equal(plan.updated, 0)
    assert.equal(packageGets, 1)
    assert.equal(optionGets, 0)
  })

  it('existing package: probes each option id', async () => {
    const packageId = 'pkg-existing'
    const optId = optionEntityId(packageId, 'flt-out')
    let optionGets = 0
    const existingOpt = {
      id: optId,
      tripId: 'trip-1',
      type: 'flight',
      status: 'researched',
      title: 'MEX-GDL',
      sourceType: 'agent',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      syncStatus: 'synced',
    } as TravelOption

    const repos = {
      packageImports: {
        getById: async () =>
          ({
            id: packageId,
            tripId: 'trip-1',
            title: 'Existing',
            importedAt: '2026-01-01T00:00:00Z',
            optionCount: 1,
            schemaVersion: 1,
            revision: 1,
          }) as PackageImport,
      },
      travelOptions: {
        getById: async (id: string) => {
          optionGets += 1
          return id === optId ? existingOpt : undefined
        },
      },
    } as unknown as Repositories

    const svc = createPackageImportService(repos)
    const plan = await svc.planImport({
      schemaVersion: 1,
      packageId,
      revision: 2,
      trip: {
        id: 'trip-1',
        title: 'Existing',
        startDate: '2026-09-19',
        endDate: '2026-09-22',
        timezone: 'America/Mexico_City',
        goals: [],
        status: 'planned',
      },
      travelOptions: [
        {
          externalId: 'flt-out',
          type: 'flight',
          status: 'researched',
          title: 'MEX-GDL updated',
          sourceType: 'agent',
        },
        {
          externalId: 'lodge-new',
          type: 'lodging',
          status: 'researched',
          title: 'New lodge',
          sourceType: 'agent',
        },
      ],
      itineraryItems: [],
      checklistItems: [],
      notes: [],
    })

    assert.equal(plan.isUpdate, true)
    assert.equal(plan.created, 1)
    assert.equal(plan.updated, 1)
    assert.equal(optionGets, 2)
  })
})
