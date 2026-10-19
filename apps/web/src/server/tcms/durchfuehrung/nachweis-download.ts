import 'server-only';

// =============================================================================
// Abruf eines Nachweises einer Kontrolldurchführung (TCMS Stufe 3, Bereich C;
// Fachkatalog TCMS-NACHWEIS-001). Aufruf nur aus dem Route Handler
// app/api/staff/clients/[id]/tcms/nachweise/[nachweisId]/route.ts NACH
// tcmsMandantRoute(id) (Sitzung, Mandantenzugriff, Modul, Akteur).
//
//   1. Verweis über `nachweisLesen` (Dienst entscheidet, ob die Person den
//      Nachweis sehen darf; Mandant aus der geprüften Route).
//   2. Vorabgleich mit der Ablage (Dokument dieses Mandanten, neueste Version
//      sauber, SHA-256 und Größe gleich dem Verweis) – bei Abweichung keine
//      Auslieferung und kein Abrufnachweis.
//   3. Auslieferung ausschließlich über die Dokumentauslieferung der
//      kanzleikonsole (server/documents/delivery.ts) mit deren Rechten
//      (Mandantenzugriff, Lohn-Recht) und Abrufnachweis `document.download`.
//   4. Erneuter Abgleich der geladenen Fassung mit dem Verweis; beim Streamen
//      prüft die Ablage den Objektinhalt gegen den SHA-256 der Fassung (R-05).
// =============================================================================

import { NextResponse, type NextRequest } from 'next/server';
import { withTenantContext } from '@taxtronik/db/tenant-context';
import { ENDPUNKTE, NachweisIdSchema } from '@taxtronik/tcms-contract';
import { canAccessClientTx } from '@/server/auth/rbac';
import { documentDownloadResponse, loadDocumentDelivery } from '@/server/documents/delivery';
import { log } from '@/server/logger';
import {
  TCMS_ROUTE_KOPF,
  tcmsRouteAntwort,
  tcmsRouteLesen,
  type TcmsMandantRoute,
} from '@/server/tcms/route';
import { nachweisAbgleichTx } from './verweis';

/** Feste Antworten des Abrufs (zusätzlich zu TCMS_ROUTE_ANTWORTEN). */
export const NACHWEIS_ABRUF_ANTWORTEN = {
  ABWEICHUNG: {
    status: 409,
    error: 'evidence_mismatch',
    message:
      'Die gespeicherte Datei stimmt nicht mit dem Nachweis im Tax-CMS überein (SHA-256 oder Größe) und wird nicht ausgeliefert. Bitte informieren Sie die Kanzleiverwaltung.',
  },
  NICHT_VERFUEGBAR: {
    status: 404,
    error: 'evidence_unavailable',
    message: 'Das Dokument zu diesem Nachweis ist in der Dokumentablage nicht verfügbar.',
  },
  SPEICHER: {
    status: 503,
    error: 'storage_unavailable',
    message: 'Die Datei ist derzeit nicht abrufbar. Bitte versuchen Sie es später erneut.',
  },
} as const;

type AbrufAntwort = keyof typeof NACHWEIS_ABRUF_ANTWORTEN;

function antwort(art: AbrufAntwort): NextResponse {
  const { status, error, message } = NACHWEIS_ABRUF_ANTWORTEN[art];
  return NextResponse.json({ error, message }, { status, headers: TCMS_ROUTE_KOPF });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

function gleicheFassung(
  fassung: { sha256: Uint8Array; sizeBytes: bigint },
  verweis: { sha256: string; groesse: number },
): boolean {
  return (
    Buffer.from(fassung.sha256).toString('hex') === verweis.sha256 &&
    fassung.sizeBytes === BigInt(verweis.groesse)
  );
}

/** Liefert die Datei eines Nachweises aus oder antwortet mit festem JSON. */
export async function nachweisAusliefern(
  request: NextRequest,
  route: TcmsMandantRoute,
  nachweisId: string,
): Promise<NextResponse> {
  const id = NachweisIdSchema.safeParse(nachweisId);
  if (!id.success) return tcmsRouteAntwort('NICHT_GEFUNDEN');

  const gelesen = await tcmsRouteLesen(route, ENDPUNKTE.nachweisLesen, {
    params: { nachweisId: id.data },
  });
  if (!gelesen.ok) return gelesen.antwort;
  const verweis = gelesen.daten.nachweis;
  // Verweise ohne Dokument der kanzleikonsole (z. B. Altbestand) nie ausliefern.
  if (!UUID.test(verweis.dokumentId) || !SHA256.test(verweis.sha256)) {
    return antwort('NICHT_VERFUEGBAR');
  }
  const dokumentId = verweis.dokumentId.toLowerCase();
  const { tenantId, staffId } = route.session.user;
  const kontext = { tenantId, actorId: staffId, actorType: 'STAFF' as const };
  const protokoll = { component: 'tcms-nachweis-abruf', nachweisId: id.data, dokumentId };

  const vorab = await withTenantContext(kontext, (tx) =>
    nachweisAbgleichTx(tx, { tenantId, mandantId: route.mandantId }, [
      { id: id.data, dokumentId, sha256: verweis.sha256, groesse: verweis.groesse },
    ]),
  );
  const zustand = vorab.get(id.data);
  if (zustand === 'FEHLT') return antwort('NICHT_VERFUEGBAR');
  if (zustand !== 'OK') {
    log.warn(protokoll, 'tcms-nachweis-abruf: Fassung weicht vom Verweis ab (nicht ausgeliefert)');
    return antwort('ABWEICHUNG');
  }

  const dokument = await loadDocumentDelivery({
    tenantId,
    actorId: staffId,
    actorType: 'STAFF',
    documentId: dokumentId,
    action: 'document.download',
    request,
    where: { id: dokumentId, tenantId, clientId: route.mandantId, deletedAt: null },
    authorize: (tx, kandidat) =>
      kandidat.clientId === route.mandantId
        ? canAccessClientTx(tx, route.session, route.mandantId)
        : Promise.resolve(false),
  });
  if (!dokument) return antwort('NICHT_VERFUEGBAR');
  if (!gleicheFassung(dokument, verweis)) {
    log.warn(
      protokoll,
      'tcms-nachweis-abruf: Fassung nach dem Laden abweichend (nicht ausgeliefert)',
    );
    return antwort('ABWEICHUNG');
  }

  try {
    const datei = await documentDownloadResponse(dokument, { mimeSource: 'validated-document' });
    datei.headers.set('X-Content-Type-Options', 'nosniff');
    return datei;
  } catch (fehler) {
    log.error(
      { ...protokoll, err: fehler instanceof Error ? fehler.name : 'unbekannt' },
      'tcms-nachweis-abruf: Ablage nicht lesbar',
    );
    return antwort('SPEICHER');
  }
}
