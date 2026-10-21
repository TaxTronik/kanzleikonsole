'use server';

import { z } from 'zod';
import { resolveNotificationsTx } from '@taxtronik/db/notification';
import { Prisma } from '@taxtronik/db/prisma-client';
import { revalidatePath } from 'next/cache';
import { withTenantContext, type TenantContext } from '@taxtronik/db';
import { deleteObjectVersion } from '@taxtronik/storage';
import { lockGwgCheckLifecycleTx } from '@/server/gwg/reverification';
import { gwgDocumentEffectiveStart, isGwgDeletionDue } from '@/server/gwg/retention';
import {
  ActionError,
  staffAction,
  type ActionResult as BaseActionResult,
} from '@/server/actions/staff-action';
import { audit } from '@/server/actions/audit';
import { isDatabaseError } from '@/server/actions/database-error';
import {
  istNachweisDokumentTx,
  nachweisSteuerfristTx,
  TCMS_NACHWEIS_VERNICHTUNGSSPERRE,
  tcmsNachweisSteuerfristText,
} from '@/server/tcms/durchfuehrung/sperre';

export type ActionResult = BaseActionResult;

function safeDestructionError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

/** Fester Vermerk in `gwgDestructionError`, wenn die Bindung erst nach dem Claim auffällt. */
const TCMS_BINDUNG_VERMERK =
  'TCMS_BINDUNG: Dokument im Tax-CMS verknüpft; Object-Store-Löschung nicht begonnen bzw. abgebrochen.';

/** RT3B-K-01: Bindung an das Tax-CMS unmittelbar vor einem Object-Store-Löschen. */
class TcmsBindungVorLoeschen extends Error {
  constructor() {
    super(TCMS_BINDUNG_VERMERK);
    this.name = 'TcmsBindungVorLoeschen';
  }
}

/**
 * RT3B-K-01 (Schicht c, TCMS-NACHWEIS-001): offene Verknüpfung des Tax-CMS in
 * einer eigenen kurzen Transaktion. Seit dem Claim kann keine neue entstehen
 * (der Guard der Verknüpfung lässt keine GwG-Belege zu, der Scope-Trigger
 * keinen Wechsel eines gebundenen Dokuments in diese Klasse); die Prüfung vor
 * jedem Object-Store-Löschen sichert das unabhängig von der Datenbank ab.
 */
function gebundenVorLoeschen(ctx: TenantContext, documentId: string): Promise<boolean> {
  return withTenantContext(ctx, (tx) => istNachweisDokumentTx(tx, documentId));
}

/**
 * Zweiphasige GwG-Pflichtvernichtung. Die Vernichtungsabsicht wird zuerst in
 * der DB und im Audit-Log festgehalten. Erst danach werden die Object-Store-
 * Objekte idempotent entfernt und die immutable DB-Versionen kontrolliert
 * über eine eng begrenzte SECURITY-DEFINER-Funktion gelöscht.
 *
 * RT3B-K-01 (TCMS-NACHWEIS-001): Ein im Tax-CMS verknüpftes Dokument wird in
 * keiner Phase vernichtet – Prüfung vor der Vormerkung, im DB-Claim unter der
 * Dokumentsperre und vor jedem Object-Store-Löschen.
 */
export async function confirmGwgDeletionAction(input: {
  documentId: string;
}): Promise<ActionResult> {
  return staffAction({
    guard: { requireAdmin: true },
    run: async ({ tenantId, staffId, ctx }) => {
      const parsed = z.object({ documentId: z.string().uuid() }).safeParse(input);
      if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
      const { documentId } = parsed.data;
      const now = new Date();

      const prepared = await withTenantContext(ctx, async (tx) => {
        // RT3B-K-01 (Schicht c): Ein im Tax-CMS verknüpftes Dokument wird nicht
        // vernichtet – geprüft vor Klassifikation, Frist, Vormerkung und Claim,
        // damit die Ablehnung den eigentlichen Grund nennt. Der Claim prüft die
        // Bindung unter der Dokumentsperre erneut (Schicht b).
        if (await istNachweisDokumentTx(tx, documentId)) {
          return { ok: false as const, error: TCMS_NACHWEIS_VERNICHTUNGSSPERRE };
        }
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
        if (!document.clientId) {
          return {
            ok: false as const,
            error: 'GwG-Beleg ist keinem Mandanten eindeutig zugeordnet.',
          };
        }

        // Vor Vernichtungsmarker, Audit und DB-Claim dieselbe Sperre wie alle
        // Check-/Onboarding-Pfade nehmen. Damit kann kein paralleler Prüfzyklus
        // Daten dieses Belegs rehydrieren, während die Vernichtung vorbereitet
        // wird. Die Dokumentzeilen sperrt anschließend der DB-Claim.
        await lockGwgCheckLifecycleTx(tx, {
          tenantId,
          clientId: document.clientId,
        });

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
        // kk-tcms-s11 (TCMS-NACHWEIS-001, Produktentscheidung 21.10.2026): War
        // der Beleg als Nachweis im Tax-CMS gebunden (auch freigegeben), gilt er
        // zugleich als steuerliche Unterlage – fällig erst nach Ablauf beider
        // Fristen. retention_until trägt die Frist in der Regel schon; der feste
        // Text nennt den Grund. Der Claim prüft dasselbe in der Datenbank.
        const steuerfrist = await nachweisSteuerfristTx(tx, documentId);
        if (steuerfrist && now.getTime() < steuerfrist.getTime()) {
          return { ok: false as const, error: tcmsNachweisSteuerfristText(steuerfrist) };
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
            await audit(tx, ctx, {
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
        // RT3B-K-02: Die Funktion liefert `void`; Prisma 7 kann eine Spalte vom
        // Typ void nicht lesen und brach JEDE Vernichtung ab. `::text` liefert
        // eine lesbare (leere) Spalte; Ablehnungen kommen weiter als Fehler.
        await tx.$queryRaw(
          Prisma.sql`SELECT app.assert_gwg_document_destruction_due(${documentId}::uuid)::text AS "claim"`,
        );

        return { ok: true as const, document, retentionStart, clientId: document.clientId };
      }).catch((error: unknown) => ({
        ok: false as const,
        // RT3B-K-01: Ablehnung des Claims wegen der Tax-CMS-Bindung (SQLSTATE
        // und Marker der Migration, nie der Meldungstext von Prisma).
        error: isDatabaseError(error, 'TCMS_EVIDENCE_LOCKED')
          ? TCMS_NACHWEIS_VERNICHTUNGSSPERRE
          : 'Der DB-seitige Vernichtungsclaim ist nicht zulässig; es wurden keine Datei-Bytes gelöscht.',
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
          error:
            'Vernichtungsclaim ist nicht mehr ausführbar; es wurden keine Datei-Bytes gelöscht.',
        };
      }

      try {
        for (const version of claimed.versions) {
          // RT3B-K-01 (Schicht c): nie Bytes löschen, solange eine Bindung besteht –
          // unmittelbar vor JEDEM Object-Store-Löschen (Reihenfolge bleibt
          // Claim → Commit → Bytes).
          if (await gebundenVorLoeschen(ctx, documentId)) throw new TcmsBindungVorLoeschen();
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
            where: {
              id: documentId,
              gwgDestructionRequestedAt: { not: null },
              gwgDestroyedAt: null,
            },
            data: { gwgDestructionError: safeDestructionError(error) },
          }),
        );
        revalidatePath('/staff/admin/gwg-retention');
        if (error instanceof TcmsBindungVorLoeschen) {
          return { ok: false, error: TCMS_NACHWEIS_VERNICHTUNGSSPERRE };
        }
        return {
          ok: false,
          error:
            'Vernichtung im Object-Store fehlgeschlagen. Der Vorgang bleibt vorgemerkt und kann erneut ausgeführt werden.',
        };
      }

      try {
        await withTenantContext(ctx, async (tx) => {
          // Der erste Advisory-Lock endete mit dem Claim-Commit vor dem externen
          // Object-Store-Schritt. Für den DB-Abschluss daher erneut zuerst den
          // Lifecycle-Lock nehmen und erst danach Dokument/Check-Relationen lesen
          // beziehungsweise in der SECURITY-DEFINER-Funktion verändern.
          await lockGwgCheckLifecycleTx(tx, {
            tenantId,
            clientId: prepared.clientId,
          });

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

          await tx.$queryRaw(
            Prisma.sql`SELECT app.destroy_gwg_document_versions(${documentId}::uuid)`,
          );
          const destroyed = await tx.document.findUnique({
            where: { id: documentId },
            select: { gwgDestroyedAt: true },
          });
          if (!destroyed?.gwgDestroyedAt) {
            throw new Error('GwG-Vernichtungsfunktion hat keinen Abschlussvermerk gesetzt.');
          }
          await audit(tx, ctx, {
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
            where: {
              id: documentId,
              gwgDestructionRequestedAt: { not: null },
              gwgDestroyedAt: null,
            },
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
      revalidatePath(`/staff/clients/${prepared.clientId}/gwg`);
    },
  });
}

/** Vernichtet die personenbezogenen Aufzeichnungen eines fälligen GwG-Checks. */
export async function confirmGwgCheckDeletionAction(input: {
  checkId: string;
}): Promise<ActionResult> {
  return staffAction({
    guard: { requireAdmin: true },
    run: async ({ tenantId, ctx }) => {
      const parsed = z.object({ checkId: z.string().uuid() }).safeParse(input);
      if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
      const { checkId } = parsed.data;

      let clientId: string | null = null;
      const result = await withTenantContext(ctx, async (tx): Promise<ActionResult> => {
        const scopedCheck = await tx.gwgCheck.findFirst({
          where: { id: checkId, tenantId },
          select: { clientId: true },
        });
        if (!scopedCheck) throw new ActionError('GwG-Prüfung nicht gefunden.');

        // Dieselbe Lock-Reihenfolge wie Create/Onboarding/Review: erst der
        // mandantenbezogene Lifecycle-Lock, danach die Zeilensperren innerhalb
        // der SECURITY-DEFINER-Funktion. Die Funktion nimmt den Lock zusätzlich
        // selbst, damit direkte SQL-Aufrufe diesen Schutz nicht umgehen können.
        await lockGwgCheckLifecycleTx(tx, {
          tenantId,
          clientId: scopedCheck.clientId,
        });

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
        if (!destroyed)
          throw new Error('GwG-Vernichtungsfunktion lieferte keinen Abschlussnachweis.');
        if (destroyed.clientId !== scopedCheck.clientId) {
          throw new Error('GwG-Vernichtungsfunktion lieferte einen abweichenden Mandantenbezug.');
        }
        clientId = scopedCheck.clientId;

        await resolveNotificationsTx(tx, {
          tenantId,
          resources: [{ resourceType: 'gwg_check', resourceId: checkId }],
        });

        await audit(tx, ctx, {
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
    },
  });
}
