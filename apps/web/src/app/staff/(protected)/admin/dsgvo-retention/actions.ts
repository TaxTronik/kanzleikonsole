'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { revokeAllSessions } from '@/server/auth/revocation';
import { isClientAnonymizationDue } from '@/server/dsgvo/client-retention';
import { anonymizeContactInTx, isAnonymizedContactEmail } from '@/server/dsgvo/anonymize-contact';
import { staffActionGuard, type ActionResult as BaseActionResult } from '@/server/actions/staff-action';

export type ActionResult = BaseActionResult;

/**
 * Bestätigte DSGVO-Anonymisierung (Art. 17) eines beendeten Mandats nach
 * Ablauf ALLER Aufbewahrungsfristen — der Berufsträger löst sie aus
 * (Review-Queue, kein Auto-Anonymisieren). Nur natürliche Personen (NATPERS):
 * Stammdaten (Name, Adresse, USt-ID, Notizen, externe Nummern) werden genullt,
 * Custom-Feld-Werte gelöscht, verknüpfte Kontakte mit-anonymisiert. Ein
 * Skelett-Datensatz (id, kind, Mandatsende, anonymizedAt als Vernichtungs-
 * vermerk) bleibt erhalten. Defense in Depth: prüft Mandantentyp + gesetzliche
 * Frist + GwG-Vorbedingung erneut server-seitig.
 */
export async function confirmClientAnonymizationAction(input: { clientId: string }): Promise<ActionResult> {
  // DSGVO-Anonymisierung ist Compliance-Hoheit → ADMIN/PARTNER.
  const g = await staffActionGuard({ requireAdmin: true });
  if (!g.ok) return g;
  const { tenantId, staffId, ctx } = g;

  const parsed = z.object({ clientId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { clientId } = parsed.data;

  // Für die Session-Revocation NACH der Tx (Redis, nicht transaktional).
  const anonymizedContactIds: string[] = [];

  const result = await withTenantContext(ctx, async (tx): Promise<ActionResult> => {
    // 1. Mandant laden (+ Frist- und Vorbedingungs-Daten).
    const client = await tx.client.findFirst({
      where: { id: clientId, tenantId },
      select: {
        id: true,
        kind: true,
        mandateEndedAt: true,
        anonymizedAt: true,
        contacts: { select: { id: true, email: true } },
        _count: {
          select: {
            documents: { where: { classification: 'GWG_EVIDENCE', deletedAt: null } },
            gwgChecks: { where: { destroyedAt: null } },
          },
        },
      },
    });
    if (!client) return { ok: false, error: 'Mandant nicht gefunden.' };
    if (client.kind !== 'NATPERS') {
      return { ok: false, error: 'Anonymisierung gilt nur für natürliche Personen (NATPERS).' };
    }
    if (client.anonymizedAt) return { ok: false, error: 'Mandant wurde bereits anonymisiert.' };

    // 2. Gesetzliche Frist abgelaufen? (Mandatsende-Jahresende + 10 J. — die
    //    längste Aufbewahrungsfrist, GoBD § 147 AO > GwG § 8 Abs. 4.)
    if (!isClientAnonymizationDue(client.mandateEndedAt)) {
      return { ok: false, error: 'Aufbewahrungsfristen noch nicht abgelaufen — Anonymisierung nicht zulässig.' };
    }

    // 3. GwG-Vernichtung zuerst: solange GwG-Belege oder -Aufzeichnungen des
    //    Mandanten existieren, ist die Stammdaten-Anonymisierung nicht dran
    //    (die GwG-Queue hat ihre eigene Vernichtungs-Semantik + Nachweise).
    if (client._count.documents > 0 || client._count.gwgChecks > 0) {
      return {
        ok: false,
        error: 'Es existieren noch GwG-Belege/-Aufzeichnungen — bitte zuerst über die GwG-Pflichtlöschung vernichten.',
      };
    }

    // 4. Stammdaten anonymisieren — Skelett bleibt (id, kind, Mandatsende,
    //    Vernichtungsvermerk). datevNo/addisonNo ebenfalls nullen: als
    //    Fremdsystem-Schlüssel wären die Daten sonst re-identifizierbar.
    const anonymizedAt = new Date();
    await tx.client.update({
      where: { id: clientId },
      data: {
        name: 'Anonymisiert',
        street: null,
        postalCode: null,
        city: null,
        countryIso: null,
        vatId: null,
        invoiceEmail: null,
        internalNotes: null,
        datevNo: null,
        addisonNo: null,
        allowActive: false,
        anonymizedAt,
      },
    });
    // Custom-Feld-Werte sind freie personenbezogene Stammdaten → löschen.
    const deletedCustomValues = await tx.clientCustomFieldValue.deleteMany({ where: { clientId } });

    // 5. Verknüpfte Kontakte mit-anonymisieren (geteilte Logik mit admin/dsgvo).
    //    Bereits anonymisierte Kontakte überspringen (idempotent, kein
    //    Doppel-Audit). personalDataInAudit: false — nach Fristablauf keine
    //    Personendaten erneut in die insert-only Hash-Chain schreiben.
    for (const contact of client.contacts) {
      if (isAnonymizedContactEmail(contact.email)) continue;
      const r = await anonymizeContactInTx(tx, {
        tenantId,
        staffId,
        contactId: contact.id,
        personalDataInAudit: false,
      });
      if (r) anonymizedContactIds.push(r.contactId);
    }

    // 6. Anonymisierung auditieren (audit_log ist insert-only → der Nachweis
    //    bleibt dauerhaft; bewusst nur Zähler, keine Personendaten im Event).
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'client.anonymize',
      resourceType: 'client',
      resourceId: clientId,
      before: {
        kind: client.kind,
        mandateEndedAt: client.mandateEndedAt?.toISOString() ?? null,
      },
      after: {
        anonymized: true,
        anonymizedAt: anonymizedAt.toISOString(),
        contactsAnonymized: anonymizedContactIds.length,
        customFieldValuesDeleted: deletedCustomValues.count,
      },
    });
    return { ok: true };
  });

  if (result.ok) {
    // Art. 17: aktive Portal-Sessions der mit-anonymisierten Kontakte sofort
    // revoken — sonst bliebe der JWT-Cookie bis 24 h gültig.
    for (const contactId of anonymizedContactIds) {
      await revokeAllSessions('portal', contactId);
    }
    revalidatePath('/staff/admin/dsgvo-retention');
    revalidatePath(`/staff/clients/${clientId}`);
  }
  return result;
}
