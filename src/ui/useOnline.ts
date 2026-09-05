import { useEffect, useState } from 'react'
import { getOnlineStatus } from '../application/connection'

export function useOnline(): boolean {
  const [online, setOnline] = useState(getOnlineStatus)

  useEffect(() => {
    function sync() {
      setOnline(getOnlineStatus())
    }
    window.addEventListener('online', sync)
    window.addEventListener('offline', sync)
    return () => {
      window.removeEventListener('online', sync)
      window.removeEventListener('offline', sync)
    }
  }, [])

  return online
}
