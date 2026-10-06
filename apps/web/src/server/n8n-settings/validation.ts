// =============================================================================
// n8n-Einstellungen: Eingaben prüfen und normalisieren (Review-Finding K-03).
//
// Reine Funktionen ohne IO (eigene Unit-Tests): Formular-Schemata für
// Verbindung, Route und Vorlagen-Import, die URL-Regeln (nur HTTP(S), eine
// getrennte /webhook-test/-URL für Fach-Events), die Normalisierung der zu
// speichernden Verbindung und die Entscheidungen, wann wartende Zustellungen
// abgebrochen und Routen neu verifiziert werden. Die SSRF-Prüfung der
// Zieladressen (DNS-Auflösung, private Netze) ist IO und bleibt in
// server/http/ssrf-guard.ts; die Services rufen sie vor jedem Speichern/Senden.
// =============================================================================

import { z } from 'zod';
import {
  isAllowedN8nEvent,
  N8N_EVENT_CATALOG,
  requiresSeparateTestWebhook,
} from '@taxtronik/n8n-shared';
import type { N8nTargetKind } from '@/server/http/ssrf-guard';
import type { N8nConfig } from '@/server/settings/n8n';

// zod 4 führt die Protokoll-Prüfung auch nach einem gescheiterten .url() aus:
// eine unparsbare Adresse ergibt hier `false` statt eines TypeErrors.
const HttpUrl = z
  .string()
  .url()
  .max(1_000)
  .refine(
    (value) => {
      try {
        return ['http:', 'https:'].includes(new URL(value).protocol);
      } catch {
        return false;
      }
    },
    { message: 'Es sind nur HTTP- und HTTPS-Adressen erlaubt.' },
  );
const OptionalUrl = z.union([z.literal(''), HttpUrl]);
const ProductionWebhookUrl = HttpUrl.refine((value) => {
  try {
    const path = decodeURIComponent(new URL(value).pathname).toLowerCase();
    return !/(^|\/)webhook-test(?:\/|$)/.test(path);
  } catch {
    return false;
  }
}, 'Die Produktions-URL darf keine n8n-Test-URL (/webhook-test/) sein.');
const TestWebhookUrl = HttpUrl.refine((value) => {
  try {
    const path = decodeURIComponent(new URL(value).pathname).toLowerCase();
    return /(^|\/)webhook-test(?:\/|$)/.test(path);
  } catch {
    return false;
  }
}, 'Die Test-URL muss eine getrennte n8n-Test-URL mit /webhook-test/ sein.');

/** Formular der Verbindung (Speichern und API-Test). */
export const ConnectionSchema = z.object({
  name: z.string().trim().min(1).max(100),
  kind: z.enum(['BUNDLED', 'SELF_HOSTED', 'CLOUD']),
  routingMode: z.enum(['DISABLED', 'LEGACY', 'EXPLICIT']),
  enabled: z.boolean(),
  uiBaseUrl: OptionalUrl,
  callbackBaseUrl: OptionalUrl,
  webhookBaseUrl: OptionalUrl,
  hmacSecret: z.string().max(1_000),
  apiBaseUrl: OptionalUrl,
  apiKey: z.string().max(2_000),
  keepHmac: z.boolean(),
  keepApiKey: z.boolean(),
});

export type N8nConnectionInput = z.infer<typeof ConnectionSchema>;

const EventName = z.string().min(1).max(80).refine(isAllowedN8nEvent, 'Unbekanntes Event.');

/** Formular einer Workflow-Route. */
export const EndpointSchema = z
  .object({
    id: z.union([z.literal(''), z.string().uuid()]),
    name: z.string().trim().min(1).max(120),
    productionUrl: ProductionWebhookUrl,
    testUrl: z.union([z.literal(''), TestWebhookUrl]),
    workflowId: z.string().trim().max(200),
    workflowName: z.string().trim().max(200),
    workflowNodeId: z.string().trim().max(200),
    source: z.enum(['MANAGED', 'DISCOVERED', 'CUSTOM']).default('CUSTOM'),
    enabled: z.boolean(),
    testMode: z.boolean(),
    events: z.array(EventName).min(1, 'Mindestens ein Event auswählen.'),
  })
  .superRefine((data, ctx) => {
    if (data.testMode && !data.testUrl) {
      ctx.addIssue({
        code: 'custom',
        path: ['testMode'],
        message: 'Der Test-Modus benötigt eine gespeicherte Test-URL (/webhook-test).',
      });
    }
    if (!data.testUrl && requiresSeparateTestWebhook(data.events)) {
      ctx.addIssue({
        code: 'custom',
        path: ['testUrl'],
        message:
          'Für Fach-Events ist die getrennte n8n-Test-URL erforderlich; Produktionstests sind nur für taxtronik.ping erlaubt.',
      });
    }
  });

export type N8nEndpointInput = z.infer<typeof EndpointSchema>;

/** Auswahl und Einrichtungswerte des Vorlagen-Imports. */
export const WorkflowImportSchema = z.object({
  templateIds: z.array(z.string().min(1).max(100)).max(20),
  smtpFrom: z.string().trim().max(320).default(''),
  gwgOfficerEmail: z.union([z.literal(''), z.string().email().max(320)]).default(''),
});

export function sameUrlOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

export function n8nApiConfigurationError(apiBaseUrl: string, apiKey: string): string | null {
  return apiKey && !apiBaseUrl ? 'Zum n8n-API-Key fehlt die Public-API-Adresse.' : null;
}

/**
 * „Gespeicherten API-Key behalten“ bei einer Public-API-Adresse auf einem
 * anderen Host: Der Key darf nie an eine fremde n8n-Instanz gehen. Nur bei
 * tatsächlich gespeicherter Vorgänger-URL — sameUrlOrigin('') ist false, eine
 * leere Alt-URL blockierte sonst jede Neueingabe dauerhaft.
 */
export function storedApiKeyLeavesInstance(
  previous: Pick<N8nConfig, 'apiKey' | 'apiBaseUrl'>,
  data: Pick<N8nConnectionInput, 'keepApiKey' | 'apiBaseUrl'>,
): boolean {
  return Boolean(
    data.keepApiKey &&
    previous.apiKey &&
    previous.apiBaseUrl &&
    !sameUrlOrigin(data.apiBaseUrl, previous.apiBaseUrl),
  );
}

/** Wirksame Secrets: „beibehalten“ übernimmt den gespeicherten Wert. */
export function effectiveConnectionSecrets(
  previous: Pick<N8nConfig, 'hmacSecret' | 'apiKey'>,
  data: Pick<N8nConnectionInput, 'keepHmac' | 'hmacSecret' | 'keepApiKey' | 'apiKey'>,
): { hmacSecret: string; apiKey: string } {
  return {
    hmacSecret: data.keepHmac ? previous.hmacSecret : data.hmacSecret,
    apiKey: data.keepApiKey ? previous.apiKey : data.apiKey,
  };
}

/**
 * Fachliche Ablehnung der Verbindung vor der Adressprüfung; `null`, wenn sie
 * gespeichert werden darf.
 */
export function connectionSaveRejection(
  previous: Pick<N8nConfig, 'apiKey' | 'apiBaseUrl'>,
  data: N8nConnectionInput,
  { hmacSecret, apiKey }: { hmacSecret: string; apiKey: string },
): string | null {
  if (hmacSecret && hmacSecret.length < 32) {
    return 'Das Signatur-Secret muss mindestens 32 Zeichen lang sein.';
  }
  // Eine verwaltete Compose-Instanz wird schon beim Deploy mit ihrer internen
  // API-URL provisioniert. Den Key kann n8n erst nach der Owner-Anmeldung
  // ausgeben; deshalb darf die Adresse zunächst ohne Key gespeichert bleiben.
  // Umgekehrt wäre ein Key ohne Zieladresse unbrauchbar und bleibt verboten.
  const apiConfigurationError = n8nApiConfigurationError(data.apiBaseUrl, apiKey);
  if (apiConfigurationError) return apiConfigurationError;
  if (storedApiKeyLeavesInstance(previous, data)) {
    return 'Die Public-API-Adresse zeigt auf eine andere n8n-Instanz. Bitte den API-Key dieser Instanz eingeben — der gespeicherte Key wird nicht an einen fremden Host gesendet.';
  }
  if (data.routingMode === 'LEGACY' && (!data.webhookBaseUrl || !hmacSecret)) {
    return 'Der Legacy-Modus benötigt Webhook-Präfix und Signatur-Secret.';
  }
  return null;
}

/**
 * Zu speichernde Verbindung: Adressen getrimmt und ohne abschließenden Slash,
 * deaktiviertes Routing ist nie aktiv. `callbackBaseUrl` ist die eingegebene
 * oder die Standard-Rückkanal-Adresse der Installationsart.
 */
export function normalizedConnectionConfig(
  previous: N8nConfig,
  data: N8nConnectionInput,
  { hmacSecret, apiKey }: { hmacSecret: string; apiKey: string },
  callbackBaseUrl: string,
): N8nConfig {
  return {
    ...previous,
    name: data.name,
    kind: data.kind,
    routingMode: data.routingMode,
    enabled: data.routingMode !== 'DISABLED' && data.enabled,
    uiBaseUrl: data.uiBaseUrl.trim().replace(/\/$/, ''),
    callbackBaseUrl: callbackBaseUrl.replace(/\/$/, ''),
    webhookBaseUrl: data.webhookBaseUrl.trim().replace(/\/$/, ''),
    hmacSecret,
    apiBaseUrl: data.apiBaseUrl.trim().replace(/\/$/, ''),
    apiKey,
    source: 'CONNECTION',
  };
}

/**
 * Folgen einer gespeicherten Verbindungsänderung: Ein neues Signatur-Secret
 * verlangt neu getestete Routen; Zustell-relevante Änderungen brechen wartende
 * Zustellungen ab (die Outbox plant mit der neuen Konfiguration neu).
 */
export function connectionChange(
  previous: N8nConfig,
  cfg: N8nConfig,
): { signingSecretChanged: boolean; deliveryConfigurationChanged: boolean } {
  const signingSecretChanged = previous.hmacSecret !== cfg.hmacSecret;
  const deliveryConfigurationChanged =
    signingSecretChanged ||
    previous.connectionId === null ||
    previous.enabled !== cfg.enabled ||
    previous.routingMode !== cfg.routingMode ||
    (previous.webhookBaseUrl !== cfg.webhookBaseUrl &&
      (previous.routingMode === 'LEGACY' || cfg.routingMode === 'LEGACY'));
  return { signingSecretChanged, deliveryConfigurationChanged };
}

/**
 * Änderung einer gespeicherten Route. `routeChanged` (Ziel-URLs oder Events)
 * setzt die Verifikation zurück; `cancelReason` ist gesetzt, wenn wartende
 * Zustellungen der Route abgebrochen werden.
 */
export function endpointRouteChange(
  exists: {
    productionUrl: string;
    testUrl: string | null;
    enabled: boolean;
    testMode: boolean;
    subscriptions: ReadonlyArray<{ event: string }>;
  },
  data: Pick<N8nEndpointInput, 'productionUrl' | 'testUrl' | 'enabled' | 'testMode' | 'events'>,
): { routeChanged: boolean; cancelReason: string | null } {
  const previousEvents = exists.subscriptions
    .map((item) => item.event)
    .sort()
    .join('\n');
  const nextEvents = [...new Set(data.events)].sort().join('\n');
  const routeChanged =
    exists.productionUrl !== data.productionUrl ||
    (exists.testUrl ?? '') !== data.testUrl ||
    previousEvents !== nextEvents;
  // Test-Modus-Wechsel ändert das Zustellziel bereits geplanter
  // Deliveries — sie werden storniert (Outbox plant neu), setzt aber
  // NICHT die Verifikation zurück (URLs sind unverändert).
  const testModeChanged = exists.testMode !== data.testMode;
  if (!(routeChanged || testModeChanged || (exists.enabled && !data.enabled))) {
    return { routeChanged, cancelReason: null };
  }
  return {
    routeChanged,
    cancelReason: routeChanged
      ? 'n8n-Route oder Event-Zuordnung wurde geändert'
      : testModeChanged
        ? 'Test-Modus der n8n-Route wurde umgeschaltet'
        : 'n8n-Route wurde deaktiviert',
  };
}

export function webhookTargetKind(useTestUrl: boolean): N8nTargetKind {
  return useTestUrl ? 'webhook-test' : 'webhook';
}

export function joinWebhookUrl(prefix: string, path: string): string {
  return `${prefix.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

export function testWebhookPrefix(productionPrefix: string): string {
  return /\/webhook\/?$/i.test(productionPrefix)
    ? productionPrefix.replace(/\/webhook\/?$/i, '/webhook-test')
    : '';
}

/** Body eines synthetischen Test-Events (Beispiel-Payload des Event-Katalogs). */
export function syntheticN8nTestEvent(input: {
  eventId: string;
  deliveryId: string;
  event: string;
  tenantId: string;
  occurredAt: Date;
}): string {
  const catalogEntry = N8N_EVENT_CATALOG.find((entry) => entry.name === input.event);
  return JSON.stringify({
    schemaVersion: 1,
    eventId: input.eventId,
    deliveryId: input.deliveryId,
    event: input.event,
    tenantId: input.tenantId,
    occurredAt: input.occurredAt.toISOString(),
    payload: {
      ...(catalogEntry?.examplePayload ?? { from: 'taxtronik-settings-ui' }),
      synthetic: true,
    },
  });
}

/** taxtronik.ping verlangt die TaxTronik-Challenge in der Antwort, andere Events nicht. */
export function pingChallengeOk(event: string, responseBody: string): boolean {
  if (event !== 'taxtronik.ping') return true;
  try {
    const parsedResponse = JSON.parse(responseBody) as { challenge?: unknown; event?: unknown };
    return (
      parsedResponse.challenge === 'taxtronik-connection-ok' &&
      parsedResponse.event === 'taxtronik.ping'
    );
  } catch {
    return false;
  }
}

/** Prüfergebnis einer Webhook-Antwort als Meldung; `null` = bestätigt. */
export function webhookVerificationError(
  response: { ok: boolean; status: number },
  responseBody: string,
  challengeOk: boolean,
): string | null {
  return !response.ok
    ? `HTTP ${response.status}: ${responseBody || 'leere Antwort'}`
    : !challengeOk
      ? 'Antwort enthält nicht die erwartete TaxTronik-Challenge.'
      : null;
}
