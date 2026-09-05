import { localRepositories } from '../data/repositories'
import { createServices } from './services'

export const services = createServices(localRepositories)
