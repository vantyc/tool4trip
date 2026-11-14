import { useSyncExternalStore } from 'react'
import { isReadOnly, subscribeAccess } from '../data/access'

export function useReadOnly(): boolean {
  return useSyncExternalStore(subscribeAccess, isReadOnly, () => false)
}
