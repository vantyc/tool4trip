import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  IDB_DATABASE_NAME,
  IDB_SCHEMA_VERSION,
} from '../src/data/db.ts'
import { APP_BASE } from '../vite.config.ts'

export interface PwaCheck {
  name: string
  pass: boolean
  detail: string
}

/**
 * PWA / base-path / IndexedDB stability checks.
 * Dist checks run when `dist/` exists (after `npm run build`).
 */
export function validatePwaInvariants(): {
  ok: boolean
  checks: PwaCheck[]
} {
  const checks: PwaCheck[] = []
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

  function assert(name: string, pass: boolean, detail: string) {
    checks.push({ name, pass, detail })
  }

  assert('base path', APP_BASE === '/travel/', `base=${APP_BASE}`)
  assert('idb name stable', IDB_DATABASE_NAME === 'viajes_db', IDB_DATABASE_NAME)
  assert(
    'idb schema versioned',
    IDB_SCHEMA_VERSION >= 1,
    `v=${IDB_SCHEMA_VERSION}`,
  )

  const indexHtml = readFileSync(resolve(root, 'index.html'), 'utf8')
  assert(
    'viewport-fit cover',
    indexHtml.includes('viewport-fit=cover'),
    'iPhone safe-area',
  )
  assert(
    'apple touch icon link',
    indexHtml.includes('apple-touch-icon'),
    'apple-touch-icon present',
  )

  const icons = [
    'public/icons/pwa-192x192.png',
    'public/icons/pwa-512x512.png',
    'public/icons/apple-touch-icon.png',
  ]
  for (const icon of icons) {
    assert(`icon ${icon}`, existsSync(resolve(root, icon)), icon)
  }

  const distManifest = resolve(root, 'dist/manifest.webmanifest')
  const distIndex = resolve(root, 'dist/index.html')
  const distSw = resolve(root, 'dist/sw.js')

  if (!existsSync(distManifest) || !existsSync(distIndex)) {
    assert(
      'dist present (optional)',
      true,
      'SKIP dist checks — ejecuta npm run build para validar manifest/SW',
    )
    return { ok: checks.every((c) => c.pass), checks }
  }

  const manifest = JSON.parse(readFileSync(distManifest, 'utf8')) as {
    start_url?: string
    scope?: string
    display?: string
    icons?: { src: string }[]
  }

  assert(
    'manifest start_url',
    manifest.start_url === '/travel/' || manifest.start_url === '/travel',
    `start_url=${manifest.start_url}`,
  )
  assert(
    'manifest scope',
    typeof manifest.scope === 'string' && manifest.scope.startsWith('/travel'),
    `scope=${manifest.scope}`,
  )
  assert(
    'manifest display standalone',
    manifest.display === 'standalone',
    `display=${manifest.display}`,
  )
  assert(
    'manifest icons',
    Array.isArray(manifest.icons) && manifest.icons.length >= 2,
    `icons=${manifest.icons?.length}`,
  )

  const builtIndex = readFileSync(distIndex, 'utf8')
  assert(
    'dist assets under /travel/',
    builtIndex.includes('/travel/assets/') ||
      builtIndex.includes('src="/travel/'),
    'hashed assets prefixed',
  )
  assert(
    'no root-only asset href',
    !/src="\/assets\//.test(builtIndex) &&
      !/href="\/assets\//.test(builtIndex),
    'no /assets without /travel',
  )
  assert(
    'manifest link under /travel/',
    builtIndex.includes('/travel/manifest.webmanifest'),
    'manifest href',
  )

  if (existsSync(distSw)) {
    const sw = readFileSync(distSw, 'utf8')
    assert(
      'sw precaches shell',
      sw.includes('index.html') && (sw.includes('.js') || sw.includes('assets')),
      'workbox precache present',
    )
    assert(
      'sw does not delete idb',
      !/deleteDatabase/.test(sw),
      'no IDB wipe in service worker',
    )
    assert(
      'sw navigateFallback /travel/',
      sw.includes('/travel/') || sw.includes('travel'),
      'fallback scoped',
    )
  } else {
    assert('sw.js exists', false, 'dist/sw.js missing')
  }

  return { ok: checks.every((c) => c.pass), checks }
}
