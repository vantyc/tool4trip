import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

/** Production URL path — must stay in sync with k8s Ingress (/travel/). */
export const APP_BASE = '/travel/'

export default defineConfig({
  base: APP_BASE,
  plugins: [
    react(),
    VitePWA({
      // Precache new assets; activate when possible. Does NOT touch IndexedDB.
      registerType: 'autoUpdate',
      includeAssets: [
        'favicon.svg',
        'icons/apple-touch-icon.png',
        'icons/pwa-192x192.png',
        'icons/pwa-512x512.png',
        'icons/pwa-512x512-maskable.png',
      ],
      manifest: {
        id: APP_BASE,
        name: 'Viajes',
        short_name: 'Viajes',
        description:
          'Organizador personal de viajes — fuente operativa offline',
        theme_color: '#1a3a4a',
        background_color: '#f4f0e8',
        display: 'standalone',
        orientation: 'portrait-primary',
        lang: 'es',
        dir: 'ltr',
        start_url: APP_BASE,
        scope: APP_BASE,
        icons: [
          {
            src: 'icons/pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'icons/pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'icons/pwa-512x512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
          {
            src: 'favicon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any',
          },
        ],
      },
      workbox: {
        // App shell only — never cache document Blobs (those live in IndexedDB).
        globPatterns: [
          '**/*.{js,css,html,ico,png,svg,woff2,webmanifest}',
        ],
        navigateFallback: `${APP_BASE}index.html`,
        // Only SPA routes under /travel/ — ignore other hosts/paths.
        navigateFallbackAllowlist: [/^\/travel\//],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        // No runtimeCaching for maps/CDN/APIs — offline = precache + IndexedDB.
      },
      devOptions: {
        // Keep SW off in plain `vite` dev unless explicitly enabled.
        enabled: false,
      },
    }),
  ],
})
