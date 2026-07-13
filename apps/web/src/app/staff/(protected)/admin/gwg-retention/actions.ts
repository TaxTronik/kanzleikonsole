'use server';

import { z } from 'zod';
import { Prisma } from '@taxtronik/db/prisma-client';
import { revalidatePath } from 'next/cache';
import { withTenantContext } from '@taxtronik/db';
import { deleteObjectVersion } from '@taxtronik/storage';
import { evidenceService } from '@/server/container';
import { gwgDocumentEffectiveStart, isGwgDeletionDue } from '@/server/gwg/retention';
import {
  staffActionGuard,
  type ActionResult as BaseActionResult,
} from '@/server/actions/staff-action';

export type ActionResult = BaseActionResult;

function safeDestructionError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

/**
 * Zweiphasige GwG-Pflichtvernichtung. Die Vernichtungsabsicht wird zuerst in
 * der DB und im Audit-Log festgehalten. Erst danach werden die Object-Store-
 * Objekte idempotent entfernt und die immutable DB-Versionen kontrolliert
 * über eine eng begrenzte SECURITY-DEFINER-Funktion gelöscht.
 */
export async function confirmGwgDeletionAction(input: {
  documentId: string;
}): Promise<ActionResult> {
  const g = await staffActionGuard({ requireAdmin: true });
  if (!g.ok) return g;
  const { tenantId, staffId, ctx } = g;

  const parsed = z.object({ documentId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { documentId } = parsed.data;
  const now = new Date();

  const prepared = await withTenantContext(ctx, async (tx) => {
    const document = await tx.document.findFirst({
      where: {
        id: documentId,
        tenantId,
        classification: 'GWG_EVIDENCE',
        deletedAt: null,
      },
      select: {
        id: true,
        title: true,
        clientId: true,
        createdAt: true,
        retentionUntil: true,
        gwgDestructionRequestedAt: true,
        client: { select: { mandateEndedAt: true } },
        gwgIdDocuments: {
          select: {
            check: { select: { status: true, createdAt: true, verifiedAt: true } },
          },
        },
        gwgOnboardingInvite: {
          select: {
            status: true,
            expiresAt: true,
            cancelledAt: true,
            gwgCheck: { select: { status: true, createdAt: true, verifiedAt: true } },
          },
        },
        versions: {
          select: {
            id: true,
            storageBucket: true,
            storageKey: true,
            storageVersionId: true,
          },
        },
      },
    });
    if (!document) return { ok: false as const, error: 'GwG-Beleg nicht gefunden.' };

    const retentionStart = gwgDocumentEffectiveStart(
      {
        createdAt: document.createdAt,
        mandateEndedAt: document.client?.mandateEndedAt ?? null,
        linkedChecks: document.gwgIdDocuments.map((idDocument) => idDocument.check),
        invite: document.gwgOnboardingInvite,
      },
      now,
    );
    if (!isGwgDeletionDue(retentionStart, now)) {
      return {
        ok: false as const,
        error: 'Löschfrist noch nicht abgelaufen – Vernichtung nicht zulässig.',
      };
    }
    if (!document.retentionUntil || document.retentionUntil.getTime() > now.getTime()) {
      return {
        ok: false as const,
        error:
          'Object-Lock-Aufbewahrungsende fehlt oder läuft noch – Vernichtung ist nicht zulässig.',
      };
    }

    if (!document.gwgDestructionRequestedAt) {
      const requested = await tx.document.updateMany({
        where: { id: documentId, gwgDestructionRequestedAt: null, gwgDestroyedAt: null },
        data: {
          gwgDestructionRequestedAt: now,
          gwgDestructionRequestedBy: staffId,
          gwgDestructionError: null,
        },
      });
      if (requested.count === 1) {
        await evidenceService.record(tx, {
          tenantId,
          actorType: 'STAFF',
          actorId: staffId,
          action: 'gwg.evidence.destroy.request',
          resourceType: 'document',
          resourceId: documentId,
          before: {
            title: document.title,
            classification: 'GWG_EVIDENCE',
            clientId: document.clientId,
          },
          after: {
            requestedAt: now.toISOString(),
            retentionStartedAt: retentionStart?.toISOString() ?? null,
          },
        });
      }
    }

    // DB-seitiger, tenant-sicherer Eligibility-Claim in derselben Tx wie die
    // Vormerkung. Nach Commit frieren Trigger alle fristrelevanten Relationen
    // ein; erst dann dürfen externe Object-Store-Bytes gelöscht werden.
    await tx.$queryRaw(
      Prisma.sql`SELECT app.assert_gwg_document_destruction_due(${documentId}::uuid)`,
    );

    return { ok: true as const, document, retentionStart };
  }).catch(() => ({
    ok: false as const,
    error:
      'Der DB-seitige Vernichtungsclaim ist nicht zulässig; es wurden keine Datei-Bytes gelöscht.',
  }));
  if (!prepared.ok) return prepared;

  // Erst NACH dem committed Claim neu laden. Eine vor dem Claim gelesene
  // Versionsliste könnte einen konkurrierenden Upload übersehen; ab jetzt
  // blockiert der DB-Trigger jede neue/änderte Version dauerhaft.
  const claimed = await withTenantContext(ctx, (tx) =>
    tx.document.findFirst({
      where: {
        id: documentId,
        tenantId,
        gwgDestructionRequestedAt: { not: null },
        gwgDestroyedAt: null,
        deletedAt: null,
      },
      select: {
        versions: {
          select: {
            id: true,
            storageBucket: true,
            storageKey: true,
            storageVersionId: true,
          },
        },
      },
    }),
  );
  if (!claimed) {
    return {
      ok: false,
      error: 'Vernichtungsclaim ist nicht mehr ausführbar; es wurden keine Datei-Bytes gelöscht.',
    };
  }

  try {
    for (const version of claimed.versions) {
      if (!version.storageVersionId) {
        throw new Error(
          `STORAGE_VERSION_ID_MISSING: DocumentVersion ${version.id} kann nicht physisch verifiziert gelöscht werden.`,
        );
      }
      await deleteObjectVersion(
        version.storageBucket,
        version.storageKey,
        version.storageVersionId,
        // Ausschließlich dieser doppelt fristgeprüfte und atomar geclaimte
        // Fachpfad darf den GOVERNANCE-Lock am tatsächlichen gesetzlichen
        // Fristende übersteuern. Alle übrigen Löschpfade bleiben ohne Bypass.
        { bypassGovernanceRetention: true },
      );
    }
  } catch (error) {
    await withTenantContext(ctx, (tx) =>
      tx.document.updateMany({
        where: { id: documentId, gwgDestructionRequestedAt: { not: null }, gwgDestroyedAt: null },
        data: { gwgDestructionError: safeDestructionError(error) },
      }),
    );
    revalidatePath('/staff/admin/gwg-retention');
    return {
      ok: false,
      error:
        'Vernichtung im Object-Store fehlgeschlagen. Der Vorgang bleibt vorgemerkt und kann erneut ausgeführt werden.',
    };
  }

  try {
    await withTenantContext(ctx, async (tx) => {
      const pending = await tx.document.findFirst({
        where: {
          id: documentId,
          tenantId,
          classification: 'GWG_EVIDENCE',
          deletedAt: null,
          gwgDestructionRequestedAt: { not: null },
          gwgDestroyedAt: null,
        },
        select: { id: true },
      });
      if (!pending) return;

      await tx.$queryRaw(Prisma.sql`SELECT app.destroy_gwg_document_versions(${documentId}::uuid)`);
      const destroyed = await tx.document.findUnique({
        where: { id: documentId },
        select: { gwgDestroyedAt: true },
      });
      if (!destroyed?.gwgDestroyedAt) {
        throw new Error('GwG-Vernichtungsfunktion hat keinen Abschlussvermerk gesetzt.');
      }
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'gwg.evidence.destroy',
        resourceType: 'document',
        resourceId: documentId,
        before: {
          title: prepared.document.title,
          classification: 'GWG_EVIDENCE',
          clientId: prepared.document.clientId,
        },
        after: {
          destroyed: true,
          destroyedAt: destroyed.gwgDestroyedAt.toISOString(),
          versions: claimed.versions.length,
          retentionStartedAt: prepared.retentionStart?.toISOString() ?? null,
        },
      });
    });
  } catch (error) {
    await withTenantContext(ctx, (tx) =>
      tx.document.updateMany({
        where: { id: documentId, gwgDestructionRequestedAt: { not: null }, gwgDestroyedAt: null },
        data: { gwgDestructionError: safeDestructionError(error) },
      }),
    );
    revalidatePath('/staff/admin/gwg-retention');
    return {
      ok: false,
      error:
        'Datei-Bytes sind vernichtet; der nachweisbare DB-Abschluss ist noch offen. Bitte den Vorgang erneut ausführen.',
    };
  }

  revalidatePath('/staff/admin/gwg-retention');
  if (prepared.document.clientId) {
    revalidatePath(`/staff/clients/${prepared.document.clientId}/gwg`);
  }
  return { ok: true };
}

/** Vernichtet die personenbezogenen Aufzeichnungen eines fälligen GwG-Checks. */
export async function confirmGwgCheckDeletionAction(input: {
  checkId: string;
}): Promise<ActionResult> {
  const g = await staffActionGuard({ requireAdmin: true });
  if (!g.ok) return g;
  const { tenantId, staffId, ctx } = g;

  const parsed = z.object({ checkId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { checkId } = parsed.data;

  let clientId: string | null = null;
  const result = await withTenantContext(ctx, async (tx): Promise<ActionResult> => {
    type DestroyedCheckRow = {
      clientId: string;
      status: string;
      retentionStartedAt: string;
      destroyedAt: string;
      beneficialOwners: number;
      idDocuments: number;
    };
    const rows = await tx.$queryRaw<DestroyedCheckRow[]>(Prisma.sql`
      SELECT
        result->>'clientId' AS "clientId",
        result->>'status' AS "status",
        result->>'retentionStartedAt' AS "retentionStartedAt",
        result->>'destroyedAt' AS "destroyedAt",
        (result->>'beneficialOwners')::INTEGER AS "beneficialOwners",
        (result->>'idDocuments')::INTEGER AS "idDocuments"
      FROM (SELECT app.destroy_gwg_check(${checkId}::UUID) AS result) destroyed
    `);
    const destroyed = rows[0];
    if (!destroyed) throw new Error('GwG-Vernichtungsfunktion lieferte keinen Abschlussnachweis.');
    clientId = destroyed.clientId;

    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'gwg.check.destroy',
      resourceType: 'gwg_check',
      resourceId: checkId,
      before: {
        status: destroyed.status,
        beneficialOwners: destroyed.beneficialOwners,
        idDocuments: destroyed.idDocuments,
      },
      after: {
        destroyed: true,
        destroyedAt: new Date(destroyed.destroyedAt).toISOString(),
        retentionStartedAt: new Date(destroyed.retentionStartedAt).toISOString(),
      },
    });
    return { ok: true };
  }).catch(() => ({
    ok: false as const,
    error:
      'DB-seitige Frist- oder Integritätsprüfung fehlgeschlagen; es wurden keine Check-Aufzeichnungen vernichtet.',
  }));

  if (result.ok) {
    revalidatePath('/staff/admin/gwg-retention');
    if (clientId) revalidatePath(`/staff/clients/${clientId}/gwg`);
  }
  return result;
}
