import type { PackageImport } from '../../domain/types'
import { db } from '../db'
import type { PackageImportRepository } from './types'

export const dexiePackageImportRepository: PackageImportRepository = {
  getById: (id) => db.packageImports.get(id),
  listByTrip: (tripId) =>
    db.packageImports.where('tripId').equals(tripId).toArray(),
  put: (record: PackageImport) =>
    db.packageImports.put(record).then(() => undefined),
  delete: (id) => db.packageImports.delete(id),
}
