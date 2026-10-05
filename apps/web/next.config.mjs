// =============================================================================
// Next.js Konfiguration
// =============================================================================

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// P-22/P-13: Begrenzte Worker-Threads laden diese Parser zur Laufzeit als echte
// Node-Module (src/server/util/worker-parser.ts, WORKER_PARSER_PACKAGES). Kein
// statischer Import zeigt sie dem Output-Tracing; Paket und Abhängigkeiten
// gehören deshalb ausdrücklich ins Standalone-Paket. Die Hülle wird beim Build
// aus den package.json-Dateien bestimmt; scripts/verify-standalone-trace.mjs
// lädt die Parser anschließend im Standalone-Paket zur Probe.
const WORKER_PARSER_PACKAGES = ['pdf-lib', 'unpdf', 'mammoth'];

function findPackageDir(name, fromDir) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (path.dirname(dir) === dir) return null;
  }
}

function workerParserTraceIncludes() {
  const packageDirs = new Set();
  const pending = WORKER_PARSER_PACKAGES.map((name) => [name, __dirname]);
  while (pending.length > 0) {
    const [name, fromDir] = pending.pop();
    const dir = findPackageDir(name, fromDir);
    if (!dir || packageDirs.has(dir)) continue;
    packageDirs.add(dir);
    const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    for (const dependency of Object.keys({
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
    })) {
      pending.push([dependency, dir]);
    }
  }
  return [...packageDirs]
    .sort()
    .map((dir) => `${path.relative(__dirname, dir).split(path.sep).join('/')}/**/*`);
}

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
  // conservative. This route used to launch pg_dump; since P-22 it only
  // enqueues the worker job backup-run. The exclusions stay as a leak guard:
  // source/config/backup data must never be traced for it. A post-build
  // verifier guards this contract against future broadening.
  outputFileTracingIncludes: {
    '/**': workerParserTraceIncludes(),
  },
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

  // Workspace-Pakete exportieren TypeScript-Quellen. Auch die von pnpm unter
  // node_modules injizierten Kopien müssen für den Produktionsbuild durch
  // Next.js transpiliert werden. Die Liste gegen die Runtime-Manifeste prüfen.
  transpilePackages: [
    '@taxtronik/config',
    '@taxtronik/crypto',
    '@taxtronik/db',
    '@taxtronik/elster',
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
  // P-22: dasselbe gilt für die Textextraktion (unpdf für PDF, mammoth für
  // DOCX), die in einem begrenzten Worker-Thread läuft; P-13 zählt PDF-Seiten
  // von Ausweisquellen ebenso mit pdf-lib. Tracing: WORKER_PARSER_PACKAGES oben.
  serverExternalPackages: ['pdfkit', 'pdf-lib', 'unpdf', 'mammoth'],

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
