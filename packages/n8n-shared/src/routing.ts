// =============================================================================
// n8n-Routing — EINE API für Outbox-Planung, Admin-Actions und Worker (R-01)
//
// Zielauswahl, Vorrang beim Signatur-Secret, Job-Optionen und Routenprüfung
// standen zuvor in outbox-enqueue.ts, im Worker (jobs/n8n-deliver.ts) und in
// den Retry-/Replay-Actions der n8n-Einstellungen und waren bereits
// auseinandergelaufen: Die Actions ignorierten `endpoint.testMode`. Ein Retry
// an eine Test-Route wurde als „Ziel geändert" abgelehnt, ein Replay erzeugte
// Deliveries mit Produktions-URL, die der Worker anschließend verwarf.
//
// Dieses Modul ist rein funktional. Prisma-Zugriffe liegen in deliveries.ts,
// die Entschlüsselung des Secrets kommt per Dependency-Injection (das Paket
// hängt bewusst nicht an @taxtronik/crypto; die S-08-Kontexte bildet der
// Aufrufer unverändert mit `secretSlotContext(SECRET_SLOTS[slot], …)`).
// Importpfad: `@taxtronik/n8n-shared/outbox-enqueue` (Re-Export).
// =============================================================================

import { env, n8nDeliveryMode, type N8nDeliveryMode } from '@taxtronik/config';
import type { N8nDeliverJob } from '@taxtronik/config/job-queues';

export type N8nRoutingMode = 'DISABLED' | 'LEGACY' | 'EXPLICIT';

// ---------------------------------------------------------------------------
// Zielauswahl
// ---------------------------------------------------------------------------

/** Felder einer expliziten Webhook-Route, die ihr Zustellziel bestimmen. */
export interface N8nEndpointTarget {
  productionUrl: string;
  testUrl: string | null;
  /** Debug-Schalter der Route: liefert an die getrennte Test-URL (/webhook-test). */
  testMode: boolean;
}

export const N8N_TEST_WEBHOOK_MISSING =
  'Kein sicherer n8n-Test-Webhook für diesen Endpoint konfiguriert';

export interface PlannedN8nTarget {
  /** Test-Ziel: global `N8N_DELIVERY_MODE=test` ODER Debug-Schalter `testMode` der Route. */
  useTestUrl: boolean;
  /** Geplante Ziel-URL; null, wenn ein Test-Ziel verlangt, aber keines hinterlegt ist. */
  targetUrl: string | null;
  /** Grund, aus dem die Route nicht zustellbar ist; sonst null. */
  skipReason: string | null;
}

/**
 * Zustellziel einer expliziten Route. Einzige Quelle für Outbox-Planung,
 * Replay, Retry-Prüfung und Worker-Snapshotabgleich.
 */
export function plannedN8nTarget(
  endpoint: N8nEndpointTarget,
  mode: N8nDeliveryMode = n8nDeliveryMode,
): PlannedN8nTarget {
  const useTestUrl = mode === 'test' || endpoint.testMode === true;
  const targetUrl = (useTestUrl ? endpoint.testUrl : endpoint.productionUrl) ?? null;
  return {
    useTestUrl,
    targetUrl,
    skipReason: useTestUrl && !targetUrl ? N8N_TEST_WEBHOOK_MISSING : null,
  };
}

/** Legacy-Ziel: Präfix + `/<event>`; im globalen Testmodus `/webhook` → `/webhook-test`. */
export function legacyN8nTargetUrl(
  baseUrl: string,
  event: string,
  mode: N8nDeliveryMode = n8nDeliveryMode,
): string {
  const base = baseUrl.replace(/\/+$/, '');
  const modeBase = mode === 'test' ? base.replace(/\/webhook$/, '/webhook-test') : base;
  return `${modeBase}/${encodeURIComponent(event)}`;
}

// ---------------------------------------------------------------------------
// Signatur-Secret und Legacy-Präfix: eine Vorrangregel
// ---------------------------------------------------------------------------

/** Tenant-Setting-Schlüssel der Alt-Konfiguration (vor n8n_connection). */
export const LEGACY_N8N_SETTING_KEY = 'integrations.n8n';

/** Für das Routing relevante Spalten von `n8n_connection`. */
export interface N8nRoutingConnection {
  id: string;
  name: string;
  enabled: boolean;
  routingMode: N8nRoutingMode;
  webhookBaseUrl: string | null;
  signingSecretEncrypted: string | null;
}

/** Wert von `tenant_setting['integrations.n8n']` (nur ohne normalisierte Connection gelesen). */
export interface LegacyN8nSetting {
  webhookBaseUrl?: string;
  hmacEncrypted?: string;
  hmacSecret?: string;
}

/** S-08-Ablageort des Secrets: Schlüssel in `SECRET_SLOTS` von @taxtronik/crypto. */
export type N8nSigningSecretSlot = 'n8nSigningSecret' | 'legacyN8nHmacSecret';

/**
 * Wirksame Quelle des Outbound-Signatur-Secrets:
 *   1. Existiert eine normalisierte Connection, ist sie die ALLEINIGE Quelle.
 *   2. Sonst gilt ein vorhandener Legacy-Eintrag `tenant_setting['integrations.n8n']`
 *      als Ganzes — auch wenn er kein Secret enthält.
 *   3. Nur ohne beides gilt ENV (`N8N_HMAC_SECRET`).
 * Kein feldweises Auffüllen aus einer schwächeren Quelle: Ein stiller Fallback
 * würde ein bewusst gelöschtes oder rotiertes Secret wieder aktivieren.
 */
export type N8nSigningSecretSource =
  | { kind: 'CONNECTION'; slot: 'n8nSigningSecret'; tenantId: string; encrypted: string | null }
  | {
      kind: 'LEGACY_SETTING';
      slot: 'legacyN8nHmacSecret';
      tenantId: string;
      encrypted: string | null;
      plain: string | null;
    }
  | { kind: 'ENV'; plain: string | null };

export interface N8nDeliveryConfigInput {
  tenantId: string | null;
  connection: N8nRoutingConnection | null;
  /**
   * Wert des Legacy-Eintrags; `undefined` = kein Eintrag vorhanden. Wird bei
   * vorhandener Connection ignoriert.
   */
  legacySetting?: unknown;
}

export interface N8nDeliveryConfig {
  connection: N8nRoutingConnection | null;
  secretSource: N8nSigningSecretSource;
  /** Präfix für Legacy-Ziele (`/<event>`); leer = nicht konfiguriert. */
  legacyWebhookBaseUrl: string;
}

function asLegacySetting(value: unknown): LegacyN8nSetting {
  // Ein vorhandener, aber unlesbarer Eintrag bleibt ein Eintrag (Stufe 2):
  // er konfiguriert nichts und öffnet auch keinen ENV-Fallback.
  return value !== null && typeof value === 'object' ? (value as LegacyN8nSetting) : {};
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Wendet die Vorrangregel auf bereits geladene Zeilen an (rein funktional). */
export function n8nDeliveryConfigFrom(input: N8nDeliveryConfigInput): N8nDeliveryConfig {
  const { tenantId, connection } = input;
  if (tenantId && connection) {
    return {
      connection,
      secretSource: {
        kind: 'CONNECTION',
        slot: 'n8nSigningSecret',
        tenantId,
        encrypted: connection.signingSecretEncrypted,
      },
      legacyWebhookBaseUrl: connection.webhookBaseUrl?.trim() || '',
    };
  }
  if (tenantId && input.legacySetting !== undefined) {
    const legacy = asLegacySetting(input.legacySetting);
    return {
      connection: null,
      secretSource: {
        kind: 'LEGACY_SETTING',
        slot: 'legacyN8nHmacSecret',
        tenantId,
        encrypted: optionalString(legacy.hmacEncrypted),
        plain: optionalString(legacy.hmacSecret),
      },
      legacyWebhookBaseUrl: optionalString(legacy.webhookBaseUrl)?.trim() || '',
    };
  }
  return {
    connection: null,
    secretSource: { kind: 'ENV', plain: env.N8N_HMAC_SECRET || null },
    legacyWebhookBaseUrl: env.N8N_WEBHOOK_BASE_URL?.trim() || '',
  };
}

/** Ein Secret ist hinterlegt (Planung/Admin); ob es entschlüsselbar ist, prüft erst der Leser. */
export function hasN8nSigningSecret(source: N8nSigningSecretSource): boolean {
  switch (source.kind) {
    case 'CONNECTION':
      return Boolean(source.encrypted);
    case 'LEGACY_SETTING':
      return Boolean(source.encrypted || source.plain);
    case 'ENV':
      return Boolean(source.plain);
  }
}

/**
 * Liest ein optional verschlüsseltes Secret-Feld an seinem Ablageort. Web und
 * Worker implementieren es mit `readEncryptedSetting(encrypted, legacyPlain,
 * fieldName, secretSlotContext(SECRET_SLOTS[slot], { tenantId }))` aus
 * @taxtronik/crypto: entschlüsselt einen Secret-Box-Wert (Fehler → '', kein
 * Rückfall auf Klartext), sonst gilt der unverschlüsselte Altwert.
 */
export type N8nSecretFieldReader = (field: {
  slot: N8nSigningSecretSlot;
  /** Feldname für Diagnose-Logs, niemals der Wert. */
  fieldName: string;
  tenantId: string;
  encrypted: string | null;
  legacyPlain: string | null;
}) => string;

/** Entschlüsseltes Signatur-Secret der wirksamen Quelle; '' = keines nutzbar. */
export function resolveN8nSigningSecret(
  source: N8nSigningSecretSource,
  readField: N8nSecretFieldReader,
): string {
  switch (source.kind) {
    case 'CONNECTION':
      return source.encrypted
        ? readField({
            slot: source.slot,
            fieldName: 'n8n.signingSecret',
            tenantId: source.tenantId,
            encrypted: source.encrypted,
            legacyPlain: null,
          })
        : '';
    case 'LEGACY_SETTING':
      return readField({
        slot: source.slot,
        fieldName: 'n8n.hmacSecret',
        tenantId: source.tenantId,
        encrypted: source.encrypted,
        legacyPlain: source.plain,
      });
    case 'ENV':
      return source.plain ?? '';
  }
}

// ---------------------------------------------------------------------------
// Routenprüfung geplanter Deliveries
// ---------------------------------------------------------------------------

/** Aktueller Routing-Zustand eines Tenants (Connection bzw. Legacy/ENV). */
export interface N8nRoutingState {
  connectionId: string | null;
  routingMode: N8nRoutingMode | null;
  /** Connection bewusst deaktiviert (`enabled=false` oder Modus DISABLED). */
  disabled: boolean;
  legacyWebhookBaseUrl: string;
  /** Planung/Admin: Secret hinterlegt; Worker: Secret entschlüsselbar. */
  signingSecretAvailable: boolean;
}

export function n8nRoutingState(
  config: N8nDeliveryConfig,
  signingSecretAvailable: boolean = hasN8nSigningSecret(config.secretSource),
): N8nRoutingState {
  const connection = config.connection;
  return {
    connectionId: connection?.id ?? null,
    routingMode: connection?.routingMode ?? null,
    disabled: connection ? isN8nConnectionDisabled(connection) : false,
    legacyWebhookBaseUrl: config.legacyWebhookBaseUrl,
    signingSecretAvailable,
  };
}

export function isN8nConnectionDisabled(
  connection: Pick<N8nRoutingConnection, 'enabled' | 'routingMode'>,
): boolean {
  return !connection.enabled || connection.routingMode === 'DISABLED';
}

/** Aktueller Stand der Route einer expliziten Delivery. */
export interface N8nRouteEndpointState extends N8nEndpointTarget {
  enabled: boolean;
  connectionId: string;
  /** Nur AKTIVE Abos der Route (`where: { enabled: true }`). */
  subscriptions: ReadonlyArray<{ event: string }>;
}

/** Bei der Planung festgehaltener Snapshot einer Delivery. */
export interface N8nPlannedDeliverySnapshot {
  targetUrl: string | null;
  connectionIdSnapshot: string | null;
  event: string;
  /** null = Legacy-Delivery oder Route inzwischen gelöscht (endpointId → NULL). */
  endpoint: N8nRouteEndpointState | null;
}

export const N8N_ROUTE_CHANGE_REASONS = {
  disabled: 'n8n-Integration bewusst deaktiviert',
  connectionReplaced: 'n8n-Connection der geplanten Route wurde entfernt oder ersetzt',
  explicitRouteChanged: 'n8n-Route, Ziel-URL oder Event-Zuordnung wurde geändert',
  legacyTargetChanged: 'n8n-Legacy-Ziel wurde geändert',
  targetMissing: 'n8n-Ziel-URL fehlt',
  secretMissing: 'n8n-Signatur-Secret fehlt',
} as const;

export type N8nRouteCheck =
  | { ok: true; targetUrl: string; useTestUrl: boolean }
  | { ok: false; reason: string };

function explicitRouteChanged(
  delivery: N8nPlannedDeliverySnapshot,
  endpoint: N8nRouteEndpointState,
  state: N8nRoutingState,
  mode: N8nDeliveryMode,
): boolean {
  return (
    state.routingMode !== 'EXPLICIT' ||
    !endpoint.enabled ||
    endpoint.connectionId !== state.connectionId ||
    plannedN8nTarget(endpoint, mode).targetUrl !== delivery.targetUrl ||
    !endpoint.subscriptions.some((subscription) => subscription.event === delivery.event)
  );
}

function legacyTargetChanged(
  delivery: N8nPlannedDeliverySnapshot,
  state: N8nRoutingState,
  mode: N8nDeliveryMode,
): boolean {
  return (
    !state.legacyWebhookBaseUrl ||
    delivery.targetUrl !== legacyN8nTargetUrl(state.legacyWebhookBaseUrl, delivery.event, mode)
  );
}

/**
 * Prüft, ob eine geplante Delivery unverändert zugestellt werden darf. Der
 * Worker ruft das unmittelbar vor dem Versand, die Retry-Action vor dem
 * erneuten Einplanen. Exakter Snapshot-Abgleich in beide Richtungen: weder
 * eine alte Legacy-Delivery noch eine Delivery einer gelöschten/ersetzten
 * Connection darf mit einem neuen Secret oder an ein neues Ziel gehen; eine
 * explizite Delivery gilt nur, solange explizites Routing aktiv ist.
 */
export function checkPlannedN8nRoute(
  delivery: N8nPlannedDeliverySnapshot,
  state: N8nRoutingState,
  mode: N8nDeliveryMode = n8nDeliveryMode,
): N8nRouteCheck {
  const reasons = N8N_ROUTE_CHANGE_REASONS;
  if (state.disabled) return { ok: false, reason: reasons.disabled };
  if (delivery.connectionIdSnapshot !== state.connectionId) {
    return { ok: false, reason: reasons.connectionReplaced };
  }
  const endpoint = delivery.endpoint;
  if (endpoint) {
    if (explicitRouteChanged(delivery, endpoint, state, mode)) {
      return { ok: false, reason: reasons.explicitRouteChanged };
    }
  } else if (state.routingMode === 'EXPLICIT') {
    // Legacy-Delivery oder Delivery einer gelöschten Route im expliziten Modus.
    return { ok: false, reason: reasons.explicitRouteChanged };
  } else if (legacyTargetChanged(delivery, state, mode)) {
    return { ok: false, reason: reasons.legacyTargetChanged };
  }
  if (!delivery.targetUrl) return { ok: false, reason: reasons.targetMissing };
  if (!state.signingSecretAvailable) return { ok: false, reason: reasons.secretMissing };
  return {
    ok: true,
    targetUrl: delivery.targetUrl,
    useTestUrl: endpoint ? plannedN8nTarget(endpoint, mode).useTestUrl : mode === 'test',
  };
}

// ---------------------------------------------------------------------------
// BullMQ-Jobs der n8n-deliver-Queue
// ---------------------------------------------------------------------------

export const N8N_DELIVER_JOB_NAME = 'deliver';

export const DELIVERY_JOB_OPTIONS = {
  attempts: 6,
  backoff: { type: 'exponential' as const, delay: 60_000 },
  removeOnComplete: { age: 24 * 60 * 60 },
  removeOnFail: { age: 7 * 24 * 60 * 60 },
};

/**
 * Reconcile läuft alle fünf Minuten. Nur eine Delivery mit abgelaufenem
 * PROCESSING-Lease erhält einen zeitgebundenen Job-Key: Er umgeht den
 * completed-Tombstone des ursprünglichen Jobs, dedupliziert aber parallele
 * Reconcile-Läufe desselben Fensters. PENDING-Jobs behalten ihren Backoff.
 */
export const N8N_RECONCILE_JOB_BUCKET_MS = 5 * 60_000;

export type N8nDeliveryJobVariant =
  /** Erstplanung und Reconcile alter PENDING-Deliveries: `delivery-<id>` (dedupliziert). */
  | { kind: 'initial' }
  /** Admin-Retry: eigener Key je Klick, damit der alte failed-Tombstone nicht blockiert. */
  | { kind: 'manual-retry'; nonce: string }
  /** Reconcile eines abgelaufenen PROCESSING-Lease: Key je Fünf-Minuten-Fenster. */
  | { kind: 'recovery'; now: Date };

export interface N8nDeliverQueueJob {
  name: typeof N8N_DELIVER_JOB_NAME;
  data: N8nDeliverJob;
  opts: typeof DELIVERY_JOB_OPTIONS & { jobId: string };
}

export function n8nDeliveryJobId(
  deliveryId: string,
  variant: N8nDeliveryJobVariant = { kind: 'initial' },
): string {
  switch (variant.kind) {
    case 'initial':
      return `delivery-${deliveryId}`;
    case 'manual-retry':
      return `manual-retry-${deliveryId}-${variant.nonce}`;
    case 'recovery':
      return `recovery-delivery-${deliveryId}-${Math.floor(
        variant.now.getTime() / N8N_RECONCILE_JOB_BUCKET_MS,
      )}`;
  }
}

/** Job einer Delivery — Name, Daten und Optionen für `queue.add(name, data, opts)`. */
export function n8nDeliveryJob(
  deliveryId: string,
  variant: N8nDeliveryJobVariant = { kind: 'initial' },
): N8nDeliverQueueJob {
  return {
    name: N8N_DELIVER_JOB_NAME,
    data: { deliveryId },
    opts: { ...DELIVERY_JOB_OPTIONS, jobId: n8nDeliveryJobId(deliveryId, variant) },
  };
}

/** Rolling-Deploy-Altjob `{ outboxId }`; der Worker materialisiert daraus eine Legacy-Delivery. */
export function n8nLegacyOutboxJob(outboxId: string): N8nDeliverQueueJob {
  return {
    name: N8N_DELIVER_JOB_NAME,
    data: { outboxId },
    opts: { ...DELIVERY_JOB_OPTIONS, jobId: `outbox-${outboxId}` },
  };
}
