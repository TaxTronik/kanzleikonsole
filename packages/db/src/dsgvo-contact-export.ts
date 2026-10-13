// =============================================================================
// DSGVO-Auskunft (Art. 15/20) für einen Mandantenkontakt — Paketaufbau.
//
// Fachkatalog: DSGVO-CONTACT-EXPORT-001, DSGVO-REQUEST-EVIDENCE-001
//
// Welle 15 (Folgepunkt P-11): Die Erzeugung lief in einer 15-s-Transaktion des
// Webprozesses und wuchs linear mit dem Audit-Log. Der Paketaufbau liegt jetzt
// hier, unverändert aus der Server-Action übernommen (dieselben Abfragen,
// dieselbe Reihenfolge und Struktur, dieselbe Serialisierung), damit der Worker
// dsgvo-export ihn mit der App-Rolle im SYSTEM-Kontext ausführt. Der
// Gleichheitstest (dsgvo-contact-export.test.ts) vergleicht ihn mit der
// eingefrorenen Fassung vor Welle 15.
// =============================================================================

import { createHash } from 'node:crypto';
import { readPrivacyConfigTx, renderPrivacyNotice } from './privacy-notice';
import type { TxClient } from './tenant-context';

export type DsgvoContactExportErrorCode = 'REQUEST_NOT_OPEN' | 'CONTACT_NOT_FOUND';

/** Fachlicher Abbruch des Paketaufbaus (Antrag nicht mehr offen, Kontakt fehlt). */
export class DsgvoContactExportError extends Error {
  constructor(
    readonly code: DsgvoContactExportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DsgvoContactExportError';
  }
}

export interface DsgvoContactExportInput {
  tenantId: string;
  requestId: string;
  contactId: string;
  /** Staff-ID der Person, die das Paket angefordert hat (`exportedBy`). */
  exportedBy: string;
  /** Erzeugungszeitpunkt (`exportedAt`, resultPreparedAt). */
  generatedAt: Date;
}

export interface DsgvoContactExport {
  request: { id: string; status: string };
  contact: { id: string; email: string };
  /** Das Paket; Format seit DSGVO-CONTACT-EXPORT-001 unverändert. */
  exportData: Record<string, unknown>;
}

/** Serialisiert und hasht exakt dieselben Download-Bytes. */
export function serializeDsgvoExport(value: unknown): {
  serialized: string;
  sha256: Buffer;
} {
  const serialized = JSON.stringify(value, null, 2);
  return {
    serialized,
    sha256: createHash('sha256').update(serialized, 'utf8').digest(),
  };
}

/**
 * Sammelt die Datenklassen des Kontakts in der übergebenen Tenant-Transaktion
 * (RLS des Aufrufers). Verlangt einen offenen ACCESS-/PORTABILITY-Antrag für
 * genau diesen Kontakt.
 */
export async function buildDsgvoContactExport(
  tx: TxClient,
  input: DsgvoContactExportInput,
): Promise<DsgvoContactExport> {
  const { tenantId } = input;
  const request = await tx.dsgvoRequest.findFirst({
    where: {
      id: input.requestId,
      tenantId,
      subjectType: 'CLIENT_CONTACT',
      subjectRefId: input.contactId,
      type: { in: ['ACCESS', 'PORTABILITY'] },
      status: { in: ['RECEIVED', 'IN_PROGRESS'] },
    },
  });
  if (!request)
    throw new DsgvoContactExportError(
      'REQUEST_NOT_OPEN',
      'Passender offener DSGVO-Antrag nicht gefunden.',
    );

  const contact = await tx.clientContact.findUnique({
    where: { id: input.contactId },
    include: { client: { select: { id: true, name: true } } },
  });
  if (!contact) throw new DsgvoContactExportError('CONTACT_NOT_FOUND', 'Kontakt nicht gefunden.');

  // Alle Vorgänge dieser Person sammeln
  const responses = await tx.requestResponse.findMany({
    where: { authorType: 'CLIENT_CONTACT', authorId: input.contactId },
    select: {
      id: true,
      requestId: true,
      message: true,
      createdAt: true,
      request: { select: { title: true } },
    },
  });
  // N-7: Auskunftsanspruch nach Art. 15 DSGVO bezieht sich auf
  // personenbezogene Daten DES ANTRAGSTELLERS — nicht auf alle Dokumente
  // seines Mandanten. Bei einem Mandanten mit mehreren Kontakten bekäme
  // sonst jeder Kontakt im Export Metadaten von Dokumenten anderer
  // Personen.
  //
  // Wir filtern auf Dokumente, die im Audit-Trail eine Aktion DIESES
  // Kontakts haben (Upload via Portal, Antwort mit Anhang etc.) — das
  // ist die einzige zuverlässige Verknüpfung „Kontakt ↔ Dokument" im
  // Schema (Document.ownerStaffId zeigt auf Staff, nicht Contact).
  const auditDocs = await tx.auditLog.findMany({
    where: {
      tenantId,
      actorType: 'CLIENT_CONTACT',
      actorId: input.contactId,
      resourceType: 'document',
    },
    select: { resourceId: true },
    distinct: ['resourceId'],
  });
  const docIds = auditDocs
    .map((a) => a.resourceId)
    .filter((id): id is string => typeof id === 'string');
  const documents = docIds.length
    ? await tx.document.findMany({
        where: { id: { in: docIds } },
        select: { id: true, title: true, classification: true, createdAt: true },
      })
    : [];
  const magicLinks = await tx.magicLink.findMany({
    where: {
      tenantId,
      OR: [{ contactId: input.contactId }, { contactId: null, email: contact.email }],
    },
    select: {
      id: true,
      email: true,
      expiresAt: true,
      consumedAt: true,
      createdAt: true,
    },
  });

  // Art. 15/20: weitere Datenklassen mit Personenbezug des Antragstellers.
  // Verknüpfungs-Heuristiken (kommentiert, weil das Schema nicht überall
  // einen Kontakt-FK hat):
  //  - power_of_attorney: signerContactId (FK) ODER signerEmail-Match
  //    (citext → case-insensitiv) — Vollmachten tragen Name/E-Mail/IP
  //    des Unterzeichners.
  //  - appointment_request: createdByContact (FK).
  //  - form_submission: submittedByContact (FK); answers sind die von der
  //    Person selbst eingegebenen Daten (Art.-20-relevant).
  //  - phone_note: KEIN Kontakt-FK im Schema → Heuristik „gleicher Mandant
  //    + Anrufername == Kontaktname (case-insensitiv)". Kann Namens-
  //    gleiche Dritte treffen bzw. abweichende Schreibweisen verfehlen —
  //    der Sachbearbeiter prüft den Export vor Herausgabe ohnehin.
  const [
    powersOfAttorney,
    appointmentRequests,
    formSubmissions,
    phoneNotes,
    consents,
    masterChangeRequests,
    auditEntries,
    providers,
    tenant,
    privacyConfig,
  ] = await Promise.all([
    tx.powerOfAttorney.findMany({
      where: {
        OR: [{ signerContactId: input.contactId }, { signerEmail: contact.email }],
      },
      select: {
        id: true,
        subject: true,
        scope: true,
        status: true,
        signerName: true,
        signerEmail: true,
        signedAt: true,
        signedByIp: true,
        validFrom: true,
        validUntil: true,
      },
    }),
    tx.appointmentRequest.findMany({
      where: { createdByContact: input.contactId },
      select: {
        id: true,
        subject: true,
        notes: true,
        status: true,
        createdAt: true,
        decidedAt: true,
      },
    }),
    tx.formSubmission.findMany({
      where: { submittedByContact: input.contactId },
      select: {
        id: true,
        name: true,
        status: true,
        answers: true,
        submittedAt: true,
      },
    }),
    tx.phoneNote.findMany({
      where: {
        clientId: contact.clientId,
        callerName: { equals: contact.fullName, mode: 'insensitive' },
      },
      select: {
        id: true,
        subject: true,
        body: true,
        callerName: true,
        callerPhone: true,
        createdAt: true,
      },
    }),
    tx.clientConsent.findMany({
      where: { signedByContact: input.contactId },
      select: {
        id: true,
        noticeVersion: true,
        noticeSnapshot: true,
        consents: true,
        source: true,
        signedByName: true,
        isRevocation: true,
        note: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    }),
    tx.clientMasterChangeRequest.findMany({
      where: { contactId: input.contactId },
      select: {
        id: true,
        fields: true,
        note: true,
        status: true,
        createdAt: true,
        decidedAt: true,
        decisionNote: true,
      },
      orderBy: { createdAt: 'asc' },
    }),
    tx.auditLog.findMany({
      where: {
        tenantId,
        OR: [
          { actorType: 'CLIENT_CONTACT', actorId: input.contactId },
          { resourceType: 'client_contact', resourceId: input.contactId },
        ],
      },
      select: {
        id: true,
        occurredAt: true,
        actorType: true,
        actorId: true,
        action: true,
        resourceType: true,
        resourceId: true,
        before: true,
        after: true,
        ip: true,
        userAgent: true,
      },
      orderBy: { id: 'asc' },
    }),
    tx.serviceProvider.findMany({
      where: { tenantId, hasDataAccess: true },
      select: { name: true, category: true },
      orderBy: { name: 'asc' },
    }),
    tx.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
    readPrivacyConfigTx(tx, tenantId),
  ]);

  const privacyNotice = renderPrivacyNotice({
    kanzleiName: tenant?.name ?? 'Kanzlei',
    config: privacyConfig,
    providers,
  });
  const generatedAt = input.generatedAt;
  const exportData = {
    request: {
      id: request.id,
      type: request.type,
      receivedAt: request.receivedAt,
      subjectName: request.subjectName,
      subjectEmail: request.subjectEmail,
    },
    contact: {
      id: contact.id,
      email: contact.email,
      fullName: contact.fullName,
      phone: contact.phone,
      role: contact.role,
      notificationsEnabled: contact.notificationsEnabled,
      client: { id: contact.client.id, name: contact.client.name },
      createdAt: contact.createdAt,
      updatedAt: contact.updatedAt,
      lastLoginAt: contact.lastLoginAt,
      active: contact.active,
    },
    interactions: {
      requestResponses: responses,
      // Nur Dokumente, die über einen personenbezogenen Audit-Akteur
      // direkt mit diesem Kontakt verbunden sind — nie pauschal die ganze
      // Mandantenakte mit Daten Dritter.
      documentsActedOnByContact: documents,
      magicLinks,
      powersOfAttorney,
      appointmentRequests,
      formSubmissions,
      consents,
      masterChangeRequests,
      // Heuristik: gleicher Mandant + Anrufername == Kontaktname. Muss vor
      // Herausgabe personell auf Fehlzuordnungen geprüft werden.
      phoneNotes,
    },
    auditTrail: auditEntries.map((entry) => ({
      ...entry,
      id: entry.id.toString(),
    })),
    processingInformation: {
      purposes: [
        'Mandatsanbahnung und -bearbeitung',
        'Kommunikation und Dokumentenaustausch',
        'Erfüllung steuer-, berufs- und geldwäscherechtlicher Pflichten',
        'Abrechnung, Forderungsmanagement, IT-Sicherheit und Rechtsverteidigung',
      ],
      dataCategories: [
        'Stamm-, Identifikations- und Kontaktdaten',
        'Kommunikations-, Formular- und Portaldaten',
        'Mandats-, Vollmachts-, Dokument- und Abrechnungsmetadaten',
        'Technische Nachweisdaten wie Zeitstempel, IP-Adresse und User-Agent',
      ],
      recipientCategories: [
        'Finanzbehörden, Sozialversicherungsträger, Gerichte und sonstige mandatsbezogene Stellen',
        'Zur Verschwiegenheit verpflichtete Kanzleimitarbeiter und Berufsträger',
        ...providers.map((provider) => `${provider.name} (${provider.category})`),
      ],
      source:
        'Direkt von der betroffenen Person, vom vertretenen Mandanten sowie aus mandatsbezogenen Vorgängen und gesetzlichen Quellen.',
      retention:
        'Je Datenklasse nach Mandats-, Steuer-, Handels-, Berufs- und GwG-Aufbewahrung; Einschränkung oder Löschung nach Wegfall sämtlicher Zwecke und Pflichten.',
      automatedDecisionMaking: false,
      privacyNoticeSnapshot: privacyNotice,
      privacyContact: privacyConfig.privacyContact,
      supervisoryAuthority: privacyConfig.supervisoryAuthority,
    },
    coverage: {
      automaticLinks:
        'Der Export enthält sicher bzw. heuristisch mit diesem Kontakt verknüpfte Systemdaten.',
      manualReviewRequired: [
        'Telefonnotizen auf Namensgleichheit und mögliche Daten Dritter prüfen.',
        'Dokumentinhalte, Freitexte und Alt-/Importdaten auf weitere personenbezogene Angaben prüfen.',
        'Rechtsgrundlagen, Empfänger und konkrete Aufbewahrungsfristen fallbezogen ergänzen.',
        'Vor Herausgabe Daten Dritter schwärzen und Identität des Antragstellers prüfen.',
      ],
    },
    exportedAt: generatedAt.toISOString(),
    exportedBy: input.exportedBy,
  };

  return {
    request: { id: request.id, status: request.status },
    contact: { id: contact.id, email: contact.email },
    exportData,
  };
}
