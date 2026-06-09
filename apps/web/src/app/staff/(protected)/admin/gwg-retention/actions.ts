'use server';

import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { revalidatePath } from 'next/cache';
import { withTenantContext } from '@taxtronik/db';
import { deleteObject } from '@taxtronik/storage';
import { evidenceService } from '@/server/container';
import { isGwgDeletionDue } from '@/server/gwg/retention';
import { staffActionGuard, type ActionResult as BaseActionResult } from '@/server/actions/staff-action';

export type ActionResult = BaseActionResult;

/**
 * Bestätigte GwG-Pflichtvernichtung (§ 8 Abs. 4) eines löschreifen Beweis-
 * dokuments — der Berufsträger löst sie aus (Review-Queue, kein Auto-Delete).
 * Defense in Depth: prüft Klassifikation + gesetzliche Frist + Object-Lock
 * erneut server-seitig, bevor irgendetwas gelöscht wird.
 */
export async function confirmGwgDeletionAction(input: { documentId: string }): Promise<ActionResult> {
  // GwG-Vernichtung ist Compliance-Hoheit → ADMIN/PARTNER.
  const g = await staffActionGuard({ requireAdmin: true });
  if (!g.ok) return g;
  const { tenantId, staffId, ctx } = g;

  const parsed = z.object({ documentId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { documentId } = parsed.data;

  // 1. Beleg laden (+ Mandatsende, Object-Lock-Frist, Versionen).
  const loaded = await withTenantContext(ctx, (tx) =>
    tx.document.findFirst({
      where: { id: documentId, tenantId, classification: 'GWG_EVIDENCE', deletedAt: null },
      select: {
        id: true,
        title: true,
        clientId: true,
        retentionUntil: true,
        client: { select: { mandateEndedAt: true } },
        versions: { select: { id: true, storageBucket: true, storageKey: true } },
      },
    }),
  );
  if (!loaded) return { ok: false, error: 'GwG-Beleg nicht gefunden.' };

  // 2. Gesetzliche Löschfrist abgelaufen? (Mandatsende + 5 J., § 8 Abs. 4.)
  if (!isGwgDeletionDue(loaded.client?.mandateEndedAt ?? null)) {
    return { ok: false, error: 'Löschfrist noch nicht abgelaufen — Vernichtung nicht zulässig.' };
  }
  // 3. Object-Lock-Retain-Until abgelaufen? Sonst verweigert S3 die Löschung —
  //    wir brechen VOR jedem Byte-Delete ab (kein Halb-Zustand).
  if (loaded.retentionUntil && loaded.retentionUntil.getTime() > Date.now()) {
    return { ok: false, error: 'Object-Lock-Aufbewahrung läuft noch — Vernichtung erst nach Fristablauf möglich.' };
  }

  // 4. Bytes aus dem Store löschen (alle Versionen). Erst danach die DB-Records,
  //    damit kein DB-Eintrag ohne tatsächliche Vernichtung „gelöscht" gilt.
  try {
    for (const v of loaded.versions) {
      await deleteObject(v.storageBucket, v.storageKey);
    }
  } catch (e) {
    return { ok: false, error: `Vernichtung im Object-Store fehlgeschlagen: ${(e as Error).message}` };
  }

  // 5. DB-Records löschen + Vernichtung auditieren (audit_log ist insert-only →
  //    der Vernichtungs-Nachweis bleibt dauerhaft erhalten).
  try {
    await withTenantContext(ctx, async (tx) => {
      // GwG-Ausweis-Verweis entkoppeln, dann Versionen + Document löschen.
      await tx.gwgIdDocument.updateMany({ where: { documentId }, data: { documentId: null } });
      await tx.documentVersion.deleteMany({ where: { documentId } });
      await tx.document.delete({ where: { id: documentId } });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'gwg.evidence.destroy',
        resourceType: 'document',
        resourceId: documentId,
        before: { title: loaded.title, classification: 'GWG_EVIDENCE', clientId: loaded.clientId },
        after: {
          destroyed: true,
          versions: loaded.versions.length,
          mandateEndedAt: loaded.client?.mandateEndedAt?.toISOString() ?? null,
        },
      });
    });
  } catch (e) {
    // Bytes sind bereits weg → der Fehler betrifft nur die DB-Buchhaltung.
    // Generisch melden (kein Roh-Leak); Admin kann den Beleg manuell nachräumen.
    void e;
    return { ok: false, error: 'Bytes vernichtet, aber DB-Aufräumen fehlgeschlagen — bitte prüfen.' };
  }

  revalidatePath('/staff/admin/gwg-retention');
  revalidatePath(`/staff/clients/${loaded.clientId}/gwg`);
  return { ok: true };
}

/**
 * Bestätigte Vernichtung der GwG-AUFZEICHNUNGEN (§ 8 Abs. 4 S. 4) — das
 * GwgCheck-Aggregat in der DB. Die Datei-Vernichtung oben erfasste nur die
 * Belege; die Aufzeichnungen (riskAnswers/Breakdown/Notes, wirtschaftlich
 * Berechtigte mit Geburtsdaten/PEP, Ausweisnummern) blieben sonst unbegrenzt.
 *
 * Vernichtungs-Semantik: Berechtigte werden GELÖSCHT, Ausweis-Detailfelder
 * genullt (ownerName → 'VERNICHTET', NOT NULL), riskAnswers/notes entfernt.
 * Ein Skelett-Datensatz (Status, Risiko-Stufe, verifiedAt, destroyedAt als
 * Vernichtungsvermerk) bleibt als Nachweis, DASS geprüft wurde.
 */
export async function confirmGwgCheckDeletionAction(input: { checkId: string }): Promise<ActionResult> {
  // GwG-Vernichtung ist Compliance-Hoheit → ADMIN/PARTNER.
  const g = await staffActionGuard({ requireAdmin: true });
  if (!g.ok) return g;
  const { tenantId, staffId, ctx } = g;

  const parsed = z.object({ checkId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { checkId } = parsed.data;

  let clientId: string | null = null;
  const result = await withTenantContext(ctx, async (tx): Promise<ActionResult> => {
    // 1. Aggregat laden (+ Mandatsende für die Fristprüfung).
    const check = await tx.gwgCheck.findFirst({
      where: { id: checkId, tenantId },
      select: {
        id: true,
        status: true,
        clientId: true,
        destroyedAt: true,
        client: { select: { mandateEndedAt: true } },
        _count: { select: { beneficialOwners: true, idDocuments: true } },
      },
    });
    if (!check) return { ok: false, error: 'GwG-Prüfung nicht gefunden.' };
    if (check.destroyedAt) return { ok: false, error: 'Aufzeichnungen wurden bereits vernichtet.' };
    clientId = check.clientId;

    // 2. Gesetzliche Löschfrist abgelaufen? (Mandatsende + 5 J., § 8 Abs. 4.)
    if (!isGwgDeletionDue(check.client?.mandateEndedAt ?? null)) {
      return { ok: false, error: 'Löschfrist noch nicht abgelaufen — Vernichtung nicht zulässig.' };
    }

    // 3. Datei-Belege zuerst: solange GWG_EVIDENCE-Dateien des Mandanten
    //    existieren, ist das DB-Aggregat nicht dran (sonst entstünden
    //    verwaiste Belege ohne zugehörige Aufzeichnung).
    const openDocs = await tx.document.count({
      where: { clientId: check.clientId, classification: 'GWG_EVIDENCE', deletedAt: null },
    });
    if (openDocs > 0) {
      return { ok: false, error: 'Es existieren noch GwG-Datei-Belege — bitte zuerst die Belege vernichten.' };
    }

    // 4. Aggregat vernichten — alles in DIESER Tx (inkl. Audit-Record):
    //    Berechtigte löschen, Ausweis-Details anonymisieren, Check anonymisieren.
    await tx.gwgBeneficialOwner.deleteMany({ where: { gwgCheckId: checkId } });
    await tx.gwgIdDocument.updateMany({
      where: { gwgCheckId: checkId },
      data: {
        // ownerName ist NOT NULL → Platzhalter statt Schema-Änderung.
        ownerName: 'VERNICHTET',
        number: null,
        issuedBy: null,
        issueDate: null,
        expiryDate: null,
        notes: null,
        documentId: null,
      },
    });
    const destroyedAt = new Date();
    await tx.gwgCheck.update({
      where: { id: checkId },
      data: {
        riskAnswers: Prisma.DbNull,
        riskBreakdown: Prisma.DbNull,
        notes: null,
        rejectedReason: null,
        destroyedAt,
      },
    });

    // 5. Vernichtung auditieren (audit_log ist insert-only → der Nachweis
    //    bleibt dauerhaft; bewusst nur Zähler, keine Personendaten im Event).
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'gwg.check.destroy',
      resourceType: 'gwg_check',
      resourceId: checkId,
      before: {
        status: check.status,
        beneficialOwners: check._count.beneficialOwners,
        idDocuments: check._count.idDocuments,
      },
      after: {
        destroyed: true,
        destroyedAt: destroyedAt.toISOString(),
        mandateEndedAt: check.client?.mandateEndedAt?.toISOString() ?? null,
      },
    });
    return { ok: true };
  });

  if (result.ok) {
    revalidatePath('/staff/admin/gwg-retention');
    if (clientId) revalidatePath(`/staff/clients/${clientId}/gwg`);
  }
  return result;
}
