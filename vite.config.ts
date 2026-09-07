import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

/** Production URL path — Tool4Trip serves at domain root. */
export const APP_BASE = '/'

export default defineConfig({
  base: APP_BASE,
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: [
        'favicon.svg',
        'icons/apple-touch-icon.png',
        'icons/pwa-192x192.png',
        'icons/pwa-512x512.png',
        'icons/pwa-512x512-maskable.png',
      ],
      manifest: {
        id: '/',
        name: 'Tool4Trip',
        short_name: 'Tool4Trip',
        description:
          'Organizador personal de viajes — fuente operativa offline',
        theme_color: '#1a3a4a',
        background_color: '#f4f0e8',
        display: 'standalone',
        orientation: 'portrait-primary',
        lang: 'es',
        dir: 'ltr',
        start_url: '/',
        scope: '/',
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
        globPatterns: [
          '**/*.{js,css,html,ico,png,svg,woff2,webmanifest}',
        ],
        navigateFallback: '/index.html',
        // App navigations only — leave /api/* and /login to the network.
        navigateFallbackDenylist: [/^\/api\//, /^\/login$/, /^\/logout$/],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
})
