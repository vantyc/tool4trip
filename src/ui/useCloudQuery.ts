import { useCallback, useEffect, useRef, useState } from 'react'
import { useOnline } from './useOnline'

/**
 * Fetch + React state replacement for Dexie useLiveQuery.
 * Refetches on mount, after `reload()` (post-mutation), and on visibilitychange.
 */
export function useCloudQuery<T>(
  key: string | null,
  loader: () => Promise<T>,
  opts?: { enabled?: boolean },
): {
  data: T | undefined
  loading: boolean
  error: Error | null
  reload: () => void
} {
  const online = useOnline()
  const enabled = (opts?.enabled ?? true) && key !== null
  const [data, setData] = useState<T | undefined>(undefined)
  const [loading, setLoading] = useState(Boolean(enabled))
  const [error, setError] = useState<Error | null>(null)
  const [tick, setTick] = useState(0)
  const loaderRef = useRef(loader)
  loaderRef.current = loader

  const reload = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      return
    }
    if (!online) {
      setError(
        new Error('Se requiere conexión para cargar viajes desde la nube.'),
      )
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)
    void loaderRef
      .current()
      .then((result) => {
        if (!cancelled) {
          setData(result)
          setLoading(false)
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)))
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [key, enabled, online, tick])

  useEffect(() => {
    function onVis() {
      if (document.visibilityState === 'visible') reload()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [reload])

  return { data, loading, error, reload }
}
