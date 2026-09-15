/** Thin fetch helpers for trip-api (ForwardAuth cookie, same-origin). */

export class ApiError extends Error {
  readonly status: number
  readonly body: unknown
  constructor(status: number, message: string, body?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

export class OfflineRequiredError extends Error {
  constructor(message = 'Se requiere conexión para gestionar viajes en la nube.') {
    super(message)
    this.name = 'OfflineRequiredError'
  }
}

function assertOnline() {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new OfflineRequiredError()
  }
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export async function apiFetch<T = unknown>(
  path: string,
  init?: RequestInit & { expectUpdatedAt?: string },
): Promise<T> {
  assertOnline()
  const headers = new Headers(init?.headers)
  if (!headers.has('Accept')) headers.set('Accept', 'application/json')
  if (init?.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  if (init?.expectUpdatedAt) {
    headers.set('If-Match', `"${init.expectUpdatedAt}"`)
  }

  const res = await fetch(path, {
    ...init,
    headers,
    credentials: 'same-origin',
  })

  if (res.status === 204) return undefined as T

  const body = await parseBody(res)

  if (res.status === 401) {
    throw new ApiError(401, 'Sesión requerida — vuelve a iniciar sesión.', body)
  }
  if (res.status === 409) {
    throw new ApiError(409, 'Conflicto: el viaje fue modificado en otro dispositivo.', body)
  }
  if (!res.ok) {
    const msg =
      typeof body === 'object' &&
      body !== null &&
      'error' in body &&
      typeof (body as { error: unknown }).error === 'string'
        ? (body as { error: string }).error
        : `Error API (${res.status})`
    throw new ApiError(res.status, msg, body)
  }

  return body as T
}
