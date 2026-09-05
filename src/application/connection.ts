/**
 * Online / offline helpers — pure, UI-agnostic.
 */

export function getOnlineStatus(): boolean {
  if (typeof navigator === 'undefined') return true
  return navigator.onLine
}

export type ConnectionLabel = 'online' | 'offline'

export function connectionLabel(online: boolean): ConnectionLabel {
  return online ? 'online' : 'offline'
}

export function connectionDisplay(online: boolean): string {
  return online ? 'En línea' : 'Sin conexión'
}
