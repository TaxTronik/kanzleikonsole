'use server';

import { z } from 'zod';
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
