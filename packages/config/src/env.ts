// =============================================================================
// taxtronik — ENV-Schema (Zod-validiert)
//
// Wird beim ersten Import dieses Moduls geladen und validiert. Bei Fehlern:
// Crash beim Start mit klarer Fehlermeldung. Niemals stillschweigend
// Defaults für Secrets verwenden.
//
// Alle App-Komponenten (Next.js, Worker, CLI) importieren `env` aus diesem
// Modul. So gibt es nur EINE Stelle, an der ENV gelesen wird.
// =============================================================================

import { z } from 'zod';

const NodeEnv = z.enum(['development', 'test', 'production']);

const PostgresUrl = z
  .string()
  .url()
  .refine((u) => u.startsWith('postgres://') || u.startsWith('postgresql://'), {
    message: 'DATABASE_URL muss mit postgres:// oder postgresql:// beginnen',
  });

const RedisUrl = z
  .string()
  .url()
  .refine((u) => u.startsWith('redis://') || u.startsWith('rediss://'), {
    message: 'REDIS_URL muss mit redis:// oder rediss:// beginnen',
  });

const Secret32 = z.string().min(32, 'Secret muss mindestens 32 Zeichen lang sein');

const envSchema = z.object({
  NODE_ENV: NodeEnv.default('development'),

  // --- Postgres -------------------------------------------------------------
  DATABASE_URL: PostgresUrl,
  DATABASE_APP_URL: PostgresUrl.optional(),

  // --- Redis ----------------------------------------------------------------
  REDIS_URL: RedisUrl,

  // --- Auth.js --------------------------------------------------------------
  AUTH_SECRET: Secret32,
  // Optionales, dediziertes Schlüssel-Material für die Secret-Box
  // (@taxtronik/crypto). Wenn gesetzt, wird dieser Wert (statt AUTH_SECRET) als
  // HKDF-IKM für die v2-Key-Ableitung genutzt. Zweck: AUTH_SECRET kann rotiert
  // werden (Auth.js-JWT-Signing), ohne dass gespeicherte Secrets
  // undechiffrierbar werden — der Box-Key bleibt stabil. Ist der Wert NICHT
  // gesetzt, bleibt das bisherige Verhalten exakt erhalten (Fallback auf
  // AUTH_SECRET), sodass Bestands-Blobs weiter entschlüsselt werden.
  // Hinweis: Eine echte Box-Key-Rotation erfordert weiterhin einen Re-Wrap der
  // Bestands-Secrets (kein Key-Ring im Drahtformat).
  SECRET_BOX_KEY: z.preprocess((v) => (v === '' ? undefined : v), Secret32.optional()),
  NEXTAUTH_URL: z.string().url(),
  // Public-URL der Mandanten-Subdomain. Alle an Mandanten versendeten Links
  // (Magic-Link, GwG-Onboarding, Portal-Formular) müssen auf diese Domain
  // zeigen, nicht auf die Staff-Domain in NEXTAUTH_URL — sonst landet der
  // Mandant auf der falschen Subdomain und das Portal-Cookie greift nicht.
  // Wenn leer: Fallback auf NEXTAUTH_URL (Single-Host-Deploys).
  PORTAL_PUBLIC_URL: z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : v),
    z.string().url().optional(),
  ),
  // Auth.js v5: vertraue dem Host-Header (für Reverse-Proxy-Setups Pflicht).
  // In Produktion MUSS der Reverse-Proxy `X-Forwarded-Host` filtern, sonst
  // ist Host-Header-Smuggling für Callback-URLs theoretisch möglich (S9).
  // Default true in dev für Komfort, in production explizit opt-in.
  NEXTAUTH_TRUST_HOST: z
    .preprocess(
      (v) => (v === '' || v === undefined ? undefined : v),
      z.union([z.literal('true'), z.literal('false')]).transform((s) => s === 'true').optional(),
    )
    .optional(),
  // R-3 / H-2: Wenn `true`, vertraut die App den XFF/Real-IP/CF-Connecting-IP-
  // Headern. Sonst (Default) ignoriert getClientIp die Headers in Production
  // komplett — kein Spoofing möglich. Opt-in über die .env.
  TRUST_PROXY_REQUIRED: z
    .preprocess(
      (v) => (v === '' || v === undefined ? undefined : v),
      z.union([z.literal('true'), z.literal('false')]).optional(),
    )
    .transform((s) => s === 'true'),

  // --- Object-Store / S3 -----------------------------------------------------------
  // Ausschließlich interner Endpoint (App/Worker ↔ SeaweedFS, Docker-Netz):
  // http://seaweedfs:8333. Der Object-Store ist NIE öffentlich erreichbar —
  // Uploads/Downloads werden von der App selbst gestreamt (§ 203 StGB,
  // minimale Angriffsfläche on-prem).
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET_GOBD: z.string().default('gobd'),
  // B-1: Eigener Bucket mit kürzerer Retention für GwG-Beweisdokumente
  // (Ausweis-Scans, Transparenzregister etc.) — § 8 Abs. 4 GwG schreibt
  // 5 Jahre Höchstaufbewahrung vor und verlangt unverzügliche Vernichtung
  // danach. Der `gobd`-Bucket mit Object-Lock-COMPLIANCE und 10 Jahren
  // wäre für GwG-Daten ein DSGVO-/GwG-Verstoß (zu lang, nicht löschbar).
  S3_BUCKET_GWG: z.string().default('gwg'),
  S3_BUCKET_GENERAL: z.string().default('general'),
  S3_BUCKET_STAFF_PRIVATE: z.string().default('staff-private'),
  // Backup-Bucket (server/backup, storage/deploy-readiness) — vorher roh aus
  // process.env gelesen, jetzt schema-validiert.
  S3_BUCKET_BACKUPS: z.string().default('backups'),

  // --- ClamAV ---------------------------------------------------------------
  CLAMAV_HOST: z.string().default('localhost'),
  CLAMAV_PORT: z.coerce.number().int().positive().default(3310),

  // --- SMTP -----------------------------------------------------------------
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().positive(),
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASSWORD: z.string().optional().default(''),
  SMTP_FROM: z.string().min(1),
  // Empfänger für Betriebs-Alarme (Health-Down/Up-Mails des Worker-Jobs
  // health-alert). Leer = Alerting aus. Bewusst E-Mail statt In-App: wenn die
  // App down ist, sieht niemand In-App-Notifications.
  OPS_ALERT_EMAIL: z.preprocess((v) => (v === '' ? undefined : v), z.string().email().optional()),

  // --- n8n ------------------------------------------------------------------
  N8N_WEBHOOK_BASE_URL: z.preprocess((v) => v === '' ? undefined : v, z.string().url().optional()),
  N8N_HMAC_SECRET: z.string().optional(),
  // Liefer-Modus für ausgehende Webhooks. Default leitet sich aus NODE_ENV ab
  // (siehe `n8nDeliveryMode`): dev → 'test' (nur n8n-Test-Hooks, trifft NIE die
  // Produktiv-Workflows — sicheres Debugging), prod → 'production'. 'log' = nicht
  // senden, nur die signierte Anfrage ins Log (Offline-Dev ohne laufendes n8n).
  N8N_DELIVERY_MODE: z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : v),
    z.enum(['production', 'test', 'log']).optional(),
  ),

  // --- Risk-Layer (TCMS-Engine, §4) -----------------------------------------
  // Netzinterne, mandantendatenführende Analyse-Engine. Beide Werte optional:
  // ist die Engine nicht deployt, bleibt das Risk-Modul schlicht inaktiv
  // (riskLayerConfig === null → der Client wirft RiskLayerNotConfiguredError).
  // RISK_LAYER_URL zeigt auf den internen Compose-Host (z. B. http://risk-layer:8000)
  // oder eine Operator-verwaltete interne IP/Loopback-URL. Der Risk-Layer-Client
  // behandelt diesen ENV-Wert als trusted Backend-Ziel; INTERNAL_FETCH_HOSTS ist
  // dafür nicht nötig (bleibt aber für n8n/RSS/TSA-safeFetch-Pfade relevant).
  RISK_LAYER_URL: z.preprocess((v) => v === '' ? undefined : v, z.string().url().optional()),
  RISK_LAYER_TOKEN: z.preprocess((v) => v === '' ? undefined : v, Secret32.optional()),

  // --- ELSTER-Bridge (eric-bridge, privater Dienst) ---------------------------
  // Netzinterner HTTP-Dienst, der die native ERiC-Bibliothek kapselt (eigener
  // Debian-Container; Repo taxtronik-eric-bridge). Beide Werte optional:
  // ohne Deployment bleibt das ELSTER-Modul inaktiv (elsterConfig === null →
  // der Client wirft ElsterNotConfiguredError). Die Hersteller-ID ist KEIN
  // App-ENV — sie ist ausschließlich Konfiguration der Bridge selbst.
  ELSTER_BRIDGE_URL: z.preprocess((v) => v === '' ? undefined : v, z.string().url().optional()),
  ELSTER_BRIDGE_TOKEN: z.preprocess((v) => v === '' ? undefined : v, z.string().min(16).optional()),

  // --- RFC-3161-Zeitstempel -------------------------------------------------
  // Deploy-Default: GlobalSign. Leer ist nur fuer Dev/Test als lokaler
  // Self-Timestamp gedacht; Settings blockieren Self-Timestamp in Production.
  TIMESTAMP_AUTHORITY_URL: z.preprocess((v) => v === '' ? undefined : v, z.string().url().optional()),

  // --- Lizenzschlüssel ------------------------------------------------------
  LICENSE_KEY: z.string().optional(),
  LICENSE_PUBLIC_KEY: z.string().optional(),

  // --- Update-Check (server/update/manifest) --------------------------------
  // Ohne diese Werte meldet die App „Update-Check nicht konfiguriert". Vorher
  // roh aus process.env gelesen — jetzt schema-validiert (optional).
  UPDATE_MANIFEST_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
  UPDATE_PUBLIC_KEY: z.string().optional(),

  // --- Logging --------------------------------------------------------------
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // --- Dev-Only: TOTP-Bypass ------------------------------------------------
  // DEV_SKIP_TOTP umgeht die TOTP-Pflicht für Staff-Logins (nur mit Passwort
  // einloggen). Greift NUR wenn NODE_ENV !== 'production'. In Produktion wird
  // der Wert zur Sicherheit hart auf false normalisiert, selbst falls jemand
  // ihn versehentlich setzt. Siehe apps/web/src/server/auth/staff.ts.
  DEV_SKIP_TOTP: z
    .preprocess(
      (v) => (v === '' || v === undefined ? undefined : v),
      z.union([z.literal('true'), z.literal('false')]).optional(),
    )
    .transform((s) => s === 'true'),

  // --- Optional: Cookie-Domain pro Surface (Subdomain-Trennung) -------------
  // Wenn gesetzt: Cookie wird für die Domain (statt host-only) ausgestellt.
  // Beispiel: STAFF_COOKIE_DOMAIN=staff.kanzlei.example.de
  //           PORTAL_COOKIE_DOMAIN=portal.kanzlei.example.de
  // Achtung: NICHT die übergeordnete Domain (.kanzlei.example.de) eintragen,
  // sonst werden beide Cookies an beide Subdomains geschickt → kein Schutz.
  STAFF_COOKIE_DOMAIN: z.string().optional(),
  PORTAL_COOKIE_DOMAIN: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Exportiert für Unit-Tests (Audit Round 15): die Dev-Default-Denylist und
 * Cross-Field-Validierung dürfen nicht ungetestet bleiben. Test-Code ruft
 * `parseEnvFrom(env)` mit einer kontrollierten Pseudo-ENV statt globalem
 * `process.env`.
 */
export function parseEnvFrom(source: NodeJS.ProcessEnv): Env {
  const original = process.env;
  process.env = source;
  try {
    return parseEnv();
  } finally {
    process.env = original;
  }
}

function parseEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    // Niemals partielle/fehlerhafte ENV booten lassen.
    console.error(`[config] ENV-Validierung fehlgeschlagen:\n${issues}`);
    throw new Error('ENV-Validierung fehlgeschlagen — siehe Konsole.');
  }

  // Cross-Field-Konsistenz
  if (parsed.data.NODE_ENV === 'production') {
    if (!parsed.data.DATABASE_APP_URL) {
      throw new Error(
        '[config] DATABASE_APP_URL ist in Produktion Pflicht (RLS-Backstop). Owner-Verbindung darf nicht von der App genutzt werden.',
      );
    }
    if (!parsed.data.N8N_HMAC_SECRET || parsed.data.N8N_HMAC_SECRET.length < 32) {
      throw new Error(
        '[config] N8N_HMAC_SECRET ist in Produktion Pflicht (mind. 32 Zeichen).',
      );
    }
    // Audit Round 14, Finding 7: Bekannte Dev-Defaults dürfen niemals
    // produktiv eingesetzt werden. Wer das .env-Template direkt übernimmt
    // oder vergisst, beim Setup neue Secrets generieren zu lassen, würde
    // sonst eine vorhersagbare Schlüssel-Material-Wurzel haben.
    // N8N_ENCRYPTION_KEY ist nicht im Zod-Schema (wird nur an den n8n-
    // Container durchgereicht), wir prüfen die Rohwerte aus process.env.
    const DEV_DEFAULT_DENYLIST: Array<{ key: string; value: string }> = [
      { key: 'AUTH_SECRET', value: 'taxtronik-dev-auth-secret-change-in-production-please' },
      { key: 'AUTH_SECRET', value: 'changeme' },
      { key: 'AUTH_SECRET', value: 'secret' },
      { key: 'N8N_HMAC_SECRET', value: 'dev-only-hmac-secret-min-32-chars-long-xxx' },
      { key: 'N8N_ENCRYPTION_KEY', value: 'dev-only-n8n-encryption-key-xxxxxxxx' },
      { key: 'POSTGRES_PASSWORD', value: 'taxtronik' },
      { key: 'TAXTRONIK_APP_PASSWORD', value: 'taxtronik_app' },
      { key: 'S3_ACCESS_KEY', value: 'seaweedfs' },
      { key: 'S3_ACCESS_KEY', value: 'ci' },
      { key: 'S3_SECRET_KEY', value: 'seaweedfs12345' },
      { key: 'S3_SECRET_KEY', value: 'ci-secret' },
      { key: 'S3_SECRET_KEY', value: 'ci-secret-plus-thirtytwo-chars' },
    ];
    for (const { key, value } of DEV_DEFAULT_DENYLIST) {
      const actual = (parsed.data as Record<string, unknown>)[key] ?? process.env[key];
      if (actual === value) {
        throw new Error(
          `[config] ${key} ist auf einen bekannten Dev-Default-Wert gesetzt. ` +
            `Bitte ein zufälliges Secret generieren (siehe scripts/setup.sh) und in .env eintragen.`,
        );
      }
    }
    // Heuristik: zu kurze AUTH_SECRETs sind auch verdächtig (das Zod-Schema
    // erlaubt min(32), aber 32 ASCII-Zeichen sind nicht zwingend 32 Bytes
    // Entropie — z. B. Passwortmanager-Default „password1234password1234…").
    // Wir matchen einfache Wiederholungsmuster.
    const authSecret = parsed.data.AUTH_SECRET;
    if (/^(.)\1{8,}/.test(authSecret) || /^(password|secret|admin|test)/i.test(authSecret)) {
      throw new Error(
        '[config] AUTH_SECRET wirkt wie ein Wörterbuch- oder Wiederholungs-Wert. ' +
          'Bitte mit `openssl rand -base64 32` oder via scripts/setup.sh neu generieren.',
      );
    }
    if (parsed.data.NEXTAUTH_TRUST_HOST === undefined) {
      throw new Error(
        '[config] NEXTAUTH_TRUST_HOST muss in Produktion explizit gesetzt sein (true/false). ' +
          'Setze `true` nur, wenn der Reverse-Proxy `X-Forwarded-Host` filtert/setzt — sonst Host-Header-Smuggling möglich (S9).',
      );
    }
    // S12: Cookie-Isolation. Path-Scoping ist technisch nicht möglich (NextAuth
    // teilt /api/auth/* mit beiden Surfaces). Subdomain-Trennung ist der
    // einzige wirksame Hebel. Warnen (nicht failen — manche Single-Host-Deploys
    // sind bewusst).
    if (new URL(parsed.data.NEXTAUTH_URL).protocol !== 'https:') {
      throw new Error('[config] NEXTAUTH_URL muss in Produktion HTTPS verwenden.');
    }
    if (parsed.data.PORTAL_PUBLIC_URL && new URL(parsed.data.PORTAL_PUBLIC_URL).protocol !== 'https:') {
      throw new Error('[config] PORTAL_PUBLIC_URL muss in Produktion HTTPS verwenden.');
    }
    if (parsed.data.S3_SECRET_KEY.length < 32) {
      throw new Error('[config] S3_SECRET_KEY ist in Produktion Pflicht mit mindestens 32 Zeichen.');
    }
    if (parsed.data.N8N_DELIVERY_MODE && parsed.data.N8N_DELIVERY_MODE !== 'production') {
      throw new Error('[config] N8N_DELIVERY_MODE darf in Produktion nicht test/log sein.');
    }
    if (parsed.data.RISK_LAYER_URL && !parsed.data.RISK_LAYER_TOKEN) {
      throw new Error('[config] RISK_LAYER_URL gesetzt, aber RISK_LAYER_TOKEN fehlt.');
    }
    if (!parsed.data.RISK_LAYER_URL && parsed.data.RISK_LAYER_TOKEN) {
      throw new Error('[config] RISK_LAYER_TOKEN gesetzt, aber RISK_LAYER_URL fehlt.');
    }

    const staffDom = parsed.data.STAFF_COOKIE_DOMAIN;
    const portalDom = parsed.data.PORTAL_COOKIE_DOMAIN;
    if (!staffDom || !portalDom) {
      console.warn(
        '[config] WARNUNG: STAFF_COOKIE_DOMAIN/PORTAL_COOKIE_DOMAIN nicht gesetzt — Staff- und Portal-Surface teilen sich denselben Hostname. ' +
          'Empfohlen für Multi-Standort-Kanzleien: Subdomain-Trennung (z. B. staff.example.de / portal.example.de). ' +
          'Siehe docs/adr/0010-session-strategie-und-cookie-scope.md.',
      );
    } else if (staffDom === portalDom) {
      throw new Error(
        '[config] STAFF_COOKIE_DOMAIN und PORTAL_COOKIE_DOMAIN müssen unterschiedliche Subdomains sein, sonst greift die Cookie-Trennung nicht (S12).',
      );
    } else if (!parsed.data.PORTAL_PUBLIC_URL) {
      throw new Error(
        '[config] PORTAL_PUBLIC_URL ist Pflicht, wenn STAFF_COOKIE_DOMAIN/PORTAL_COOKIE_DOMAIN gesetzt sind.',
      );
    } else if (staffDom.startsWith('.') || portalDom.startsWith('.')) {
      throw new Error(
        '[config] STAFF_COOKIE_DOMAIN/PORTAL_COOKIE_DOMAIN duerfen keine Parent-Domain mit fuehrendem Punkt sein.',
      );
    } else if (
      [staffDom, portalDom].some((d) => d.includes('://') || d.includes('/') || d.includes(':'))
    ) {
      throw new Error(
        '[config] STAFF_COOKIE_DOMAIN/PORTAL_COOKIE_DOMAIN duerfen nur Hostnames enthalten (ohne Protokoll, Pfad oder Port).',
      );
    }
  }

  return parsed.data;
}

export const env: Env = parseEnv();

/**
 * Public-Basis-URL für alle an MANDANTEN versendeten Links (Magic-Link,
 * GwG-Onboarding, Portal-Formular). Zeigt auf die Mandanten-Subdomain,
 * damit Portal-Cookies auf der richtigen Domain landen. Fällt auf
 * NEXTAUTH_URL zurück, wenn keine getrennte Portal-Domain konfiguriert
 * ist (Single-Host-Deploy). Trailing-Slash wird entfernt.
 */
export const portalBaseUrl: string = (
  env.PORTAL_PUBLIC_URL ?? env.NEXTAUTH_URL
).replace(/\/$/, '');

/**
 * Konfiguration der Risk-Layer-Engine (§4) oder `null`, wenn nicht deployt.
 * `null` ist ein gültiger Zustand: die Engine ist opt-in — ohne sie bleibt das
 * Risk-/TCMS-Modul inaktiv. Der `@taxtronik/risk-layer`-Client liest diesen
 * Wert und wirft bei `null` eine klare `RiskLayerNotConfiguredError`, statt
 * stillschweigend gegen eine undefinierte URL zu fetchen. Trailing-Slash der
 * URL wird entfernt (der Client hängt `/v1/...`-Pfade an).
 */
export const riskLayerConfig: { url: string; token: string } | null =
  env.RISK_LAYER_URL && env.RISK_LAYER_TOKEN
    ? { url: env.RISK_LAYER_URL.replace(/\/$/, ''), token: env.RISK_LAYER_TOKEN }
    : null;

/**
 * Konfiguration der ELSTER-Bridge (eric-bridge) oder `null`, wenn nicht
 * deployt. Gleiches Muster wie `riskLayerConfig`: `null` ist ein gültiger
 * Zustand — ohne Bridge bleibt das ELSTER-Modul unsichtbar. Der
 * `@taxtronik/elster`-Client wirft bei `null` eine klare
 * `ElsterNotConfiguredError`. Trailing-Slash wird entfernt.
 */
export const elsterConfig: { url: string; token: string } | null =
  env.ELSTER_BRIDGE_URL && env.ELSTER_BRIDGE_TOKEN
    ? { url: env.ELSTER_BRIDGE_URL.replace(/\/$/, ''), token: env.ELSTER_BRIDGE_TOKEN }
    : null;

/**
 * Auflösung des n8n-Liefer-Modus mit SICHEREM Default aus NODE_ENV: im Dev wird
 * ausschließlich gegen n8n-Test-Hooks geliefert (kein versehentliches Auslösen der
 * Produktiv-Workflows / realer Mails), in Produktion regulär. Explizit per
 * `N8N_DELIVERY_MODE` überschreibbar. 'log' = Dry-Run (nur ins Log, kein Versand).
 */
export type N8nDeliveryMode = 'production' | 'test' | 'log';
export const n8nDeliveryMode: N8nDeliveryMode =
  env.N8N_DELIVERY_MODE ?? (env.NODE_ENV === 'production' ? 'production' : 'test');
