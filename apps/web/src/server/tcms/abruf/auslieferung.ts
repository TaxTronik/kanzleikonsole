import 'server-only';

// =============================================================================
// Auslieferung einer Datei, auf die das Tax-CMS verweist (TCMS Stufe 3,
// Bereich D; ADR 0001 §6 im TCMS-Repo): Das TCMS hält nur Verweise
// (Dokument-ID der kanzleikonsole + SHA-256), die Bytes liefert die
// bestehende Dokumentauslieferung der kanzleikonsole (`loadDocumentDelivery`,
// DOC-PORTAL-SHARING-001) mit ihren eigenen Regeln:
//
//   - Kanzlei: Dokument genau DIESES Mandanten (Pfad nach Zugriffsprüfung),
//     nicht gelöscht, Mandantenzugriff erneut über canAccessClientTx.
//   - Portal: Dokument des Sitzungsmandanten, nicht gelöscht, für den
//     Mandanten freigegeben (sharedWithClientAt) – dieselben Filter wie
//     /api/portal/documents/[id]/download.
//   - beide: neueste Version sauber gescannt (delivery-readiness), Abruf
//     auditiert, beim Streamen SHA-256 und Größe geprüft (R-05).
//
// Zusätzlich (Schutzregel dieses Bereichs): SHA-256 und Größe der neuesten
// Version müssen dem Verweis des TCMS entsprechen. Weichen sie ab (neue
// Version hochgeladen, anderes Dokument), wird nichts ausgeliefert, nichts
// auditiert und kein Byte aus dem Object Store gelesen; die Oberfläche zeigt
// einen Hinweis. Der Abgleich läuft vor dem Abrufnachweis und erneut an der
// tatsächlich geladenen Version. Eine Dokument-ID, die keine UUID der kanzleikonsole ist (z. B.
// Verweise der TCMS-Demo), ist „nicht verfügbar“.
//
// Gemeinsamer Kandidat mit Bereich C (Nachweise der Kanzlei): beim
// Zusammenführen mit dessen Auslieferung vereinigen.
// =============================================================================

import type { NextRequest, NextResponse } from 'next/server';
import { canAccessClientTx } from '@/server/auth/rbac';
import type { PortalSession } from '@/server/auth/portal';
import type { StaffSession } from '@/server/auth/staff';
import { documentDownloadResponse, loadDocumentDelivery } from '@/server/documents/delivery';
import { isUuid } from '@/lib/uuid';

const SHA256 = /^[0-9a-f]{64}$/;

export interface TcmsVerweis {
  dokumentId: string;
  sha256: string;
  /** Größe in Bytes laut Verweis (AnlageVerweis/NachweisVerweis). */
  groesse: number;
}

export type TcmsAuslieferung =
  | { art: 'AUSGELIEFERT'; antwort: NextResponse }
  /** Dokument fehlt, ist fremd, gelöscht, nicht freigegeben oder (noch) nicht gescannt. */
  | { art: 'NICHT_VERFUEGBAR' }
  /** Dokument vorhanden, aber sein Inhalt ist nicht der, auf den das TCMS verweist. */
  | { art: 'ABWEICHUNG' };

export type TcmsAuslieferungsAkteur =
  | { flaeche: 'KANZLEI'; session: StaffSession; mandantId: string }
  | { flaeche: 'PORTAL'; session: PortalSession; mandantId: string };

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/** Inhalt der Version = Inhalt laut Verweis (SHA-256 und Größe). */
function passt(version: { sha256: Uint8Array; sizeBytes: bigint }, verweis: TcmsVerweis): boolean {
  return (
    hex(version.sha256) === verweis.sha256.toLowerCase() &&
    version.sizeBytes === BigInt(verweis.groesse)
  );
}

/** Liefert die Datei eines TCMS-Verweises über die Dokumentauslieferung der kanzleikonsole. */
export async function tcmsVerweisAusliefern(
  request: NextRequest,
  akteur: TcmsAuslieferungsAkteur,
  verweis: TcmsVerweis,
): Promise<TcmsAuslieferung> {
  const dokumentId = verweis.dokumentId.toLowerCase();
  if (
    !isUuid(dokumentId) ||
    !SHA256.test(verweis.sha256.toLowerCase()) ||
    !Number.isSafeInteger(verweis.groesse) ||
    !isUuid(akteur.mandantId)
  ) {
    return { art: 'NICHT_VERFUEGBAR' };
  }
  const { tenantId } = akteur.session.user;
  let abweichung = false;

  const dokument = await loadDocumentDelivery({
    tenantId,
    actorId:
      akteur.flaeche === 'KANZLEI' ? akteur.session.user.staffId : akteur.session.user.contactId,
    actorType: akteur.flaeche === 'KANZLEI' ? 'STAFF' : 'CLIENT_CONTACT',
    documentId: dokumentId,
    action: 'document.download',
    request,
    where:
      akteur.flaeche === 'KANZLEI'
        ? { id: dokumentId, tenantId, clientId: akteur.mandantId, deletedAt: null }
        : {
            id: dokumentId,
            tenantId,
            clientId: akteur.mandantId,
            deletedAt: null,
            sharedWithClientAt: { not: null },
          },
    // Vor Audit und Storage: Zugriff (Kanzlei) und Inhalt laut Verweis.
    authorize: async (tx, kandidat) => {
      if (kandidat.clientId !== akteur.mandantId) return false;
      if (
        akteur.flaeche === 'KANZLEI' &&
        !(await canAccessClientTx(tx, akteur.session, akteur.mandantId))
      ) {
        return false;
      }
      const neueste = await tx.documentVersion.findFirst({
        where: { documentId: kandidat.id },
        orderBy: { versionNo: 'desc' },
        select: { sha256: true, sizeBytes: true },
      });
      if (!neueste || !passt(neueste, verweis)) {
        abweichung = true;
        return false;
      }
      return true;
    },
  });
  if (!dokument) return abweichung ? { art: 'ABWEICHUNG' } : { art: 'NICHT_VERFUEGBAR' };
  // Dieselbe Version wie in der Prüfung; beim Streamen bindet R-05 die Bytes an diesen Hash.
  if (!passt(dokument, verweis)) return { art: 'ABWEICHUNG' };
  const antwort = await documentDownloadResponse(dokument, {
    mimeSource: akteur.flaeche === 'KANZLEI' ? 'validated-document' : 'storage-when-present',
  });
  return { art: 'AUSGELIEFERT', antwort };
}
