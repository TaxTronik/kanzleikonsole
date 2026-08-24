// =============================================================================
// „Anforderung eröffnet" — zentrale Mandanten-Benachrichtigung.
//
// Single Source für manuell angelegte Requests (createRequestCore in der
// Web-App) UND automatisch erzeugte Requests (Steuertermin-Materialisierung im
// Worker). Kapselt Portal-URL, Template-Vars, n8n-Payload und den Fallback-
// Text, damit beide Pfade exakt dieselbe Mandanten-Mail versenden.
// =============================================================================

import { portalBaseUrl } from '@taxtronik/config';
import {
  notifyClientContacts,
  type ContactNotificationResult,
  type TemplateFallback,
} from './dispatch';

export const REQUEST_OPENED_FALLBACK: TemplateFallback = {
  subject: 'Neue Anforderung von Ihrer Kanzlei: {{request.title}}',
  bodyMd:
    'Sehr geehrte/r {{contact.fullName}},\n\nin Ihrem Mandantenportal liegt eine neue Anforderung für Sie bereit:\n\n**{{request.title}}**\n\n{{request.description}}\n\nBitte öffnen Sie das Portal:\n{{portalUrl}}',
};

/**
 * Automatische Steuertermin-Anforderungen verwenden einen eigenen, bewusst
 * datenminimierten Template-Scope. Steuerart, Zeitraum, Fälligkeit, Titel und
 * Beschreibung bleiben ausschließlich im geschützten Portal und stehen auch
 * einem konfigurierbaren Mail-Template nicht als Variablen zur Verfügung.
 */
export const AUTOMATIC_TAX_REQUEST_OPENED_FALLBACK: TemplateFallback = {
  subject: 'Neue Anforderung in Ihrem Mandantenportal',
  bodyMd:
    'Sehr geehrte/r {{contact.fullName}},\n\nin Ihrem Mandantenportal liegt eine neue Anforderung für Sie bereit. Die Einzelheiten finden Sie ausschließlich im geschützten Portal:\n\n{{portalUrl}}',
};

export interface RequestOpenedInput {
  tenantId: string;
  clientId: string;
  requestId: string;
  title: string;
  description: string;
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
  /** Fälligkeit als ISO-String für den n8n-Payload; null wenn keine gesetzt. */
  dueAtIso: string | null;
}

export interface AutomaticTaxRequestOpenedInput {
  tenantId: string;
  clientId: string;
  requestId: string;
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
  /** Fälligkeit nur für den internen n8n-Event-Payload, nie als Mail-Variable. */
  dueAtIso: string | null;
}

export async function notifyRequestOpened(
  input: RequestOpenedInput,
): Promise<ContactNotificationResult> {
  const portalUrl = `${portalBaseUrl}/portal/requests/${input.requestId}`;
  return notifyClientContacts({
    tenantId: input.tenantId,
    clientId: input.clientId,
    slug: 'request-opened',
    vars: {
      request: {
        id: input.requestId,
        title: input.title,
        description: input.description,
        priority: input.priority,
      },
      portalUrl,
    },
    n8nEvent: 'request.opened',
    n8nPayload: {
      tenantId: input.tenantId,
      requestId: input.requestId,
      clientId: input.clientId,
      priority: input.priority,
      dueAt: input.dueAtIso,
    },
    fallback: REQUEST_OPENED_FALLBACK,
  });
}

export async function notifyAutomaticTaxRequestOpened(
  input: AutomaticTaxRequestOpenedInput,
): Promise<ContactNotificationResult> {
  const portalUrl = `${portalBaseUrl}/portal/requests/${input.requestId}`;
  return notifyClientContacts({
    tenantId: input.tenantId,
    clientId: input.clientId,
    slug: 'tax-deadline-request-opened',
    // TAX-DEADLINE-AUTOREQUEST-001: Auch bei derselben Kontaktadresse fuer
    // mehrere Profile keinen Mandantennamen in den neutralen Betreff nehmen.
    // Die eindeutige Zuordnung erfolgt erst hinter dem geschuetzten Portal-Link.
    subjectSuffix: '',
    vars: {
      request: { id: input.requestId },
      portalUrl,
    },
    n8nEvent: 'request.opened',
    n8nPayload: {
      tenantId: input.tenantId,
      requestId: input.requestId,
      clientId: input.clientId,
      priority: input.priority,
      dueAt: input.dueAtIso,
    },
    fallback: AUTOMATIC_TAX_REQUEST_OPENED_FALLBACK,
  });
}
