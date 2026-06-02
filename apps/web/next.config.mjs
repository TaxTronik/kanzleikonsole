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

  // Workspace-Pakete transpilieren. WICHTIG für `output: 'standalone'`:
  // nur was hier steht, landet im production-Bundle.
  transpilePackages: [
    '@taxtronik/config',
    '@taxtronik/crypto',
    '@taxtronik/db',
    '@taxtronik/evidence',
    '@taxtronik/http-utils',
    '@taxtronik/n8n-shared',
    '@taxtronik/risk-layer',
    '@taxtronik/rss',
    '@taxtronik/storage',
    '@taxtronik/tax',
  ],

  // pdfkit lädt seine Standard-Font-Metriken (.afm) zur Laufzeit aus
  // node_modules — darf NICHT gebündelt werden, sonst fehlen die Fonts.
  serverExternalPackages: ['pdfkit'],

  // Reaktivität strenger.
  reactStrictMode: true,

  // Sicherheits-Header (Defense in Depth).
  async headers() {
    // H3: Content-Security-Policy.
    //
    // Trade-offs:
    //  - `'unsafe-inline'` für script-/style-src ist nötig für Next.js' RSC
    //    Bootstrap-Scripts + Tailwind-CSS. Voll-strict CSP würde Nonces in
    //    Middleware erfordern (Next 16 Pattern), aufwändig.
    //    Die `'unsafe-inline'`-Variante ist gegen reflected/stored XSS
    //    schwächer, aber blockiert immer noch:
    //    - Cross-Origin-Script-Loads (kein CDN-Smuggling)
    //    - `<object>`/`<embed>` (Flash, Java)
    //    - `<base>`-Injection (Base-URL-Hijack)
    //    - Form-Action-Hijack (Daten an Fremd-Origin)
    //    - Frame-Ancestors (Clickjacking, ergänzt X-Frame-Options)
    //    - Connect-Src zu Fremd-Origin (Exfiltration)
    //  - `img-src data:` für Branding-Logos (in tenant_setting als base64).
    //  - `img-src blob:` für lokale Image-Vorschauen (z. B. Avatar-Upload).
    //  - `'unsafe-eval'` AUSSCHLIESSLICH im Dev-Mode: React/Turbopack
    //    rekonstruieren in Development Callstacks via eval(). In Production
    //    nutzt React kein eval — die CSP bleibt dort hart.
    //  - `connect-src ws:` AUSSCHLIESSLICH im Dev-Mode: Turbopack-HMR-WebSocket.
    const isDev = process.env.NODE_ENV !== 'production';

    // Object-Store ist NIE ein eigener Browser-Origin: Up-/Downloads laufen
    // ausschließlich same-origin durch die Next.js-App (Variante B). Darum
    // bleibt `connect-src`/`form-action` hart auf `'self'` — keine S3-Origin-
    // Aufweichung.
    const csp = [
      `default-src 'self'`,
      `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
      `style-src 'self' 'unsafe-inline'`,
      `img-src 'self' data: blob:`,
      `font-src 'self' data:`,
      `connect-src 'self'${isDev ? ' ws: wss:' : ''}`,
      // 'self' statt 'none': der Dokument-Viewer bettet Preview-Streams
      // (PDF/Bild) per <iframe> ein — same-origin. 'none' hätte das blockiert.
      // Cross-Origin-Framing (echter Clickjacking-Vektor) bleibt verboten.
      `frame-ancestors 'self'`,
      `form-action 'self'`,
      `base-uri 'self'`,
      `object-src 'none'`,
      `worker-src 'self' blob:`,
    ].join('; ');

    return [
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
            : [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' }]),
          { key: 'Content-Security-Policy', value: csp },
        ],
      },
      // H-3: Magic-Link-/POA-/GwG-Verify-URLs tragen den Token im Query-String.
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
    ];
  },

  experimental: {
    serverActions: {
      bodySizeLimit: '10mb',
    },
  },
};

export default nextConfig;
