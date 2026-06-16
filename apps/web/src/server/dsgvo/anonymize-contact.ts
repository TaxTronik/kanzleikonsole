// =============================================================================
// Geteilte Contact-Anonymisierung (DSGVO Art. 17) — innerhalb einer bestehenden
// Tenant-Tx. Zwei Aufrufer:
//   - Einzel-Anonymisierung auf Betroffenen-Antrag (admin/dsgvo)
//   - Mandanten-Anonymisierung nach Fristablauf (admin/dsgvo-retention) —
//     anonymisiert die verknüpften Kontakte mit.
// Session-Revocation (Redis, außerhalb der Tx) macht der Aufrufer NACH der Tx.
// =============================================================================

import type { TxClient } from '@taxtronik/db';
import { evidenceService } from '@/server/container';

/** True, wenn die E-Mail bereits das Anonymisierungs-Schema trägt. */
export function isAnonymizedContactEmail(email: string): boolean {
  return email.startsWith('anonymized-') && email.endsWith('@taxtronik.local');
}

/**
 * Anonymisiert einen Client-Contact: E-Mail/Name überschreiben, Konto
 * deaktivieren, offene Magic-Links der Person verbrauchen, Audit-Event
 * (dsgvo.anonymize.contact). Liefert null, wenn der Kontakt nicht existiert.
 *
 * `personalDataInAudit`: bei der Einzel-Anonymisierung auf Betroffenen-Antrag
 * dokumentiert das before/after im Audit-Log, WESSEN Daten anonymisiert wurden
 * (Rechenschaft Art. 5 Abs. 2; Audit-Log ist insert-only). Bei der
 * fristgetriebenen Mandanten-Anonymisierung dagegen bewusst false — nach
 * Ablauf ALLER Aufbewahrungsfristen sollen keine Personendaten erneut in die
 * Hash-Chain geschrieben werden (analog gwg.check.destroy: nur Zähler).
 */
export async function anonymizeContactInTx(
  tx: TxClient,
  opts: { tenantId: string; staffId: string; contactId: string; personalDataInAudit: boolean },
): Promise<{ contactId: string } | null> {
  const { tenantId, staffId, contactId } = opts;
  const before = await tx.clientContact.findUnique({ where: { id: contactId } });
  if (!before) return null;

  const anonymizedAt = new Date().toISOString();
  // randomUUID statt Date.now() — bei zwei Anonymisierungen in derselben
  // Millisekunde würde Unique-Constraint (tenant_id, email) sonst kollidieren.
  const anonymousEmail = `anonymized-${crypto.randomUUID()}@taxtronik.local`;

  await tx.clientContact.update({
    where: { id: contactId },
    data: {
      email: anonymousEmail,
      fullName: 'Anonymisiert',
      // phone/role sind ebenfalls personenbezogene Daten (Durchwahl,
      // Funktionsbezeichnung wie „Geschäftsführer") → mit-nullen.
      phone: null,
      role: null,
      active: false,
    },
  });
  // Magic-Links der Person ungültig machen (consumed)
  await tx.magicLink.updateMany({
    where: {
      tenantId,
      consumedAt: null,
      OR: [
        { contactId },
        { contactId: null, email: before.email },
      ],
    },
    data: { consumedAt: new Date() },
  });
  await evidenceService.record(tx, {
    tenantId,
    actorType: 'STAFF',
    actorId: staffId,
    action: 'dsgvo.anonymize.contact',
    resourceType: 'client_contact',
    resourceId: contactId,
    before: opts.personalDataInAudit
      ? { email: before.email, fullName: before.fullName }
      : { anonymized: false },
    after: opts.personalDataInAudit
      ? { email: anonymousEmail, fullName: 'Anonymisiert', anonymizedAt }
      : { anonymized: true, anonymizedAt },
  });
  return { contactId };
}
