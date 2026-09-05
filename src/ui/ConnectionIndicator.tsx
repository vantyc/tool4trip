import { connectionDisplay } from '../application/connection'
import { useOnline } from './useOnline'

/** Discrete online/offline pill — no large banners. */
export function ConnectionIndicator() {
  const online = useOnline()

  return (
    <p
      className={`connection-pill ${online ? 'is-online' : 'is-offline'}`}
      role="status"
      aria-live="polite"
    >
      <span className="connection-dot" aria-hidden="true" />
      {connectionDisplay(online)}
    </p>
  )
}
