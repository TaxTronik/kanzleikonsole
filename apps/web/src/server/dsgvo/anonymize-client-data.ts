// =============================================================================
// Personentragende Nebentabellen der Mandanten-Anonymisierung (DSGVO Art. 17)
// — innerhalb der bestehenden Anonymisierungs-Tx von
// /staff/admin/dsgvo-retention (confirmClientAnonymizationAction).
//
// Läuft NUR nach Ablauf ALLER einschlägigen Aufbewahrungsfristen (insbesondere
// Handakte nach § 66 StBerG sowie dokumenttypabhängig 6/8/10 J. nach § 147 AO
// und grundsätzlich 5 J. nach § 8 Abs. 4 GwG) — personenbezogene Reste in
// Nebentabellen haben dann keine Rechtsgrundlage mehr. NOT-NULL-Felder bekommen den Platzhalter
// „Anonymisiert", nullable Felder werden genullt. Keine Schema-Änderungen;
// GoBD-pflichtige Objekte (invoice, document/Object-Lock, tax_*, bwa_*,
// time_entry) bleiben bewusst unberührt (eigene Retention-Pfade).
// =============================================================================

import { Prisma } from '@taxtronik/db/prisma-client';
import type { Prisma as PrismaTypes } from '@prisma/client';
import type { TxClient } from '@taxtronik/db';

/** Zähler je Datenklasse — landen im Audit-Event `client.anonymize`. */
export interface ClientSideTableAnonymization {
  poaSignersAnonymized: number;
  gwgInvitesDeleted: number;
  formSubmissionAnswersAnonymized: number;
  appointmentsAnonymized: number;
  appointmentRequestsDeleted: number;
  remindersAnonymized: number;
  pendingBindersAnonymized: number;
  handoversAnonymized: number;
  riskAnalysesCleared: number;
  riskMarkingsCleared: number;
}

/** Exaktes Zielbild der PoA-Personendaten-Redaktion nach Fristablauf. */
export const POA_RETENTION_REDACTION: PrismaTypes.PowerOfAttorneyUpdateManyMutationInput = {
  signerContactId: null,
  signerName: 'Anonymisiert',
  signerEmail: 'anonymisiert@taxtronik.local',
  subject: 'Anonymisiert',
  scope: 'Anonymisiert',
  signingTokenHash: null,
  signingTokenExpiresAt: null,
  signingOtpHash: null,
  signingOtpExpiresAt: null,
  signingOtpAttempts: 0,
  signingOtpAttemptsTotal: 0,
  signingContentSnapshot: null,
  signingContentSha256: null,
  signingDocumentVersionId: null,
  signedAt: null,
  signedContentSha256: null,
  signedDocumentVersionId: null,
  signedByIp: null,
  signedByUserAgent: null,
  documentId: null,
  revokedReason: null,
};

/** Erkennt PoAs, in denen noch redaktionspflichtige Personen-/Inhaltsdaten liegen. */
export const POA_PERSONAL_DATA_PRESENT_WHERE = {
  OR: [
    { signerContactId: { not: null } },
    { signerName: { not: 'Anonymisiert' } },
    { signerEmail: { not: 'anonymisiert@taxtronik.local' } },
    { subject: { not: 'Anonymisiert' } },
    { scope: { not: 'Anonymisiert' } },
    { signingTokenHash: { not: null } },
    { signingTokenExpiresAt: { not: null } },
    { signingOtpHash: { not: null } },
    { signingOtpExpiresAt: { not: null } },
    { signingOtpAttempts: { not: 0 } },
    { signingOtpAttemptsTotal: { not: 0 } },
    { signingContentSnapshot: { not: null } },
    { signingContentSha256: { not: null } },
    { signingDocumentVersionId: { not: null } },
    { signedAt: { not: null } },
    { signedContentSha256: { not: null } },
    { signedDocumentVersionId: { not: null } },
    { signedByIp: { not: null } },
    { signedByUserAgent: { not: null } },
    { documentId: { not: null } },
    { revokedReason: { not: null } },
  ],
} satisfies PrismaTypes.PowerOfAttorneyWhereInput;

/**
 * Redigiert ausschließlich noch vorhandene PoA-Personendaten. Wird sowohl von
 * der NATPERS-Gesamtanonymisierung als auch vom separaten Signer-Pfad für
 * JURPERS/PERSGES verwendet.
 */
export async function redactClientPoaPersonalDataInTx(
  tx: TxClient,
  clientId: string,
): Promise<number> {
  const poa = await tx.powerOfAttorney.updateMany({
    where: { clientId, AND: [POA_PERSONAL_DATA_PRESENT_WHERE] },
    data: POA_RETENTION_REDACTION,
  });
  return poa.count;
}

/**
 * Anonymisiert/löscht die personentragenden Nebentabellen eines Mandanten.
 * `contactIds`: die (mit-anonymisierten) Kontakte des Mandanten — für
 * Submissions, die über `submittedByContact` statt `clientId` hängen.
 */
export async function anonymizeClientSideTablesInTx(
  tx: TxClient,
  opts: { clientId: string; contactIds: string[] },
): Promise<ClientSideTableAnonymization> {
  const { clientId, contactIds } = opts;

  // Vollmachten: Nach Ablauf aller Retentionfristen wird auch der beim Versand
  // gebundene Personen-/Inhaltssnapshot redigiert. Die Dokumentobjekte selbst
  // durchlaufen vorher ihren eigenen Retentionpfad; die verbliebene Referenz
  // wird hier nur gelöst. NOT-NULL-Textfelder bekommen einen Platzhalter.
  // Das exakte Gesamtmuster ist zugleich die eng begrenzte DB-Trigger-Ausnahme
  // von der ansonsten dauerhaften PoA-Immutability.
  const poaSignersAnonymized = await redactClientPoaPersonalDataInTx(tx, clientId);

  // GwG-Onboarding-Invites: tragen inviteEmail/-Name + Submit-IP/UA und haben
  // nach Mandatsende + Fristablauf keinen Zweck mehr → löschen (keine
  // eingehenden FKs auf gwg_onboarding_invite; die GwG-Aufzeichnungen selbst
  // sind laut Vorbedingung bereits über die GwG-Queue vernichtet).
  const gwgInvites = await tx.gwgOnboardingInvite.deleteMany({ where: { clientId } });

  // Formular-Antworten: freies Json mit beliebigen Personendaten. Antworten
  // durch Marker ersetzen, Metadaten (Template, Status, Zeitstempel) behalten.
  // Über clientId ODER über die Kontakte des Mandanten eingereicht.
  const formSubmissions = await tx.formSubmission.updateMany({
    where: { OR: [{ clientId }, { submittedByContact: { in: contactIds } }] },
    data: { answers: { anonymized: true } },
  });

  // Termine: title ist NOT NULL → Platzhalter; notes/location (z. B.
  // Privatadresse des Mandanten als Treffpunkt) → null. Zeiträume bleiben.
  const appointments = await tx.appointment.updateMany({
    where: { clientId },
    data: { title: 'Anonymisiert', notes: null, location: null },
  });

  // Terminanfragen kommen vom Portal-Kontakt (subject/notes/proposedSlots)
  // und sind nach der Anonymisierung zwecklos → löschen.
  // appointment.from_request_id hat ON DELETE SET NULL — daraus entstandene
  // Termine bleiben (oben anonymisiert), verlieren nur die Referenz.
  const appointmentRequests = await tx.appointmentRequest.deleteMany({ where: { clientId } });

  // Wiedervorlagen: subject ist NOT NULL → Platzhalter; notes → null.
  const reminders = await tx.clientReminder.updateMany({
    where: { clientId },
    data: { subject: 'Anonymisiert', notes: null },
  });

  // Pendelordner: label ist NOT NULL → Platzhalter; contents (Inhaltsliste,
  // Freitext) → null.
  const pendingBinders = await tx.pendingBinder.updateMany({
    where: { clientId },
    data: { label: 'Anonymisiert', contents: null },
  });

  // Übergaben: label NOT NULL → Platzhalter; contents + notifiedContactEmail
  // (Klartext-Kopie der Kontakt-E-Mail!) → null.
  const handovers = await tx.clientHandover.updateMany({
    where: { clientId },
    data: { label: 'Anonymisiert', contents: null, notifiedContactEmail: null },
  });

  // Risiko-Analysen: der Sachverhalt (sourceText NOT NULL → '', sourceDoc als
  // Rich-Doc-Kopie → DbNull) enthält den Lebenssachverhalt des Mandanten.
  // Analyse-Metadaten (Hash, Engine-/Katalog-Version, Archiv-Referenzen)
  // bleiben als Nachweis bestehen.
  const riskAnalyses = await tx.riskAnalysis.updateMany({
    where: { clientId },
    data: { sourceText: '', sourceDoc: Prisma.DbNull },
  });

  // Markierungen zitieren den Sachverhalt wörtlich (matchedText) bzw. tragen
  // Freitext-Notizen — sie würden das Leeren von sourceText sonst unterlaufen.
  const riskMarkings = await tx.riskMarking.updateMany({
    where: { analysis: { clientId } },
    data: { matchedText: '', notiz: null },
  });

  return {
    poaSignersAnonymized,
    gwgInvitesDeleted: gwgInvites.count,
    formSubmissionAnswersAnonymized: formSubmissions.count,
    appointmentsAnonymized: appointments.count,
    appointmentRequestsDeleted: appointmentRequests.count,
    remindersAnonymized: reminders.count,
    pendingBindersAnonymized: pendingBinders.count,
    handoversAnonymized: handovers.count,
    riskAnalysesCleared: riskAnalyses.count,
    riskMarkingsCleared: riskMarkings.count,
  };
}
