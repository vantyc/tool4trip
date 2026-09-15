import { httpRepositories } from '../data/repositories/httpRepositories'
import { createServices } from './services'

/** Cloud SoT (trip-api). Documents still use Dexie via httpRepositories.documents. */
export const services = createServices(httpRepositories)
