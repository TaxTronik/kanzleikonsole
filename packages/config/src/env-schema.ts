// =============================================================================
// taxtronik — ENV-Schema in Teilen, je Prozess zusammengesetzt (ohne Seiteneffekt)
//
// Review-Befund K-09: Web, Worker und CLI-Skripte validierten dasselbe
// Gesamtschema; der Worker brauchte dadurch Web-Pflichtwerte wie NEXTAUTH_URL.
// Hier stehen die Teile (Core, DB, Restore-Drill, Redis, Secrets, Portal-Links,
// Web-Auth, WebAuthn, S3, ClamAV, SMTP, n8n, Risk-Layer, ELSTER, TSA, Lizenz,
// Update), ihre Produktions-Prüfungen und die Prozessprofile. Das Web-Profil
// umfasst alle Teile und prüft in derselben Reihenfolge mit denselben Meldungen
// wie zuvor; Schemafehler listet die Konsole nach Teilen geordnet. Prüfungen,
// die nur ein Prozess braucht, nennen ihre Profile (Restore-Drill: Worker).
//
// Dieses Modul liest beim Import keine ENV. Die eager validierte `env` liefert
// ./env.ts für das vom Prozess gewählte Profil (./profile.ts).
// =============================================================================

import { z } from 'zod';
import devDefaultSecrets from './dev-default-secrets.json';

// Bekannte Dev-/CI-Defaults und Wörterbuch-/Wiederholungsmuster für
// AUTH_SECRET. Die Daten stehen in dev-default-secrets.json, damit
// scripts/env-tool.mjs in den Setup- und Startskripten dieselben Werte erkennt.
const DEV_DEFAULT_DENYLIST: ReadonlyArray<{ key: string; value: string }> = Object.entries(
  devDefaultSecrets.values,
).flatMap(([key, values]) => values.map((value) => ({ key, value })));
const WEAK_AUTH_SECRET_PATTERNS = devDefaultSecrets.authSecretPatterns.map(
  ({ source, flags }) => new RegExp(source, flags),
);

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

/** Leerer ENV-Wert gilt als nicht gesetzt. */
const blankAsUndefined = (v: unknown) => (v === '' ? undefined : v);
const blankOrMissing = (v: unknown) => (v === '' || v === undefined ? undefined : v);

// S-08: Datenschlüssel der Secret-Box, kommagetrennt. Der erste Eintrag
// verschlüsselt neue Werte, alle Einträge (und SECRET_BOX_KEY bzw.
// AUTH_SECRET als Wurzel) entschlüsseln. Leer oder nicht gesetzt = kein
// Schlüsselbund, die Wurzel verschlüsselt (bisheriges Verhalten).
const SecretBoxKeyring = z.preprocess(
  (value) => {
    if (value === undefined || value === '') return [];
    if (typeof value !== 'string') return value;
    return value.split(',').map((entry) => entry.trim());
  },
  z
    .array(
      z.string().min(32, 'Jeder SECRET_BOX_KEYRING-Eintrag muss mindestens 32 Zeichen lang sein'),
    )
    .max(8, 'SECRET_BOX_KEYRING darf höchstens 8 Schlüssel enthalten')
    .refine((values) => new Set(values).size === values.length, {
      message: 'SECRET_BOX_KEYRING enthält einen Schlüssel mehrfach',
    }),
);

const HardwareAaguidAllowlist = z.preprocess(
  (value) => {
    if (value === undefined || value === '') return [];
    if (typeof value !== 'string') return value;
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  },
  z
    .array(
      z
        .string()
        .uuid()
        .transform((value) => value.toLowerCase()),
    )
    .max(128, 'WEBAUTHN_HARDWARE_AAGUID_ALLOWLIST darf höchstens 128 Einträge enthalten')
    .transform((values) => Array.from(new Set(values))),
);

const TrueFalse = z
  .preprocess(blankOrMissing, z.union([z.literal('true'), z.literal('false')]).optional())
  .transform((s) => s === 'true');

// --- Teile ------------------------------------------------------------------------

const CORE = {
  NODE_ENV: NodeEnv.default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
};

const DATABASE = {
  DATABASE_URL: PostgresUrl,
  DATABASE_APP_URL: PostgresUrl.optional(),
};

// S-01: Verbindung der Drill-Rolle taxtronik_drill (CREATEDB + BYPASSRLS, keine
// Rechte in der Produktiv-DB) für den monatlichen Restore-Drill des Workers
// (apps/worker/src/jobs/backup-drill.ts). Die Owner-Verbindung hat kein
// CREATEDB. Außerhalb von Produktion optional (der Drill nutzt dann
// DATABASE_URL), für den Worker in Produktion Pflicht (Prüfung unten). Das
// Web-Profil enthält den Teil nur als Obermenge aller Teile; die App liest ihn
// nicht, und der app-Container erhält die Drill-Verbindung nicht.
const BACKUP_DRILL = {
  DATABASE_DRILL_URL: z.preprocess(blankAsUndefined, PostgresUrl.optional()),
};

const REDIS = {
  REDIS_URL: RedisUrl,
};

const SECRETS = {
  // Auth.js-Signatur (Web) und Wurzel-IKM der Secret-Box (Web, Worker, CLI).
  AUTH_SECRET: Secret32,
  // Optionales, dediziertes Schlüssel-Material für die Secret-Box
  // (@taxtronik/crypto). Wenn gesetzt, wird dieser Wert (statt AUTH_SECRET) als
  // Wurzel-IKM genutzt: für die v2-Ableitung, für den v3-Schlüssel ohne
  // Schlüsselbund und für die Prüfsumme der Audit-Prüf-Checkpoints. Zweck:
  // AUTH_SECRET kann rotiert werden (Auth.js-JWT-Signing), ohne dass
  // gespeicherte Secrets undechiffrierbar werden. Ist der Wert NICHT gesetzt,
  // bleibt das bisherige Verhalten exakt erhalten (Fallback auf AUTH_SECRET).
  // Datenschlüssel werden über SECRET_BOX_KEYRING rotiert (S-08), nicht durch
  // Ändern dieses Werts.
  SECRET_BOX_KEY: z.preprocess(blankAsUndefined, Secret32.optional()),
  SECRET_BOX_KEYRING: SecretBoxKeyring,
};

const PORTAL_LINKS = {
  // Public-URL der Mandanten-Subdomain. Alle an Mandanten versendeten Links
  // (Magic-Link, GwG-Onboarding, Portal-Formular) müssen auf diese Domain
  // zeigen, nicht auf die Staff-Domain in NEXTAUTH_URL — sonst landet der
  // Mandant auf der falschen Subdomain und das Portal-Cookie greift nicht.
  // Wenn leer: Fallback auf NEXTAUTH_URL (Single-Host-Deploys).
  PORTAL_PUBLIC_URL: z.preprocess(blankOrMissing, z.string().url().optional()),
  // Nur Fallback der Link-Basis; Pflicht ist NEXTAUTH_URL im Web-Auth-Teil.
  NEXTAUTH_URL: z.string().url().optional(),
};

const WEB_AUTH = {
  NEXTAUTH_URL: z.string().url(),
  // Auth.js v5 verarbeitet Anfragen nur mit trustHost=true. In Produktion
  // MUSS deshalb der Reverse-Proxy Host/X-Forwarded-Host auf den kanonischen
  // VHost pinnen; `false` würde nicht härten, sondern jede Auth-Anfrage mit
  // UntrustedHost abschalten.
  NEXTAUTH_TRUST_HOST: z
    .preprocess(
      blankOrMissing,
      z
        .literal('true')
        .transform(() => true)
        .optional(),
    )
    .optional(),
  // R-3 / H-2: Wenn `true`, leitet die App die Client-IP aus X-Forwarded-For ab.
  // Sonst (Default) ignoriert getClientIp die Headers in Production
  // komplett — kein Spoofing möglich. Opt-in über die .env.
  TRUST_PROXY_REQUIRED: TrueFalse,
  // S-03: Anzahl vertrauenswürdiger Proxy-Hops vor der App, die jeweils ihre
  // Gegenstelle an X-Forwarded-For anhängen (oder den Header überschreiben).
  // Die Client-IP ist der n-te Eintrag von RECHTS; alles links davon ist vom
  // Client frei setzbar. 1 = ein Proxy (mitgeliefertes nginx/Traefik), 2 = z. B.
  // CDN + eigener Proxy. Nur relevant mit TRUST_PROXY_REQUIRED=true.
  TRUST_PROXY_HOPS: z
    .preprocess(
      blankOrMissing,
      z
        .string()
        .regex(/^[1-9]$/, 'TRUST_PROXY_HOPS muss eine ganze Zahl von 1 bis 9 sein')
        .optional(),
    )
    .transform((s) => (s === undefined ? 1 : Number(s))),
  // DEV_SKIP_TOTP umgeht die TOTP-Pflicht für Staff-Logins (nur mit Passwort
  // einloggen). Greift NUR wenn NODE_ENV !== 'production'. In Produktion wird
  // der Wert zur Sicherheit hart auf false normalisiert, selbst falls jemand
  // ihn versehentlich setzt. Siehe apps/web/src/server/auth/staff.ts.
  DEV_SKIP_TOTP: TrueFalse,
  // Optional: Cookie-Domain pro Surface (Subdomain-Trennung). Wenn gesetzt:
  // Cookie wird für die Domain (statt host-only) ausgestellt.
  // Beispiel: STAFF_COOKIE_DOMAIN=staff.kanzlei.example.de
  //           PORTAL_COOKIE_DOMAIN=portal.kanzlei.example.de
  // Achtung: NICHT die übergeordnete Domain (.kanzlei.example.de) eintragen,
  // sonst werden beide Cookies an beide Subdomains geschickt → kein Schutz.
  STAFF_COOKIE_DOMAIN: z.string().optional(),
  PORTAL_COOKIE_DOMAIN: z.string().optional(),
};

const WEBAUTHN = {
  // Explizit freigegebene FIDO-MDS-Modellkennungen für den Hardware-only-
  // Modus. Die globale Config darf leer bleiben, damit Installationen ohne
  // Hardware-Feature starten. Das Feature-Gate lehnt bei leerer Liste sowohl
  // Enrollment als auch jede Assertion fail-closed ab.
  WEBAUTHN_HARDWARE_AAGUID_ALLOWLIST: HardwareAaguidAllowlist,
  // Bei jeder fachlichen Aenderung der Hardware-Vertrauenspolicy (insbesondere
  // der Allowlist) monoton erhoehen. Die Datenbank bindet Commits an Revision
  // und kanonischen Policy-Hash, sodass alte Replicas fail-closed auslaufen.
  WEBAUTHN_HARDWARE_POLICY_REVISION: z.preprocess(
    blankOrMissing,
    z.coerce.number().int().positive().default(1),
  ),
};

const S3 = {
  // Ausschließlich interner Endpoint (App/Worker ↔ SeaweedFS, Docker-Netz):
  // http://seaweedfs:8333. Der Object-Store ist NIE öffentlich erreichbar —
  // Uploads/Downloads werden von der App selbst gestreamt (§ 203 StGB,
  // minimale Angriffsfläche on-prem).
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET_GOBD: z.string().default('gobd'),
  // B-1: Eigener Bucket für GwG-Beweisdokumente (Ausweis-Scans,
  // Transparenzregister etc.). § 8 Abs. 4 GwG verlangt grundsätzlich fünf
  // Jahre; andere gesetzliche Pflichten können länger reichen, spätestens
  // nach zehn Jahren ist zu vernichten. Ein starrer GoBD-COMPLIANCE-Lock
  // (dokumenttypabhängig 6/8/10 Jahre) wäre dafür nicht steuerbar genug.
  S3_BUCKET_GWG: z.string().default('gwg'),
  S3_BUCKET_GENERAL: z.string().default('general'),
  S3_BUCKET_STAFF_PRIVATE: z.string().default('staff-private'),
  // Backup-Bucket (server/backup, storage/deploy-readiness).
  S3_BUCKET_BACKUPS: z.string().default('backups'),
};

const CLAMAV = {
  CLAMAV_HOST: z.string().default('localhost'),
  CLAMAV_PORT: z.coerce.number().int().positive().default(3310),
};

const SMTP = {
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().positive(),
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASSWORD: z.string().optional().default(''),
  SMTP_FROM: z.string().min(1),
  // Empfänger für Betriebs-Alarme (Health-Down/Up-Mails des Worker-Jobs
  // health-alert). Leer = Alerting aus. Bewusst E-Mail statt In-App: wenn die
  // App down ist, sieht niemand In-App-Notifications.
  OPS_ALERT_EMAIL: z.preprocess(blankAsUndefined, z.string().email().optional()),
};

const N8N = {
  N8N_WEBHOOK_BASE_URL: z.preprocess(blankAsUndefined, z.string().url().optional()),
  N8N_HMAC_SECRET: z.preprocess(blankAsUndefined, z.string().optional()),
  // Globale /api/n8n/*-Callbacks sind ein reiner Migrationspfad und deshalb
  // standardmäßig vollständig unsichtbar. Nur die exakten Strings true/false
  // sind zulässig; Werte wie 1, yes oder TRUE dürfen nicht truthy werden.
  N8N_LEGACY_CALLBACKS_ENABLED: TrueFalse,
  // Liefer-Modus für ausgehende Webhooks. Default leitet sich aus NODE_ENV ab
  // (siehe `n8nDeliveryMode`): dev → 'test' (nur n8n-Test-Hooks, trifft NIE die
  // Produktiv-Workflows — sicheres Debugging), prod → 'production'. 'log' = nicht
  // senden, nur die signierte Anfrage ins Log (Offline-Dev ohne laufendes n8n).
  N8N_DELIVERY_MODE: z.preprocess(blankOrMissing, z.enum(['production', 'test', 'log']).optional()),
};

const RISK_LAYER = {
  // Netzinterne, mandantendatenführende Analyse-Engine (TCMS, §4). Beide Werte
  // optional: ist die Engine nicht deployt, bleibt das Risk-Modul schlicht
  // inaktiv (riskLayerConfig === null → der Client wirft
  // RiskLayerNotConfiguredError). RISK_LAYER_URL zeigt auf den internen
  // Compose-Host (z. B. http://risk-layer:8000) oder eine Operator-verwaltete
  // interne IP/Loopback-URL. Der Risk-Layer-Client behandelt diesen ENV-Wert als
  // trusted Backend-Ziel; INTERNAL_FETCH_HOSTS ist dafür nicht nötig (bleibt
  // aber für n8n/RSS/TSA-safeFetch-Pfade relevant).
  RISK_LAYER_URL: z.preprocess(blankAsUndefined, z.string().url().optional()),
  RISK_LAYER_TOKEN: z.preprocess(blankAsUndefined, Secret32.optional()),
  // Getrennte Berechtigung für Refresh/Schedule; ohne sie bleibt Status lesbar.
  RISK_LAYER_OPERATOR_TOKEN: z.preprocess(blankAsUndefined, Secret32.optional()),
  // Reines Laufzeitmetadatum für den sichtbaren CPU-Bottleneck-Hinweis.
  RISK_LAYER_LLM_BACKEND: z.preprocess(blankAsUndefined, z.enum(['auto', 'cpu', 'gpu']).optional()),
};

const ELSTER = {
  // Netzinterner HTTP-Dienst, der die native ERiC-Bibliothek kapselt (eigener
  // Debian-Container; Repo taxtronik-eric-bridge). Beide Werte optional:
  // ohne Deployment bleibt das ELSTER-Modul inaktiv (elsterConfig === null →
  // der Client wirft ElsterNotConfiguredError). Die Hersteller-ID ist KEIN
  // App-ENV — sie ist ausschließlich Konfiguration der Bridge selbst.
  ELSTER_BRIDGE_URL: z.preprocess(blankAsUndefined, z.string().url().optional()),
  ELSTER_BRIDGE_TOKEN: z.preprocess(blankAsUndefined, z.string().min(16).optional()),
};

const TSA = {
  // Deploy-Default: GlobalSign. Leer ist nur fuer Dev/Test als lokaler
  // Self-Timestamp gedacht; Settings blockieren Self-Timestamp in Production.
  TIMESTAMP_AUTHORITY_URL: z.preprocess(blankAsUndefined, z.string().url().optional()),
};

const LICENSE = {
  LICENSE_KEY: z.string().optional(),
  LICENSE_PUBLIC_KEY: z.string().optional(),
};

const UPDATE = {
  // Ohne diese Werte meldet die App „Update-Check nicht konfiguriert".
  UPDATE_MANIFEST_URL: z.preprocess(blankAsUndefined, z.string().url().optional()),
  UPDATE_PUBLIC_KEY: z.string().optional(),
};

export const ENV_PARTS = {
  core: CORE,
  database: DATABASE,
  backupDrill: BACKUP_DRILL,
  redis: REDIS,
  secrets: SECRETS,
  portalLinks: PORTAL_LINKS,
  webAuth: WEB_AUTH,
  webauthn: WEBAUTHN,
  s3: S3,
  clamav: CLAMAV,
  smtp: SMTP,
  n8n: N8N,
  riskLayer: RISK_LAYER,
  elster: ELSTER,
  tsa: TSA,
  license: LICENSE,
  update: UPDATE,
} as const;

export type EnvPartName = keyof typeof ENV_PARTS;

// --- Prozessprofile ----------------------------------------------------------------

/**
 * Welche Teile ein Prozess validiert. Reihenfolge = Zusammensetzung (spätere
 * Teile überschreiben gleichnamige Felder: im Web ist NEXTAUTH_URL Pflicht).
 */
export const ENV_PROFILES = {
  /** Next.js-App: alle Teile, identisch zum früheren Gesamtschema. */
  web: [
    'core',
    'database',
    'backupDrill',
    'redis',
    'secrets',
    'portalLinks',
    'webAuth',
    'webauthn',
    's3',
    'clamav',
    'smtp',
    'n8n',
    'riskLayer',
    'elster',
    'tsa',
    'license',
    'update',
  ],
  /**
   * BullMQ-Worker: ohne Web-Auth (NEXTAUTH_TRUST_HOST, TRUST_PROXY_*,
   * Cookie-Domains, DEV_SKIP_TOTP), ELSTER und Lizenz. Für Mandanten-Links in
   * Mails braucht er PORTAL_PUBLIC_URL oder ersatzweise NEXTAUTH_URL.
   */
  worker: [
    'core',
    'database',
    'backupDrill',
    'redis',
    'secrets',
    'portalLinks',
    'webauthn',
    's3',
    'clamav',
    'smtp',
    'n8n',
    'riskLayer',
    'tsa',
    'update',
  ],
  /** `pnpm secret-box:rewrap` (packages/db): Secret-Box-Schlüssel. */
  'cli-secret-box': ['core', 'secrets'],
  /** `pnpm verify:deploy` (packages/storage): Object-Store und Virenscanner. */
  'cli-storage': ['core', 's3', 'clamav'],
} as const satisfies Record<string, readonly EnvPartName[]>;

export type EnvProfileName = keyof typeof ENV_PROFILES;

/**
 * Schemas der Profile, aus denselben Teilen in derselben Reihenfolge wie
 * ENV_PROFILES (ein Test hält beide deckungsgleich). Ausgeschrieben, damit die
 * Typen der Profile exakt bleiben; das Web-Schema entspricht dem früheren
 * Gesamtschema.
 */
const PROFILE_SCHEMAS = {
  web: z.object({
    ...CORE,
    ...DATABASE,
    ...BACKUP_DRILL,
    ...REDIS,
    ...SECRETS,
    ...PORTAL_LINKS,
    ...WEB_AUTH,
    ...WEBAUTHN,
    ...S3,
    ...CLAMAV,
    ...SMTP,
    ...N8N,
    ...RISK_LAYER,
    ...ELSTER,
    ...TSA,
    ...LICENSE,
    ...UPDATE,
  }),
  worker: z.object({
    ...CORE,
    ...DATABASE,
    ...BACKUP_DRILL,
    ...REDIS,
    ...SECRETS,
    ...PORTAL_LINKS,
    ...WEBAUTHN,
    ...S3,
    ...CLAMAV,
    ...SMTP,
    ...N8N,
    ...RISK_LAYER,
    ...TSA,
    ...UPDATE,
  }),
  'cli-secret-box': z.object({ ...CORE, ...SECRETS }),
  'cli-storage': z.object({ ...CORE, ...S3, ...CLAMAV }),
} satisfies Record<EnvProfileName, z.ZodObject>;

/** Validierte ENV der Next.js-App (alle Teile). */
export type Env = z.infer<typeof PROFILE_SCHEMAS.web>;
/** Validierte ENV eines Profils. */
export type ProfileEnv<N extends EnvProfileName> = z.infer<(typeof PROFILE_SCHEMAS)[N]>;
export type WorkerEnv = ProfileEnv<'worker'>;

/** Schema eines Profils (für Tests und Dokumentation). */
export function envProfileSchema<N extends EnvProfileName>(
  profile: N,
): (typeof PROFILE_SCHEMAS)[N] {
  return PROFILE_SCHEMAS[profile];
}

/** Feldnamen eines Profils, z. B. für den Zugriffsschutz in ./env.ts. */
export function envProfileKeys(profile: EnvProfileName): ReadonlySet<string> {
  return new Set(Object.keys(PROFILE_SCHEMAS[profile].shape));
}

export function envProfileHasPart(profile: EnvProfileName, part: EnvPartName): boolean {
  return (ENV_PROFILES[profile] as readonly EnvPartName[]).includes(part);
}

// --- Prüfungen ---------------------------------------------------------------------

type Data = Record<string, unknown> & { NODE_ENV: 'development' | 'test' | 'production' };
/** Ziel nicht blockierender Hinweise (`[config] WARNUNG: …`). */
type Warn = (message: string) => void;
interface Check {
  /** Teil, ohne den die Prüfung entfällt; `null` = jeder Prozess. */
  part: EnvPartName | null;
  /** Nur in diesen Profilen (ohne Angabe: in jedem Profil mit dem Teil). */
  profiles?: readonly EnvProfileName[];
  /** Auch außerhalb von Produktion. */
  always?: boolean;
  /** Wirft bei einem Fehler; Warnungen gehen an `warn`. */
  run(data: Data, source: NodeJS.ProcessEnv, warn: Warn): void;
}

const str = (data: Data, key: string) => data[key] as string | undefined;

/** Operator-Secret nur mit vollständiger Basiskonfiguration (auch im Lazy-Getter). */
function checkRiskLayerOperator(data: Partial<Data>): void {
  const operator = data.RISK_LAYER_OPERATOR_TOKEN as string | undefined;
  if (operator && (!data.RISK_LAYER_URL || !data.RISK_LAYER_TOKEN)) {
    throw new Error(
      '[config] RISK_LAYER_OPERATOR_TOKEN gesetzt, aber die Risk-Layer-Basiskonfiguration aus RISK_LAYER_URL und RISK_LAYER_TOKEN fehlt.',
    );
  }
  if (operator && operator === data.RISK_LAYER_TOKEN) {
    throw new Error(
      '[config] RISK_LAYER_OPERATOR_TOKEN muss sich von RISK_LAYER_TOKEN unterscheiden.',
    );
  }
}

/**
 * Prüfungen in der bisherigen Reihenfolge; ein Profil führt die Prüfungen seiner
 * Teile in genau dieser Reihenfolge aus (Web: alle, wie vorher).
 */
const CHECKS: readonly Check[] = [
  { part: 'riskLayer', always: true, run: checkRiskLayerOperator },
  {
    // Nur ohne NEXTAUTH_URL-Pflicht (Worker) relevant: Mandanten-Links in Mails
    // brauchen eine Basis.
    part: 'portalLinks',
    always: true,
    run(data) {
      if (!str(data, 'PORTAL_PUBLIC_URL') && !str(data, 'NEXTAUTH_URL')) {
        throw new Error(
          '[config] PORTAL_PUBLIC_URL oder NEXTAUTH_URL muss gesetzt sein: Basis der Mandanten-Links in versendeten Mails.',
        );
      }
    },
  },
  {
    part: 'database',
    run(data) {
      if (!str(data, 'DATABASE_APP_URL')) {
        throw new Error(
          '[config] DATABASE_APP_URL ist in Produktion Pflicht (RLS-Backstop). Owner-Verbindung darf nicht von der App genutzt werden.',
        );
      }
    },
  },
  {
    // S-01: Nur der Worker führt den Restore-Drill aus; die App erhält die
    // Drill-Verbindung bewusst nicht.
    part: 'backupDrill',
    profiles: ['worker'],
    run(data) {
      if (!str(data, 'DATABASE_DRILL_URL')) {
        throw new Error(
          '[config] DATABASE_DRILL_URL ist für den Worker in Produktion Pflicht: Der monatliche Restore-Drill legt seine Wegwerf-DB mit der Drill-Rolle taxtronik_drill an (die Owner-Verbindung hat kein CREATEDB).',
        );
      }
    },
  },
  {
    part: 'n8n',
    run(data) {
      const globalN8nHmacRequired = Boolean(
        data.N8N_LEGACY_CALLBACKS_ENABLED || str(data, 'N8N_WEBHOOK_BASE_URL'),
      );
      if (globalN8nHmacRequired && !str(data, 'N8N_HMAC_SECRET')) {
        throw new Error(
          '[config] N8N_HMAC_SECRET ist bei N8N_LEGACY_CALLBACKS_ENABLED oder N8N_WEBHOOK_BASE_URL in Produktion Pflicht (mind. 32 Zeichen).',
        );
      }
      const hmac = str(data, 'N8N_HMAC_SECRET');
      if (hmac && hmac.length < 32) {
        throw new Error(
          '[config] N8N_HMAC_SECRET muss in Produktion mindestens 32 Zeichen lang sein.',
        );
      }
    },
  },
  {
    // Audit Round 14, Finding 7: Bekannte Dev-Defaults dürfen niemals
    // produktiv eingesetzt werden. Wer das .env-Template direkt übernimmt
    // oder vergisst, beim Setup neue Secrets generieren zu lassen, würde
    // sonst eine vorhersagbare Schlüssel-Material-Wurzel haben. Gilt in jedem
    // Prozess für alle Einträge: Werte außerhalb des Profils (z. B.
    // N8N_ENCRYPTION_KEY, nur an den n8n-Container durchgereicht) werden roh
    // aus der Prozess-ENV geprüft.
    part: null,
    run(data, source) {
      for (const { key, value } of DEV_DEFAULT_DENYLIST) {
        const actual = data[key] ?? source[key];
        if (actual === value) {
          throw new Error(
            `[config] ${key} ist auf einen bekannten Dev-Default-Wert gesetzt. ` +
              `Bitte ein zufälliges Secret generieren (siehe scripts/setup.sh) und in .env eintragen.`,
          );
        }
      }
    },
  },
  {
    // Heuristik: zu kurze AUTH_SECRETs sind auch verdächtig (das Zod-Schema
    // erlaubt min(32), aber 32 ASCII-Zeichen sind nicht zwingend 32 Bytes
    // Entropie — z. B. Passwortmanager-Default „password1234password1234…").
    // Wir matchen einfache Wiederholungsmuster.
    part: 'secrets',
    run(data) {
      const authSecret = str(data, 'AUTH_SECRET') ?? '';
      if (WEAK_AUTH_SECRET_PATTERNS.some((pattern) => pattern.test(authSecret))) {
        throw new Error(
          '[config] AUTH_SECRET wirkt wie ein Wörterbuch- oder Wiederholungs-Wert. ' +
            'Bitte mit `openssl rand -base64 32` oder via scripts/setup.sh neu generieren.',
        );
      }
    },
  },
  {
    part: 'webAuth',
    run(data) {
      if (data.NEXTAUTH_TRUST_HOST === undefined) {
        throw new Error(
          '[config] NEXTAUTH_TRUST_HOST muss in Produktion explizit `true` sein. ' +
            'Der Reverse-Proxy muss Host und X-Forwarded-Host auf den kanonischen VHost pinnen — sonst Host-Header-Smuggling möglich (S9).',
        );
      }
    },
  },
  // Zwei getrennte Prüfungen in fester Reihenfolge, damit checkEnvProfileFrom
  // beide URLs meldet; das Boot-Gate scheitert weiterhin an der ersten.
  {
    part: 'portalLinks',
    run(data) {
      const nextAuthUrl = str(data, 'NEXTAUTH_URL');
      if (nextAuthUrl !== undefined && new URL(nextAuthUrl).protocol !== 'https:') {
        throw new Error('[config] NEXTAUTH_URL muss in Produktion HTTPS verwenden.');
      }
    },
  },
  {
    part: 'portalLinks',
    run(data) {
      const portalUrl = str(data, 'PORTAL_PUBLIC_URL');
      if (portalUrl && new URL(portalUrl).protocol !== 'https:') {
        throw new Error('[config] PORTAL_PUBLIC_URL muss in Produktion HTTPS verwenden.');
      }
    },
  },
  {
    part: 's3',
    run(data) {
      if ((str(data, 'S3_SECRET_KEY') ?? '').length < 32) {
        throw new Error(
          '[config] S3_SECRET_KEY ist in Produktion Pflicht mit mindestens 32 Zeichen.',
        );
      }
    },
  },
  {
    part: 'n8n',
    run(data) {
      const mode = str(data, 'N8N_DELIVERY_MODE');
      if (mode && mode !== 'production') {
        throw new Error('[config] N8N_DELIVERY_MODE darf in Produktion nicht test/log sein.');
      }
    },
  },
  {
    part: 'riskLayer',
    run(data) {
      if (str(data, 'RISK_LAYER_URL') && !str(data, 'RISK_LAYER_TOKEN')) {
        throw new Error('[config] RISK_LAYER_URL gesetzt, aber RISK_LAYER_TOKEN fehlt.');
      }
      if (!str(data, 'RISK_LAYER_URL') && str(data, 'RISK_LAYER_TOKEN')) {
        throw new Error('[config] RISK_LAYER_TOKEN gesetzt, aber RISK_LAYER_URL fehlt.');
      }
    },
  },
  {
    // Gleiches Fail-Fast-Pairing wie Risk-Layer: sonst würde ELSTER_BRIDGE_URL
    // ohne Token still zu elsterConfig=null führen (Modul verschwindet aus der
    // UI, ohne dass beim Boot ein Fehler sichtbar wird).
    part: 'elster',
    run(data) {
      if (str(data, 'ELSTER_BRIDGE_URL') && !str(data, 'ELSTER_BRIDGE_TOKEN')) {
        throw new Error('[config] ELSTER_BRIDGE_URL gesetzt, aber ELSTER_BRIDGE_TOKEN fehlt.');
      }
      if (!str(data, 'ELSTER_BRIDGE_URL') && str(data, 'ELSTER_BRIDGE_TOKEN')) {
        throw new Error('[config] ELSTER_BRIDGE_TOKEN gesetzt, aber ELSTER_BRIDGE_URL fehlt.');
      }
    },
  },
  {
    // S12: Cookie-Isolation. Path-Scoping ist technisch nicht möglich (NextAuth
    // teilt /api/auth/* mit beiden Surfaces). Subdomain-Trennung ist der
    // einzige wirksame Hebel. Warnen (nicht failen — manche Single-Host-Deploys
    // sind bewusst).
    part: 'webAuth',
    run: checkCookieDomains,
  },
];

function checkCookieDomains(data: Data, _source: NodeJS.ProcessEnv, warn: Warn): void {
  const staffDom = str(data, 'STAFF_COOKIE_DOMAIN');
  const portalDom = str(data, 'PORTAL_COOKIE_DOMAIN');
  if (!staffDom || !portalDom) {
    warn(
      '[config] WARNUNG: STAFF_COOKIE_DOMAIN/PORTAL_COOKIE_DOMAIN nicht gesetzt — Staff- und Portal-Surface teilen sich denselben Hostname. ' +
        'Empfohlen für Multi-Standort-Kanzleien: Subdomain-Trennung (z. B. staff.example.de / portal.example.de). ' +
        'Siehe docs/adr/0010-session-strategie-und-cookie-scope.md.',
    );
  } else if (staffDom === portalDom) {
    throw new Error(
      '[config] STAFF_COOKIE_DOMAIN und PORTAL_COOKIE_DOMAIN müssen unterschiedliche Subdomains sein, sonst greift die Cookie-Trennung nicht (S12).',
    );
  } else if (!str(data, 'PORTAL_PUBLIC_URL')) {
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

/** Schemafehler: alle Befunde auf die Konsole und ein Fehler. */
function validationFailed(error: z.ZodError): never {
  const issues = error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  // Niemals partielle/fehlerhafte ENV booten lassen.
  console.error(`[config] ENV-Validierung fehlgeschlagen:\n${issues}`);
  throw new Error('ENV-Validierung fehlgeschlagen — siehe Konsole.');
}

/** Prüfungen, die für ein Profil und den Betriebsmodus gelten (Reihenfolge wie CHECKS). */
function checksFor(profile: EnvProfileName, data: Data): Check[] {
  const production = data.NODE_ENV === 'production';
  return CHECKS.filter(
    (check) =>
      (check.part === null || envProfileHasPart(profile, check.part)) &&
      (check.profiles === undefined || check.profiles.includes(profile)) &&
      (check.always || production),
  );
}

const consoleWarn: Warn = (message) => console.warn(message);

/**
 * Validiert die ENV eines Profils: das Schema seiner Teile, dann deren
 * Prüfungen (in Produktion alle, sonst nur die immer geltenden).
 */
export function parseEnvProfileFrom<N extends EnvProfileName>(
  profile: N,
  source: NodeJS.ProcessEnv,
): ProfileEnv<N> {
  const parsed = PROFILE_SCHEMAS[profile].safeParse(source);
  if (!parsed.success) validationFailed(parsed.error);
  const data = parsed.data as Data;
  for (const check of checksFor(profile, data)) check.run(data, source, consoleWarn);
  return parsed.data as ProfileEnv<N>;
}

/** Alle Befunde einer Profilprüfung (B-05), statt Abbruch beim ersten Fehler. */
export interface EnvProfileFindings {
  /** Schemafehler je Feld und Meldungen fehlgeschlagener Prüfungen (`[config] …`). */
  errors: string[];
  /** Nicht blockierende Hinweise (`[config] WARNUNG: …`). */
  warnings: string[];
}

/** Gültige Felder einer ENV, deren Schema insgesamt scheitert (fehlende = nicht gesetzt). */
function validFieldsOf(profile: EnvProfileName, source: NodeJS.ProcessEnv): Data {
  const data: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(PROFILE_SCHEMAS[profile].shape)) {
    const result = (field as z.ZodType).safeParse(source[key]);
    if (result.success && result.data !== undefined) data[key] = result.data;
  }
  return { NODE_ENV: 'development', ...data } as Data;
}

/**
 * B-05: Prüft ein Profil wie `parseEnvProfileFrom`, sammelt aber alle Befunde:
 * jeden Schemafehler und jede Prüfung einzeln, statt beim ersten Fehler
 * abzubrechen. Das Urteil bleibt dasselbe: `errors` ist genau dann leer, wenn
 * `parseEnvProfileFrom` die ENV akzeptiert. Scheitert das Schema, laufen die
 * Prüfungen auf den gültigen Feldern weiter, damit ein Lauf alle Probleme zeigt.
 * Für die Konfigurationsprüfung im Ziel-Image vor Backup und Migration
 * (apps/worker/src/env-check.ts) und `./taxtronik doctor`.
 */
export function checkEnvProfileFrom(
  profile: EnvProfileName,
  source: NodeJS.ProcessEnv,
): EnvProfileFindings {
  const errors: string[] = [];
  const warnings: string[] = [];
  const parsed = PROFILE_SCHEMAS[profile].safeParse(source);
  let data: Data;
  if (parsed.success) {
    data = parsed.data as Data;
  } else {
    for (const issue of parsed.error.issues) {
      errors.push(`[config] ENV-Validierung: ${issue.path.join('.')}: ${issue.message}`);
    }
    data = validFieldsOf(profile, source);
  }
  for (const check of checksFor(profile, data)) {
    try {
      check.run(data, source, (message) => warnings.push(message));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { errors, warnings };
}

// --- Abgeleitete Konfiguration (auch als Lazy-Getter für Pakete) -------------------

/**
 * Konfiguration der Risk-Layer-Engine (§4) oder `null`, wenn nicht deployt.
 * `null` ist ein gültiger Zustand: die Engine ist opt-in — ohne sie bleibt das
 * Risk-/TCMS-Modul inaktiv. Der `@taxtronik/risk-layer`-Client liest diesen
 * Wert und wirft bei `null` eine klare `RiskLayerNotConfiguredError`, statt
 * stillschweigend gegen eine undefinierte URL zu fetchen. Trailing-Slash der
 * URL wird entfernt (der Client hängt `/v1/...`-Pfade an).
 */
export interface RiskLayerConfig {
  /** Basis-URL der Engine ohne Trailing-Slash. */
  url: string;
  /** Shared Secret für normale Bearer-authentisierte Engine-Aufrufe. */
  token: string;
  /** Separates Secret für schreibende Operator-Aufrufe. */
  operatorToken?: string;
}

export interface ElsterConfig {
  url: string;
  token: string;
}

export type N8nDeliveryMode = 'production' | 'test' | 'log';

export function riskLayerConfigOf(data: {
  RISK_LAYER_URL?: string;
  RISK_LAYER_TOKEN?: string;
  RISK_LAYER_OPERATOR_TOKEN?: string;
}): RiskLayerConfig | null {
  return data.RISK_LAYER_URL && data.RISK_LAYER_TOKEN
    ? {
        url: data.RISK_LAYER_URL.replace(/\/$/, ''),
        token: data.RISK_LAYER_TOKEN,
        ...(data.RISK_LAYER_OPERATOR_TOKEN
          ? { operatorToken: data.RISK_LAYER_OPERATOR_TOKEN }
          : {}),
      }
    : null;
}

export function elsterConfigOf(data: {
  ELSTER_BRIDGE_URL?: string;
  ELSTER_BRIDGE_TOKEN?: string;
}): ElsterConfig | null {
  return data.ELSTER_BRIDGE_URL && data.ELSTER_BRIDGE_TOKEN
    ? { url: data.ELSTER_BRIDGE_URL.replace(/\/$/, ''), token: data.ELSTER_BRIDGE_TOKEN }
    : null;
}

/**
 * Auflösung des n8n-Liefer-Modus mit SICHEREM Default aus NODE_ENV: im Dev wird
 * ausschließlich gegen n8n-Test-Hooks geliefert (kein versehentliches Auslösen der
 * Produktiv-Workflows / realer Mails), in Produktion regulär. Explizit per
 * `N8N_DELIVERY_MODE` überschreibbar. 'log' = Dry-Run (nur ins Log, kein Versand).
 */
export function n8nDeliveryModeOf(data: {
  NODE_ENV: 'development' | 'test' | 'production';
  N8N_DELIVERY_MODE?: N8nDeliveryMode;
}): N8nDeliveryMode {
  return data.N8N_DELIVERY_MODE ?? (data.NODE_ENV === 'production' ? 'production' : 'test');
}

const RISK_LAYER_SCHEMA = z.object(RISK_LAYER);
const ELSTER_SCHEMA = z.object(ELSTER);

/**
 * Lazy-Getter für Pakete (risk-layer): liest nur den Risk-Layer-Teil zur
 * Aufrufzeit. Kein Import-Seiteneffekt, daher brauchen Paket-Tests keine
 * Minimal-ENV. Die Boot-Validierung des Prozesses prüft dieselben Felder.
 */
export function getRiskLayerConfig(
  source: NodeJS.ProcessEnv = process.env,
): RiskLayerConfig | null {
  const parsed = RISK_LAYER_SCHEMA.safeParse(source);
  if (!parsed.success) validationFailed(parsed.error);
  checkRiskLayerOperator(parsed.data);
  return riskLayerConfigOf(parsed.data);
}

/** Lazy-Getter für @taxtronik/elster: ELSTER-Bridge oder `null`, wenn nicht deployt. */
export function getElsterConfig(source: NodeJS.ProcessEnv = process.env): ElsterConfig | null {
  const parsed = ELSTER_SCHEMA.safeParse(source);
  if (!parsed.success) validationFailed(parsed.error);
  return elsterConfigOf(parsed.data);
}
