// =============================================================================
// Next.js Konfiguration
// =============================================================================

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Single Source of Truth: ENVs aus der Repo-Root-.env laden. Verhindert Drift
// zwischen Workspace-.env-Dateien (Next.js würde sonst nur apps/web/.env
// kennen). `override: false` lässt im Process bereits gesetzte Werte (CI,
// Container) Vorrang behalten.
dotenv.config({ path: path.join(__dirname, '../../.env'), override: false });

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone-Output für schlanke Docker-Images (Iter. 7).
  output: 'standalone',
  // Workspace-Root-Tracing: ohne das traced Next.js nur ab apps/web und
  // verpasst Prisma-Engine-Binaries, workspace-Pakete und transitiv
  // gehoistete deps. Mit dieser Option enthält .next/standalone alles,
  // was die App zur Laufzeit braucht — der runner-Stage muss dann
  // nichts mehr aus node_modules separat kopieren.
  outputFileTracingRoot: path.join(__dirname, '../../'),

  // pg_dump is an external operator binary (PATH/PG_DUMP_PATH), not an app
  // asset. Its deliberately configurable process path makes static tracing
  // conservative. Limit that exception to the sole web route that launches
  // pg_dump, and explicitly exclude source/config/backup data that the
  // compiled route never reads at runtime. A post-build verifier guards this
  // contract against future broadening.
  outputFileTracingExcludes: {
    '/api/staff/admin/backups/run': [
      'src/**/*',
      'next.config.mjs',
      'postcss.config.mjs',
      'tailwind.config.ts',
      'tsconfig*.json',
      'tsconfig.tsbuildinfo',
      'turbo.json',
      'vitest.config.ts',
      '../../backups/**/*',
    ],
  },

  // Workspace-Pakete transpilieren. WICHTIG für `output: 'standalone'`:
  // nur was hier steht, landet im production-Bundle.
  transpilePackages: [
    '@taxtronik/config',
    '@taxtronik/crypto',
    '@taxtronik/db',
    '@taxtronik/evidence',
    '@taxtronik/http-utils',
    '@taxtronik/mail',
    '@taxtronik/n8n-shared',
    '@taxtronik/risk-layer',
    '@taxtronik/rss',
    '@taxtronik/storage',
    '@taxtronik/tax',
  ],

  // pdfkit lädt seine Standard-Font-Metriken (.afm) zur Laufzeit aus
  // node_modules — darf NICHT gebündelt werden, sonst fehlen die Fonts.
  // The bounded PDF preflight worker resolves pdf-lib as a real Node module.
  // A bundled-only copy cannot be loaded inside that isolated worker thread.
  serverExternalPackages: ['pdfkit', 'pdf-lib'],

  // Reaktivität strenger.
  reactStrictMode: true,

  // Sicherheits-Header (Defense in Depth).
  async headers() {
    // Die request-spezifische CSP wird im Proxy erzeugt, damit Next.js einen
    // frischen Nonce auf Framework-, RSC- und eigene Inline-Skripte setzen
    // kann. Hier bleiben ausschließlich statische Defense-in-Depth-Header.
    const isDev = process.env.NODE_ENV !== 'production';

    return [
      {
        source: '/identity-assets/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value:
              "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'self'",
          },
          { key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' },
        ],
      },
      {
        source: '/:path*',
        headers: [
          // SAMEORIGIN (nicht DENY): legacy-Pendant zu frame-ancestors 'self'
          // — der eigene Dokument-Viewer-iframe muss Preview-Streams laden
          // dürfen; Fremd-Origins bleiben ausgesperrt.
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          // HSTS NUR in Produktion. Auf dem Dev-HTTP-localhost würde der Header
          // den Browser zwingen, localhost dauerhaft auf HTTPS umzubiegen
          // (Chrome cached HSTS hart, inkl. preload) → der HTTP-Dev-Server wird
          // unerreichbar („kommt nicht rein"). Produktiv läuft die App hinter
          // einem HTTPS-Reverse-Proxy, dort ist HSTS korrekt.
          ...(isDev
            ? []
            : [
                {
                  key: 'Strict-Transport-Security',
                  value: 'max-age=63072000; includeSubDomains; preload',
                },
              ]),
        ],
      },
      // H-3: Magic-Link-/PoA-/GwG-/Audit-Verify-URLs tragen Capability-Tokens
      // im Query-String oder Pfad.
      // `no-referrer` verhindert, dass der Token via Referer-Header an
      // externe Origins leakt (z. B. wenn der User auf einen externen Link
      // klickt oder die Page externe Ressourcen lädt).
      {
        source: '/portal/login/verify/:path*',
        headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }],
      },
      {
        source: '/poa/sign/:path*',
        headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }],
      },
      {
        source: '/gwg-onboarding/:path*',
        headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }],
      },
      {
        source: '/audit-verify/:path*',
        headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }],
      },
    ];
  },

  experimental: {
    serverActions: {
      bodySizeLimit: '10mb',
    },
  },
};

export default nextConfig;
