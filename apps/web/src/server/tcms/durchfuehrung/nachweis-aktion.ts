import 'server-only';

// =============================================================================
// Nachweise anhängen und entfernen (TCMS Stufe 3, Bereich C; Fachkatalog
// TCMS-NACHWEIS-001). Bausteine für die Aktionen in
// app/staff/(protected)/clients/[id]/tcms/durchfuehrungen/[did]/actions.ts –
// die Aktionen selbst laufen über tcmsKanzleiAktion (Gate, Akteur, Fehler).
//
// Hochladen: Datei über die Dokumentenpipeline der kanzleikonsole
// (runJournaledUpload: Vorprüfung, ClamAV, SHA-256, Journal, Object-Write,
// Nachprüfung) als Dokument am Mandanten ablegen; in DERSELBEN
// Commit-Transaktion Audit `document.upload` und die offene Verknüpfung
// (verweis.ts). Der Verweis an das Tax-CMS entsteht aus der gespeicherten
// Version, nie aus dem Formular.
//
// Anhängen: Dienstaufruf außerhalb jeder Transaktion; Annahme → Nachweis-ID an
// der Verknüpfung; eindeutige Ablehnung → Verknüpfung freigeben; offener
// Ausgang (Zeitlimit, Transport, 5xx, Protokoll) → Verknüpfung bleibt
// (im Zweifel schützen).
// =============================================================================

import { createHash } from 'node:crypto';
import type { TenantContext, TxClient } from '@taxtronik/db';
import { withTenantContext } from '@taxtronik/db/tenant-context';
import { classificationToTier, type ProtectionTier } from '@taxtronik/storage';
import {
  TcmsKonflikt,
  TcmsNichtAuthentifiziert,
  TcmsNichtBerechtigt,
  TcmsNichtGefunden,
  TcmsNichtVerfuegbar,
  TcmsUngueltig,
} from '@taxtronik/tcms-client';
import {
  ENDPUNKTE,
  type DurchfuehrungDetail,
  type NachweisErgebnis,
  type NachweisVerweisEingabe,
} from '@taxtronik/tcms-contract';
import { ActionError } from '@/server/actions/action-error';
import { audit } from '@/server/actions/audit';
import type { StaffCtx } from '@/server/actions/staff-action';
import { canAccessClientTx } from '@/server/auth/rbac';
import { runJournaledUpload, uploadFailureCause } from '@/server/documents/journaled-upload';
import { createDocumentWithVersion } from '@/server/documents/upload-helpers';
import { log } from '@/server/logger';
import { tcmsTextBereinigen } from '@/server/tcms/zeichen';
import type { TcmsDienst } from '@/server/tcms/aktion';
import { TcmsInaktivError } from '@/server/tcms/dienst';
import {
  aktionsFehlerAus,
  keinRechtText,
  protokolliereTcmsFehler,
  TCMS_AKTION_TEXTE,
  TCMS_KEIN_RECHT,
} from '@/server/tcms/zustand';
import {
  nachweisVerknuepfenTx,
  nachweisVerknuepfungBestaetigen,
  nachweisVerknuepfungFreigeben,
  type NachweisBezug,
} from './verweis';

/** Herkunft im Speicher-Journal und im Audit. */
export const NACHWEIS_UPLOAD_QUELLE = 'staff.tcms.nachweis';

/** Datei aus dem Formular (readUploadFile); Name und Typ nur als Titel bzw. Rückfall. */
export interface NachweisDatei {
  bytes: Buffer;
  fileName: string;
  mimeType: string;
}

export interface NachweisVerknuepft {
  verknuepfungId: string;
  verweis: NachweisVerweisEingabe;
}

// ---------------------------------------------------------------------------
// Ausgang eines Anhängens
// ---------------------------------------------------------------------------

/**
 * true, wenn der Dienst das Anhängen sicher NICHT ausgeführt hat (4xx, offener
 * Breaker, lokal abgewiesen, kein Client). Zeitlimit, Transport, 5xx und
 * Protokollfehler lassen den Ausgang offen.
 */
export function eindeutigAbgelehnt(fehler: unknown): boolean {
  return (
    fehler instanceof TcmsUngueltig ||
    fehler instanceof TcmsKonflikt ||
    fehler instanceof TcmsNichtBerechtigt ||
    fehler instanceof TcmsNichtGefunden ||
    fehler instanceof TcmsNichtAuthentifiziert ||
    fehler instanceof TcmsInaktivError ||
    (fehler instanceof TcmsNichtVerfuegbar && fehler.grund === 'BREAKER')
  );
}

/**
 * Ablehnung nach dem Hochladen: Das Dokument liegt in der Ablage, ist aber nicht
 * angehängt. Meldung = fester Text der Abbildung mit diesem Hinweis.
 */
export class NachweisNichtAngehaengt extends ActionError {
  constructor(meldung: string) {
    super(
      `Die Datei wurde in der Dokumentablage des Mandanten gespeichert, aber nicht als Nachweis angehängt. ${meldung}`,
    );
    this.name = 'NachweisNichtAngehaengt';
  }
}

/** Fester Text zu einem Fehler des Anhängens (nie der Text des Dienstes). */
function anhaengenText(fehler: unknown): string {
  return (
    aktionsFehlerAus(fehler, { keinRecht: 'DURCHFUEHREN', schreibend: true })?.error ??
    TCMS_AKTION_TEXTE.nichtErreichbar
  );
}

/**
 * Endpunkte zum Anhängen bzw. Entfernen eines Nachweises: Kanzlei
 * (Durchführung) oder Portal (Kontrollaufgabe, Integration TCMS Stufe 3).
 * Beide haben dieselben Parameter, Körper und Antworten.
 */
type AnhaengenEndpunkt =
  | typeof ENDPUNKTE.nachweisAnhaengen
  | typeof ENDPUNKTE.portalAnlageAnhaengen;
type EntfernenEndpunkt =
  | typeof ENDPUNKTE.nachweisEntfernen
  | typeof ENDPUNKTE.portalAnlageEntfernen;

/**
 * Hängt den Verweis an (Dienst) und führt die Verknüpfung nach: Annahme →
 * Nachweis-ID setzen; eindeutige Ablehnung → freigeben; sonst offen lassen.
 * Wirft den Fehler des Dienstes weiter.
 */
export async function nachweisAnhaengenUndBinden(
  dienst: TcmsDienst,
  ctx: TenantContext,
  durchfuehrungId: string,
  verknuepft: NachweisVerknuepft,
  endpunkt: AnhaengenEndpunkt = ENDPUNKTE.nachweisAnhaengen,
): Promise<NachweisErgebnis> {
  let ergebnis: NachweisErgebnis;
  try {
    ({ daten: ergebnis } = await dienst.rufe(endpunkt, {
      params: { durchfuehrungId },
      body: { verweis: verknuepft.verweis },
    }));
  } catch (fehler) {
    if (eindeutigAbgelehnt(fehler)) {
      await nachweisVerknuepfungFreigeben(
        ctx,
        { verknuepfungId: verknuepft.verknuepfungId },
        'NOT_ATTACHED',
      ).catch((freigabeFehler: unknown) =>
        log.error(
          { component: 'tcms-nachweis', err: (freigabeFehler as Error)?.name ?? 'unbekannt' },
          'tcms-nachweis: Verknüpfung nach Ablehnung nicht freigegeben (Sperre bleibt)',
        ),
      );
    }
    throw fehler;
  }
  const bestaetigt = await nachweisVerknuepfungBestaetigen(
    ctx,
    verknuepft.verknuepfungId,
    ergebnis.nachweis.id,
  ).catch(() => false);
  if (!bestaetigt) {
    // Die Sperre bleibt bestehen (offene Verknüpfung ohne Nachweis-ID).
    log.error(
      { component: 'tcms-nachweis', durchfuehrungId },
      'tcms-nachweis: Nachweis-ID nicht an der Verknüpfung gesetzt',
    );
  }
  return ergebnis;
}

/** Entfernt einen Nachweis im Tax-CMS und gibt danach die Verknüpfung frei. */
export async function nachweisEntfernenUndFreigeben(
  dienst: TcmsDienst,
  ctx: TenantContext,
  ziel: { mandantId: string; durchfuehrungId: string; nachweisId: string },
  endpunkt: EntfernenEndpunkt = ENDPUNKTE.nachweisEntfernen,
): Promise<void> {
  await dienst.rufe(endpunkt, {
    params: { durchfuehrungId: ziel.durchfuehrungId, nachweisId: ziel.nachweisId },
  });
  await nachweisVerknuepfungFreigeben(ctx, ziel, 'REMOVED').catch((fehler: unknown) =>
    log.error(
      { component: 'tcms-nachweis', err: (fehler as Error)?.name ?? 'unbekannt' },
      'tcms-nachweis: Verknüpfung nach Entfernen nicht freigegeben (Sperre bleibt)',
    ),
  );
}

// ---------------------------------------------------------------------------
// Vorprüfung anhand der aktuellen Durchführung (vor jeder Ablage)
// ---------------------------------------------------------------------------

/**
 * Liest die Durchführung (Rechte und vorhandene Nachweise) vor dem Ablegen:
 * Ohne Recht wird nichts gespeichert (wie die Demo); gleicher Inhalt in
 * derselben Durchführung wird nicht erneut angehängt. Entscheidend bleibt der
 * Dienst beim Anhängen.
 */
export async function nachweisVorpruefung(
  dienst: TcmsDienst,
  durchfuehrungId: string,
): Promise<DurchfuehrungDetail> {
  const { daten } = await dienst.rufe(ENDPUNKTE.durchfuehrungLesen, {
    params: { durchfuehrungId },
  });
  const recht = daten.rechte.bearbeiten;
  if (!recht.erlaubt) {
    // TCMS s6: Darf die Person nicht (`verweigerung`), derselbe feste Text wie
    // beim 403 des Anhängens; steht nur der Zustand entgegen, dessen Beschreibung.
    throw new ActionError(
      recht.verweigerung !== null
        ? keinRechtText(recht.verweigerung, 'DURCHFUEHREN')
        : recht.grund
          ? `Upload nicht möglich: ${recht.grund}`
          : TCMS_KEIN_RECHT.DURCHFUEHREN,
    );
  }
  return daten;
}

/** SHA-256 (hex) der Bytes, um denselben Inhalt nicht doppelt anzuhängen. */
export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Nachweis derselben Durchführung mit gleichem Inhalt oder Dokument (Anzeige der Meldung). */
export function vorhandenerNachweis(
  d: Pick<DurchfuehrungDetail, 'nachweise'>,
  merkmal: { sha256?: string; dokumentId?: string },
): string | null {
  const treffer = d.nachweise.find(
    (n) =>
      (merkmal.sha256 !== undefined && n.sha256 === merkmal.sha256) ||
      (merkmal.dokumentId !== undefined &&
        n.dokumentId.toLowerCase() === merkmal.dokumentId.toLowerCase()),
  );
  // RT3B-K-04: Dateiname des Dienstes nur bereinigt (Zeichenregel) in die Meldung.
  return treffer ? tcmsTextBereinigen(treffer.dateiname, 'DATEINAME', 255) || 'Datei' : null;
}

// ---------------------------------------------------------------------------
// Hochladen über die Dokumentenpipeline
// ---------------------------------------------------------------------------

interface UploadPruefung {
  tier: ProtectionTier;
  typeId: string | null;
  retentionYears: number | null;
}

/** Klassifikation hochgeladener Nachweise (Allgemein; Höherstufung in der Ablage). */
const NACHWEIS_KLASSIFIKATION = 'GENERAL';

const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

/**
 * Vor- und Nachprüfung des Uploads (K-06): Mandant im Tenant und zugreifbar
 * (ACCESS-CLIENT-MODE-001), Schutzstufe aus dem Kern-Typ „Allgemein“. In der
 * Commit-Transaktion muss die Typauflösung unverändert sein.
 */
async function uploadPruefenTx(
  tx: TxClient,
  g: StaffCtx,
  bezug: NachweisBezug,
  vorher?: UploadPruefung,
): Promise<UploadPruefung> {
  const mandant = await tx.client.findFirst({
    where: { id: bezug.mandantId, tenantId: bezug.tenantId },
    select: { id: true },
  });
  if (!mandant || !(await canAccessClientTx(tx, g.session, bezug.mandantId))) {
    throw new ActionError('Mandant nicht gefunden.');
  }
  const typ = await tx.documentType.findFirst({
    where: {
      tenantId: bezug.tenantId,
      classificationKey: NACHWEIS_KLASSIFIKATION,
      builtin: true,
      active: true,
    },
    select: { id: true, tier: true, retentionYears: true },
  });
  const pruefung: UploadPruefung = {
    tier: typ ? (typ.tier as ProtectionTier) : classificationToTier(NACHWEIS_KLASSIFIKATION),
    typeId: typ?.id ?? null,
    retentionYears: typ?.retentionYears ?? null,
  };
  if (
    vorher &&
    (vorher.tier !== pruefung.tier ||
      vorher.typeId !== pruefung.typeId ||
      vorher.retentionYears !== pruefung.retentionYears)
  ) {
    throw new ActionError(
      'Der Dokumenttyp wurde während des Hochladens geändert. Bitte erneut hochladen.',
    );
  }
  return pruefung;
}

function titelAus(dateiname: string): string {
  const basis = dateiname.split(/[\\/]/).pop() ?? '';
  const titel = basis.trim().slice(0, 500);
  return titel === '' ? 'Nachweis' : titel;
}

/**
 * Legt die Datei als Dokument am Mandanten ab und verknüpft sie in derselben
 * Commit-Transaktion mit der Durchführung. Fehler der Pipeline kommen als
 * ursprünglicher Fehler (Virenscan, Größe, Zugriff) für toActionError zurück.
 */
export async function nachweisDateiAblegen(
  g: StaffCtx,
  bezug: NachweisBezug,
  durchfuehrungId: string,
  datei: NachweisDatei,
): Promise<NachweisVerknuepft & { dokumentId: string }> {
  const titel = titelAus(datei.fileName);
  const gemeldet = datei.mimeType.trim().toLowerCase();
  const rueckfallMime = gemeldet.length <= 255 && MIME.test(gemeldet) ? gemeldet : null;
  try {
    const { result } = await runJournaledUpload<
      UploadPruefung,
      NachweisVerknuepft & { dokumentId: string }
    >({
      context: g.ctx,
      source: NACHWEIS_UPLOAD_QUELLE,
      check: (tx, _phase, vorher) => uploadPruefenTx(tx, g, bezug, vorher),
      readBytes: async () => datei.bytes,
      storage: (geprueft) => ({
        tier: geprueft.tier,
        classification: NACHWEIS_KLASSIFIKATION,
        ...(geprueft.tier === 'GOBD' && geprueft.retentionYears
          ? { retentionYears: geprueft.retentionYears }
          : {}),
      }),
      commitTx: async (tx, { commit, checked }) => {
        // Magic-Byte-Erkennung hat Vorrang vor dem gemeldeten Typ (M-2).
        const mimeType = commit.detectedMime ?? rueckfallMime ?? 'application/octet-stream';
        const { document } = await createDocumentWithVersion(tx, {
          documentData: {
            tenantId: bezug.tenantId,
            clientId: bezug.mandantId,
            ownerStaffId: bezug.staffId,
            title: titel,
            classification: NACHWEIS_KLASSIFIKATION,
            documentTypeId: checked.typeId,
            mimeType,
            retentionUntil: commit.retentionUntil,
          },
          commit,
          createdById: bezug.staffId,
        });
        await audit(tx, g, {
          action: 'document.upload',
          resourceType: 'document',
          resourceId: document.id,
          after: {
            title: titel,
            classification: NACHWEIS_KLASSIFIKATION,
            clientId: bezug.mandantId,
            sha256: commit.sha256.toString('hex'),
            immutable: commit.immutable,
            source: NACHWEIS_UPLOAD_QUELLE,
          },
        });
        const verknuepft = await nachweisVerknuepfenTx(tx, bezug, document.id, durchfuehrungId);
        return { ...verknuepft, dokumentId: document.id };
      },
    });
    return result;
  } catch (fehler) {
    throw uploadFailureCause(fehler);
  }
}

/** Verknüpfung eines vorhandenen Dokuments in eigener Transaktion (vor dem Dienstaufruf). */
export function nachweisDokumentVerknuepfen(
  ctx: TenantContext,
  bezug: NachweisBezug,
  dokumentId: string,
  durchfuehrungId: string,
): Promise<NachweisVerknuepft> {
  return withTenantContext(ctx, (tx) =>
    nachweisVerknuepfenTx(tx, bezug, dokumentId, durchfuehrungId),
  );
}

/** Meldung, wenn das Anhängen nach dem Hochladen scheitert (Dokument bleibt in der Ablage). */
export function nachweisNichtAngehaengt(
  fehler: unknown,
  endpunkt: string,
): NachweisNichtAngehaengt {
  protokolliereTcmsFehler({ komponente: 'tcms-aktion', endpunkt }, fehler);
  return new NachweisNichtAngehaengt(anhaengenText(fehler));
}
