// =============================================================================
// @taxtronik/n8n-shared — geteilte Konstanten und HMAC-Signing für n8n.
//
// Konsolidiert die Drift-Klasse aus Round 12:
//   - STATIC_EVENT_WHITELIST war in apps/web/src/server/n8n/outbox.ts und
//     apps/worker/src/jobs/n8n-deliver.ts identisch dupliziert. Neue Events
//     ohne Pflege beider Stellen landen sonst stillschweigend in einer
//     Sackgasse (Outbox akzeptiert, Worker lehnt ab — oder umgekehrt).
//   - HMAC-Signing (sign.ts in Web + n8n-deliver.ts inline im Worker) hatte
//     dieselben drei Zeilen `${event}\n${ts}\n${body}` + `sha256=${hex}`.
// =============================================================================

import { createHmac, randomBytes } from 'node:crypto';

/**
 * System-Events, die die App aktiv an n8n schickt. Workflow-Step-Events
 * (`workflow.step.<suffix>`) sind separat über WORKFLOW_STEP_RE typisiert.
 *
 * EINZIGE Quelle: aus dieser Tupel-Konstante werden sowohl die Runtime-
 * Whitelist als auch der TS-Union-Typ `StaticN8nEventName` abgeleitet. So
 * kann ein typisiertes Emit nie an einer fehlenden Whitelist-Zeile scheitern
 * (die Drift-Klasse aus Round 12 bzw. dem appointment.responded-Befund).
 */
export const STATIC_EVENT_NAMES = [
  'client.created',
  'client.handover.ready',
  'document.uploaded',
  'request.opened',
  'request.responded',
  'request.closed',
  'phone_note.created',
  // Termin-Bestätigung/-Ablehnung (calendar/actions.ts). Payload trägt
  // kind: 'appointment-accepted' | 'appointment-rejected'.
  'appointment.responded',
  'gwg.invite.created',
  'gwg.verified',
  'gwg.expired',
  'invoice.due',
  // Storno-/Korrekturbeleg (§ 14c i.V.m. § 17 UStG) versendet. Bewusst NICHT
  // invoice.due: ein Gutschriftbeleg hat keine fällige Zahlung, Zahlungs-
  // erinnerungs-Workflows dürfen daran nicht anschlagen.
  'invoice.storno',
  'staff.locked',
  // Urlaubsantrag — nicht als staff.locked emittieren (anderer Alarm).
  'staff.vacation_requested',
  'risk.research_requested',
  'taxtronik.ping',
] as const;

export type StaticN8nEventName = (typeof STATIC_EVENT_NAMES)[number];

/** Fachliche Gruppierung für Anzeige, Filter und Dokumentation. */
export type N8nEventCategory =
  | 'CLIENTS'
  | 'DOCUMENTS'
  | 'REQUESTS'
  | 'COMMUNICATION'
  | 'APPOINTMENTS'
  | 'COMPLIANCE'
  | 'BILLING'
  | 'STAFF'
  | 'RESEARCH'
  | 'SYSTEM';

/**
 * Grobe Schutzklasse des Event-Payloads. Sie ersetzt weder eine konkrete
 * Datenschutz-Folgenabschätzung noch die Prüfung eines eigenen Workflows.
 */
export type N8nEventDataClass = 'TECHNICAL' | 'INTERNAL' | 'PERSONAL_DATA' | 'PROFESSIONAL_SECRET';

export interface N8nEventCatalogEntry {
  readonly name: StaticN8nEventName;
  readonly label: string;
  readonly category: N8nEventCategory;
  readonly categoryLabel: string;
  readonly description: string;
  readonly dataClass: N8nEventDataClass;
  readonly containsPersonalData: boolean;
  readonly piiNotice: string;
  /**
   * Rein synthetisches Beispiel für `body.payload`. Transportfelder wie
   * `eventId`, `deliveryId`, `tenantId` und `occurredAt` gehören zum Envelope.
   */
  readonly examplePayload: Readonly<Record<string, unknown>>;
}

type N8nEventCatalogDetails = Omit<N8nEventCatalogEntry, 'name'>;

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const CLIENT_ID = '00000000-0000-4000-8000-000000000002';
const REQUEST_ID = '00000000-0000-4000-8000-000000000003';
const DOCUMENT_ID = '00000000-0000-4000-8000-000000000004';
const STAFF_ID = '00000000-0000-4000-8000-000000000005';
const INVOICE_ID = '00000000-0000-4000-8000-000000000006';

/**
 * Metadaten zu jedem statischen Event. `satisfies Record<StaticN8nEventName,
 * ...>` macht fehlende oder veraltete Katalogeinträge zu einem Compile-
 * Fehler; die exportierte Liste wird zusätzlich direkt aus
 * `STATIC_EVENT_NAMES` erzeugt und kann daher nicht anders sortiert sein.
 */
const STATIC_EVENT_DETAILS = {
  'client.created': {
    label: 'Mandant angelegt',
    category: 'CLIENTS',
    categoryLabel: 'Mandanten',
    description: 'Wird ausgelöst, nachdem eine neue Mandantenakte angelegt wurde.',
    dataClass: 'PROFESSIONAL_SECRET',
    containsPersonalData: true,
    piiNotice:
      'Mandantenbezug und interne Kennungen unterliegen dem Berufsgeheimnis; nur notwendige Daten nachladen.',
    examplePayload: { tenantId: TENANT_ID, clientId: CLIENT_ID },
  },
  'client.handover.ready': {
    label: 'Mandantenübergabe bereit',
    category: 'CLIENTS',
    categoryLabel: 'Mandanten',
    description:
      'Meldet, dass ein vorbereitetes Übergabepaket zur weiteren Verarbeitung bereitsteht.',
    dataClass: 'PROFESSIONAL_SECRET',
    containsPersonalData: true,
    piiNotice:
      'Übergaben können umfangreiche Mandanten- und Dokumentdaten erschließen; Zugriff und Empfänger eng begrenzen.',
    examplePayload: {
      tenantId: TENANT_ID,
      clientId: CLIENT_ID,
      handoverId: '00000000-0000-4000-8000-000000000007',
      label: 'Synthetische Übergabe',
    },
  },
  'document.uploaded': {
    label: 'Dokument hochgeladen',
    category: 'DOCUMENTS',
    categoryLabel: 'Dokumente',
    description: 'Wird ausgelöst, nachdem ein Dokument in TaxTronik gespeichert wurde.',
    dataClass: 'PROFESSIONAL_SECRET',
    containsPersonalData: true,
    piiNotice:
      'Metadaten und nachgeladene Inhalte können Steuer- und Personaldaten enthalten; Dokumente nicht ungeprüft weiterleiten.',
    examplePayload: {
      tenantId: TENANT_ID,
      documentId: DOCUMENT_ID,
      clientId: CLIENT_ID,
      classification: 'GENERAL',
      isGobd: false,
    },
  },
  'request.opened': {
    label: 'Anforderung eröffnet',
    category: 'REQUESTS',
    categoryLabel: 'Anforderungen',
    description: 'Meldet eine neu eröffnete Unterlagen- oder Informationsanforderung.',
    dataClass: 'PROFESSIONAL_SECRET',
    containsPersonalData: true,
    piiNotice:
      'Die Kennungen stellen einen Mandantenbezug her; Details nur über freigegebene Callback-Endpunkte abrufen.',
    examplePayload: {
      tenantId: TENANT_ID,
      requestId: REQUEST_ID,
      clientId: CLIENT_ID,
      priority: 'NORMAL',
    },
  },
  'request.responded': {
    label: 'Anforderung beantwortet',
    category: 'REQUESTS',
    categoryLabel: 'Anforderungen',
    description: 'Wird ausgelöst, wenn eine offene Anforderung beantwortet wurde.',
    dataClass: 'PROFESSIONAL_SECRET',
    containsPersonalData: true,
    piiNotice:
      'Antworten können sensible Mandanteninformationen erschließen; Payload und Ausführungsdaten minimieren.',
    examplePayload: { tenantId: TENANT_ID, requestId: REQUEST_ID, by: 'CLIENT_CONTACT' },
  },
  'request.closed': {
    label: 'Anforderung geschlossen',
    category: 'REQUESTS',
    categoryLabel: 'Anforderungen',
    description: 'Meldet den Abschluss einer Unterlagen- oder Informationsanforderung.',
    dataClass: 'PROFESSIONAL_SECRET',
    containsPersonalData: true,
    piiNotice:
      'Die Anforderungskennung ist mandantenbezogen; fachliche Details nur bei Bedarf nachladen.',
    examplePayload: { tenantId: TENANT_ID, requestId: REQUEST_ID },
  },
  'phone_note.created': {
    label: 'Telefonnotiz angelegt',
    category: 'COMMUNICATION',
    categoryLabel: 'Kommunikation',
    description: 'Wird ausgelöst, nachdem eine Telefonnotiz gespeichert wurde.',
    dataClass: 'PROFESSIONAL_SECRET',
    containsPersonalData: true,
    piiNotice:
      'Betreff und Notizinhalt können dem Berufsgeheimnis unterliegen; keine Klardaten in externe Systeme übertragen.',
    examplePayload: {
      tenantId: TENANT_ID,
      noteId: '00000000-0000-4000-8000-000000000008',
      forwardToStaff: STAFF_ID,
      subject: 'Synthetischer Rückrufhinweis',
    },
  },
  'appointment.responded': {
    label: 'Termin beantwortet',
    category: 'APPOINTMENTS',
    categoryLabel: 'Termine',
    description: 'Meldet die Annahme oder Ablehnung eines vorgeschlagenen Termins.',
    dataClass: 'PERSONAL_DATA',
    containsPersonalData: true,
    piiNotice:
      'Termin- und Anforderungskennungen sind personenbezogen; Kalenderziele und Aufbewahrung prüfen.',
    examplePayload: {
      tenantId: TENANT_ID,
      kind: 'appointment-accepted',
      appointmentId: '00000000-0000-4000-8000-000000000009',
      requestId: REQUEST_ID,
    },
  },
  'gwg.invite.created': {
    label: 'GwG-Einladung erstellt',
    category: 'COMPLIANCE',
    categoryLabel: 'Compliance',
    description:
      'Wird ausgelöst, nachdem ein GwG-Onboarding-Link für einen Mandanten ausgestellt wurde.',
    dataClass: 'PROFESSIONAL_SECRET',
    containsPersonalData: true,
    piiNotice:
      'Die Kennungen offenbaren einen GwG-Vorgang. Der geheime Einladungslink selbst ist absichtlich nicht im Payload enthalten.',
    examplePayload: {
      tenantId: TENANT_ID,
      clientId: CLIENT_ID,
      gwgInviteId: '00000000-0000-4000-8000-000000000012',
      gwgCheckId: '00000000-0000-4000-8000-000000000013',
    },
  },
  'gwg.verified': {
    label: 'GwG-Prüfung verifiziert',
    category: 'COMPLIANCE',
    categoryLabel: 'Compliance',
    description:
      'Wird nach der ausdrücklichen Berufsträger-Freigabe eines GwG-Prüfsnapshots ausgelöst.',
    dataClass: 'PROFESSIONAL_SECRET',
    containsPersonalData: true,
    piiNotice:
      'Der GwG-Prüfstatus ist besonders schutzbedürftig; Empfänger und Zweck strikt begrenzen.',
    examplePayload: {
      tenantId: TENANT_ID,
      clientId: CLIENT_ID,
      gwgCheckId: '00000000-0000-4000-8000-000000000013',
      validUntil: '2027-07-16T00:00:00.000Z',
    },
  },
  'gwg.expired': {
    label: 'GwG-Prüfung abgelaufen',
    category: 'COMPLIANCE',
    categoryLabel: 'Compliance',
    description: 'Wird ausgelöst, wenn eine GwG-Prüfung abläuft oder ihre Freigabe verliert.',
    dataClass: 'PROFESSIONAL_SECRET',
    containsPersonalData: true,
    piiNotice:
      'GwG-Status ist besonders schutzbedürftiger Compliance-Kontext; Empfänger und Zweck strikt begrenzen.',
    examplePayload: { tenantId: TENANT_ID, clientId: CLIENT_ID, reason: 'expired' },
  },
  'invoice.due': {
    label: 'Rechnung fällig',
    category: 'BILLING',
    categoryLabel: 'Rechnungen',
    description: 'Meldet eine fällige Rechnung, beispielsweise für einen Erinnerungsworkflow.',
    dataClass: 'PROFESSIONAL_SECRET',
    containsPersonalData: true,
    piiNotice:
      'Rechnungs- und Mandantenbezug fallen unter das Berufsgeheimnis; Beträge nur bei fachlicher Notwendigkeit abrufen.',
    examplePayload: { tenantId: TENANT_ID, invoiceId: INVOICE_ID },
  },
  'invoice.storno': {
    label: 'Stornorechnung erstellt',
    category: 'BILLING',
    categoryLabel: 'Rechnungen',
    description: 'Wird ausgelöst, nachdem ein Storno- oder Korrekturbeleg erstellt wurde.',
    dataClass: 'PROFESSIONAL_SECRET',
    containsPersonalData: true,
    piiNotice:
      'Korrekturbelege enthalten vertrauliche Abrechnungsdaten; nicht wie eine fällige Zahlung behandeln.',
    examplePayload: { tenantId: TENANT_ID, invoiceId: INVOICE_ID },
  },
  'staff.locked': {
    label: 'Mitarbeiterkonto gesperrt',
    category: 'STAFF',
    categoryLabel: 'Mitarbeiter',
    description: 'Meldet die Sperrung eines Mitarbeiterkontos.',
    dataClass: 'PERSONAL_DATA',
    containsPersonalData: true,
    piiNotice:
      'Kontostatus und Mitarbeiterkennung sind personenbezogene Beschäftigtendaten; nur an berechtigte Stellen senden.',
    examplePayload: { tenantId: TENANT_ID, staffId: STAFF_ID },
  },
  'staff.vacation_requested': {
    label: 'Urlaub beantragt',
    category: 'STAFF',
    categoryLabel: 'Mitarbeiter',
    description: 'Wird ausgelöst, wenn ein Mitarbeiter einen Urlaubsantrag einreicht.',
    dataClass: 'PERSONAL_DATA',
    containsPersonalData: true,
    piiNotice:
      'Urlaubs- und Beschäftigtendaten nur an entscheidungsberechtigte Personen und Systeme übermitteln.',
    examplePayload: {
      tenantId: TENANT_ID,
      requestId: '00000000-0000-4000-8000-000000000010',
      staffId: STAFF_ID,
      workdays: 5,
    },
  },
  'risk.research_requested': {
    label: 'Rechtsrecherche angefordert',
    category: 'RESEARCH',
    categoryLabel: 'Recherche',
    description: 'Meldet eine zur Bearbeitung freigegebene, anonymisierte Rechtsrecherche.',
    dataClass: 'PROFESSIONAL_SECRET',
    containsPersonalData: false,
    piiNotice:
      'Der Payload soll anonymisiert sein, bleibt aber vertraulich und kann durch Kontext re-identifizierbar werden; vor Weitergabe prüfen.',
    examplePayload: {
      researchRequestId: '00000000-0000-4000-8000-000000000011',
      rechtsfrage: 'Welche Rechtsfolge gilt im synthetischen Fall [MANDANT_1]?',
      normAnker: ['§ 1 BeispielG'],
      governanceTyp: 'RECHTSFRAGE',
      anonymizedText: 'Synthetischer Sachverhalt ohne Echtdaten.',
      katalogVersion: 'synthetic-v1',
    },
  },
  'taxtronik.ping': {
    label: 'Verbindungstest',
    category: 'SYSTEM',
    categoryLabel: 'System',
    description: 'Synthetisches Ereignis zum Prüfen einer eingerichteten n8n-Verbindung.',
    dataClass: 'TECHNICAL',
    containsPersonalData: false,
    piiNotice: 'Enthält keine Fachdaten; ausschließlich synthetische Testwerte verwenden.',
    examplePayload: { from: 'taxtronik-settings-ui' },
  },
} as const satisfies Record<StaticN8nEventName, N8nEventCatalogDetails>;

/** Vollständiger, in Event-Reihenfolge stabiler Katalog für UI und Doku. */
export const N8N_EVENT_CATALOG: readonly N8nEventCatalogEntry[] = STATIC_EVENT_NAMES.map(
  (name) => ({ name, ...STATIC_EVENT_DETAILS[name] }),
);

/** Direkter Lookup ohne eine zweite, driftanfällige Event-Liste. */
export const N8N_EVENT_CATALOG_BY_NAME = Object.fromEntries(
  N8N_EVENT_CATALOG.map((entry) => [entry.name, entry]),
) as Readonly<Record<StaticN8nEventName, N8nEventCatalogEntry>>;

export const STATIC_EVENT_WHITELIST = new Set<string>(STATIC_EVENT_NAMES);

/**
 * Workflow-Step-Suffix: lowercase + Ziffern + `_-`, kein Punkt (L-7).
 * Beispiele: `workflow.step.onboarding_done`, `workflow.step.review-required`.
 */
export const WORKFLOW_STEP_RE = /^workflow\.step\.[a-z][a-z0-9_-]{0,40}$/;

/**
 * Prüft, ob ein Event-Name in der Whitelist ist (statisch oder Workflow-Step).
 * Wird sowohl beim Outbox-Insert als auch beim Worker-Deliver aufgerufen —
 * Defense in Depth gegen direkte DB-Manipulation an `n8n_outbox.event`.
 */
export function isAllowedN8nEvent(event: string): boolean {
  return STATIC_EVENT_WHITELIST.has(event) || WORKFLOW_STEP_RE.test(event);
}

/**
 * Nur ein reiner technischer Ping darf direkt an einer Production-URL
 * verifiziert werden. Sobald mindestens ein Fach- oder Workflow-Step-Event
 * abonniert ist, muss TaxTronik synthetische Tests an `/webhook-test/` senden.
 */
export function requiresSeparateTestWebhook(events: readonly string[]): boolean {
  return events.some((event) => event !== 'taxtronik.ping');
}

export interface OutboundSignature {
  signature: string;
  timestamp: string;
  event: string;
  nonce: string;
}

/**
 * Signiert einen Outbound-Request für n8n.
 *
 * Payload: `event \n timestamp \n nonce \n body`
 * Format:  `sha256=<hex(HMAC-SHA256(payload, secret))>`
 *
 * Header-Set:
 *   - x-taxtronik-signature: sha256=<hex>
 *   - x-taxtronik-timestamp: <epoch-ms>
 *   - x-taxtronik-event:     <event>
 *   - x-taxtronik-nonce:     <hex>
 *
 * Begründungen:
 *   - M-8 (event mitsignieren): Replay über andere n8n-Trigger verhindert.
 *   - Audit Round 14, Finding 5 (nonce): jede Anfrage hat eine fresh
 *     128-Bit-Nonce. n8n-Empfänger SOLLEN sie als Replay-Schutz nutzen
 *     (z. B. via Function-Node mit Workflow-Static-Data-Set, das die
 *     letzten N Nonces hält). Bis n8n das umsetzt, ist die Nonce
 *     defense-in-depth — bei Reuse müsste ein Angreifer auch das HMAC
 *     vom alten Payload mitspielen, aber wenn n8n den Replay erkennt
 *     ist die Anfrage abgelehnt.
 */
export function signOutboundN8n(
  event: string,
  body: string,
  hmacSecret: string,
): OutboundSignature {
  const ts = Date.now();
  const nonce = randomBytes(16).toString('hex');
  const payloadToSign = `${event}\n${ts}\n${nonce}\n${body}`;
  const hex = createHmac('sha256', hmacSecret).update(payloadToSign).digest('hex');
  return { signature: `sha256=${hex}`, timestamp: String(ts), event, nonce };
}
