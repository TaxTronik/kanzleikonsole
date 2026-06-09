// =============================================================================
// Personentragende Nebentabellen der Mandanten-Anonymisierung (DSGVO Art. 17)
// — innerhalb der bestehenden Anonymisierungs-Tx von
// /staff/admin/dsgvo-retention (confirmClientAnonymizationAction).
//
// Läuft NUR nach Ablauf ALLER Aufbewahrungsfristen (GoBD § 147 AO 10 J. >
// GwG § 8 Abs. 4 5 J.) — personenbezogene Reste in Nebentabellen haben dann
// keine Rechtsgrundlage mehr. NOT-NULL-Felder bekommen den Platzhalter
// „Anonymisiert", nullable Felder werden genullt. Keine Schema-Änderungen;
// GoBD-pflichtige Objekte (invoice, document/Object-Lock, tax_*, bwa_*,
// time_entry) bleiben bewusst unberührt (eigene Retention-Pfade).
// =============================================================================

import { Prisma } from '@prisma/client';
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

  // Vollmachten: NUR die DB-Personenfelder — die Vollmachts-DOKUMENTE
  // unterliegen der Dokument-Retention (Object-Lock), nicht diesem Pfad.
  // signerName/signerEmail sind NOT NULL → Platzhalter; IP/UA sind nullable.
  const poa = await tx.powerOfAttorney.updateMany({
    where: { clientId },
    data: {
      signerName: 'Anonymisiert',
      signerEmail: 'anonymisiert@taxtronik.local',
      signedByIp: null,
      signedByUserAgent: null,
    },
  });

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
    poaSignersAnonymized: poa.count,
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
