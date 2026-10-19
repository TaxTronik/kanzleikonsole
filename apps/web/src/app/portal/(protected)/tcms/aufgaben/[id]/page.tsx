// =============================================================================
// /portal/tcms/aufgaben/:id — Kontrollaufgabe im Mandantenportal (TCMS Stufe 3,
// Bereich D; portiert aus der Demo portal/tcms/aufgaben/[id]/page.tsx).
//
// Mandant nur aus der Portal-Sitzung (tcmsPortalSeite). Sichtbarkeit, Rechte
// (`rechte.*` mit Grund), Status und Prüfung des Stands liefert das Tax-CMS;
// die Seite zeigt sie an. Anlagen über die Portal-Dokumentenpipeline der
// kanzleikonsole, Abruf über /api/portal/tcms/aufgaben/[id]/anlagen/[nachweisId]
// (Hash-Abgleich). Namen der Personen aus der kanzleikonsole (Kontakte nur
// dieses Mandanten).
// =============================================================================

import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import {
  DF_MIN_BEFUND_KOMMENTAR,
  DF_MIN_BEGRUENDUNG,
  DurchfuehrungIdSchema,
  ENDPUNKTE,
  PORTAL_MAX_ANLAGE_BYTES,
  PORTAL_MAX_ANLAGEN,
  StandSchema,
  type Kontrollaufgabe,
} from '@taxtronik/tcms-contract';
import { isoDatumText } from '@/components/tcms/format';
import { AnlagenGesperrt, AnlagenKarte } from '@/components/tcms/portal/anlagen';
import { AnlagenUpload } from '@/components/tcms/portal/anlagen-upload';
import { AufgabeEditor } from '@/components/tcms/portal/aufgabe-editor';
import {
  anlagenGesperrtText,
  AnsprechpartnerKarte,
  aufgabeLage,
  AufgabeAnleitung,
  AufgabeKopf,
  AufgabeStatusKarte,
  BestaetigungKarte,
  NachUebermittlungKarte,
  type AufgabeLage,
} from '@/components/tcms/portal/aufgabe-teile';
import { PORTAL_ANLAGE_ACCEPT, portalAnlageHinweis } from '@/components/tcms/portal/texte';
import { TcmsZustand } from '@/components/tcms/zustand';
import type { TcmsSeitenZustand } from '@/server/tcms/zustand';
import { readPortalFeaturesTx } from '@/server/settings/portal-features';
import { personIdsAus, type TcmsNamen } from '@/server/tcms/namen';
import { ansprechpersonenTx } from '@/server/tcms/portal/ansprechpartner';
import { PORTAL_ANLAGEN_GESAMT_BYTES } from '@/server/tcms/portal/anlagen';
import {
  tcmsLesen,
  tcmsNamenLesen,
  tcmsPortalSeite,
  tcmsTenantLesen,
  type TcmsPortalSeite,
} from '@/server/tcms/seite';
import {
  portalAnlageEntfernenAction,
  portalAnlagenHochladenAction,
  portalAufgabeBestaetigenAction,
  portalAufgabeSpeichernAction,
  portalAufgabeZurueckgebenAction,
} from './actions';

export const metadata = { title: 'Tax-CMS – Kontrollaufgabe' };

type SP = Record<string, string | string[] | undefined>;

/** Feste Hinweise nach einem Anlagen-Abruf (route.ts leitet mit `?anlage=` zurück). */
const ANLAGE_HINWEIS: Readonly<Record<string, string>> = {
  abweichend:
    'Die Anlage wurde nicht ausgeliefert: Die gespeicherte Datei stimmt nicht mit dem im Tax-CMS festgehaltenen Stand überein. Bitte wenden Sie sich an Ihre Kanzlei.',
  'nicht-verfuegbar':
    'Die Anlage ist im Portal nicht verfügbar. Bitte wenden Sie sich bei Bedarf an Ihre Kanzlei.',
};

function eins(wert: string | string[] | undefined): string | undefined {
  return Array.isArray(wert) ? wert[0] : wert;
}

function Rahmen({ children, ohneTitel }: { children: ReactNode; ohneTitel?: boolean }) {
  return (
    <div className="p-8">
      <Link href="/portal/tcms" className="back-link">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Zur Tax-Compliance-Übersicht
      </Link>
      {ohneTitel ? null : <h1 className="text-2xl font-bold text-primary mb-4">Kontrollaufgabe</h1>}
      {children}
    </div>
  );
}

interface KanzleiDaten {
  ansprechpersonen: Array<{ id: string; name: string }>;
  kanzleiName: string;
  upload: boolean;
}

/** Namen (kanzleikonsole) und Ansprechpersonen/Portal-Funktionen der Kanzlei. */
async function ladeKanzleiDaten(
  seite: TcmsPortalSeite,
  d: Kontrollaufgabe,
): Promise<{ namen: TcmsNamen; kanzlei: KanzleiDaten }> {
  const k = d.kontrolle;
  const [namen, kanzlei] = await Promise.all([
    tcmsNamenLesen(
      seite,
      personIdsAus(
        [k.durchfuehrendId, k.vertretungId, k.gegenzeichnerId],
        [d.durchgefuehrtVon, d.zurueckgewiesenVon, d.mandantBestaetigtVon, d.gegengezeichnetVon],
        d.nachweise.map((n) => n.hochgeladenVon),
      ),
    ),
    tcmsTenantLesen(seite, async (tx) => {
      const bezug = { tenantId: seite.session.user.tenantId, mandantId: seite.mandantId };
      const [personen, funktionen] = await Promise.all([
        ansprechpersonenTx(tx, bezug),
        readPortalFeaturesTx(tx, bezug.tenantId),
      ]);
      const liste = [personen.berufstraeger, personen.hauptbearbeitung].filter(
        (p, i, alle): p is { id: string; name: string } =>
          p !== null && alle.findIndex((x) => x?.id === p.id) === i,
      );
      return {
        ansprechpersonen: liste,
        kanzleiName: personen.berufstraeger?.name ?? 'Ihre Kanzlei',
        upload: funktionen.documentUpload,
      };
    }),
  ]);
  return { namen, kanzlei };
}

/** Anlagen-Karte mit Upload (nur mit Bearbeitungsrecht und freigeschalteten Portal-Uploads). */
function Anlagen({
  d,
  lage,
  namen,
  bearbeitbar,
  upload,
}: {
  d: Kontrollaufgabe;
  lage: AufgabeLage;
  namen: TcmsNamen;
  bearbeitbar: boolean;
  upload: boolean;
}) {
  const entfernen = Object.fromEntries(
    bearbeitbar && d.status !== 'GEPLANT'
      ? d.nachweise
          .filter((n) => !n.gesperrt)
          .map((n) => [n.id, portalAnlageEntfernenAction.bind(null, d.id, n.id)] as const)
      : [],
  );
  const gesperrt = bearbeitbar
    ? 'Das Hochladen von Dokumenten ist im Portal Ihrer Kanzlei nicht freigeschaltet.'
    : anlagenGesperrtText(d, lage);
  return (
    <AnlagenKarte
      anlagen={d.nachweise}
      mindestAnlagen={d.kontrolle.mindestNachweise}
      nachweisText={d.kontrolle.nachweis}
      ausgeblendet={d.nachweiseAusgeblendet}
      namen={namen}
      abruf={(nachweisId) =>
        `/api/portal/tcms/aufgaben/${encodeURIComponent(d.id)}/anlagen/${encodeURIComponent(nachweisId)}`
      }
      entfernen={entfernen}
      upload={
        bearbeitbar && upload ? (
          <AnlagenUpload
            aktion={portalAnlagenHochladenAction.bind(null, d.id)}
            maxDateien={PORTAL_MAX_ANLAGEN}
            maxBytes={PORTAL_MAX_ANLAGE_BYTES}
            maxGesamt={PORTAL_ANLAGEN_GESAMT_BYTES}
            accept={PORTAL_ANLAGE_ACCEPT}
            hinweis={portalAnlageHinweis({
              maxDateien: PORTAL_MAX_ANLAGEN,
              maxBytes: PORTAL_MAX_ANLAGE_BYTES,
              maxGesamt: PORTAL_ANLAGEN_GESAMT_BYTES,
            })}
          />
        ) : (
          <AnlagenGesperrt text={gesperrt} />
        )
      }
    />
  );
}

/** Fester Hinweis zu `?anlage=` (nur bekannte Schlüssel). */
function hinweisAus(code: string | undefined): string | null {
  return code && Object.hasOwn(ANLAGE_HINWEIS, code) ? ANLAGE_HINWEIS[code]! : null;
}

/**
 * Aufgabe zum Stichtag. Ungültige ID, unbekannte oder fremde Aufgabe (404 des
 * Dienstes) und eine Aufgabe, die es zum Stichtag noch nicht gab: notFound().
 */
async function ladeAufgabe(
  seite: TcmsPortalSeite,
  id: string,
  sp: SP,
): Promise<{ ok: true; d: Kontrollaufgabe } | { ok: false; zustand: TcmsSeitenZustand }> {
  if (!DurchfuehrungIdSchema.safeParse(id).success) notFound();
  const standRoh = StandSchema.safeParse(eins(sp['stand']));
  const gelesen = await tcmsLesen(seite, ENDPUNKTE.portalAufgabeLesen, {
    params: { durchfuehrungId: id },
    query: standRoh.success ? { stand: standRoh.data } : {},
  });
  if (!gelesen.ok) return { ok: false, zustand: gelesen.zustand };
  if (!gelesen.daten.vorhandenZumStand) notFound();
  return { ok: true, d: gelesen.daten };
}

/** Mängel laut Prüfung des Dienstes (nur offene, aktuelle Aufgaben). */
function NochOffen({ d, lage }: { d: Kontrollaufgabe; lage: AufgabeLage }) {
  if (!lage.offen || lage.historisch || d.pruefung.maengel.length === 0) return null;
  return (
    <p className="text-sm text-secondary mb-4">
      <span className="font-medium">Noch offen:</span> {d.pruefung.maengel.join(' · ')}
      {d.anzeige === 'UEBERFAELLIG'
        ? ` – die Frist ${isoDatumText(d.faelligAm)} ist überschritten.`
        : ''}
    </p>
  );
}

/** Editor mit Anlagen; ohne Beginn zum Stichtag ohne Inhalte (wie die Demo, Anzeige). */
function Bearbeitung({
  d,
  lage,
  namen,
  bearbeitbar,
  upload,
}: {
  d: Kontrollaufgabe;
  lage: AufgabeLage;
  namen: TcmsNamen;
  bearbeitbar: boolean;
  upload: boolean;
}) {
  const k = d.kontrolle;
  const ohneInhalt = lage.historisch && !d.begonnenAm;
  return (
    <AufgabeEditor
      aktion={bearbeitbar ? portalAufgabeSpeichernAction.bind(null, d.id) : null}
      bearbeitbar={bearbeitbar}
      sperrGrund={lage.historisch ? 'Historischer Stand – nur Lesen.' : d.rechte.bearbeiten.grund}
      schritte={
        ohneInhalt ? d.schritte.map((s) => ({ ...s, erledigt: false, kommentar: '' })) : d.schritte
      }
      kennzahlen={k.kennzahlen}
      werte={ohneInhalt ? [] : d.werte}
      ausserhalb={d.pruefung.ausserhalb}
      toleranzEur={k.toleranzEur}
      periodeLabel={d.periodeLabel}
      ergebnis={ohneInhalt ? null : d.ergebnis}
      ergebnisKommentar={ohneInhalt ? null : d.ergebnisKommentar}
      minBefund={DF_MIN_BEFUND_KOMMENTAR}
      einreichenLabel={
        k.gegenzeichnungMandant ? 'Zur Bestätigung übermitteln' : 'An Kanzlei übermitteln'
      }
      fussleiste={lage.offen && !lage.historisch}
      anlagen={
        <Anlagen d={d} lage={lage} namen={namen} bearbeitbar={bearbeitbar} upload={upload} />
      }
    />
  );
}

function Seitenleiste({
  d,
  lage,
  namen,
  kanzlei,
}: {
  d: Kontrollaufgabe;
  lage: AufgabeLage;
  namen: TcmsNamen;
  kanzlei: KanzleiDaten;
}) {
  return (
    <>
      <AufgabeStatusKarte d={d} namen={namen} />
      {lage.bestaetigungOffen && !lage.historisch ? (
        <BestaetigungKarte
          d={d}
          namen={namen}
          zurueckgeben={portalAufgabeZurueckgebenAction.bind(null, d.id)}
          bestaetigen={portalAufgabeBestaetigenAction.bind(null, d.id)}
          minBegruendung={DF_MIN_BEGRUENDUNG}
        />
      ) : null}
      {lage.abgeschlossen || d.status === 'ENTFALLEN' ? null : (
        <NachUebermittlungKarte d={d} namen={namen} kanzleiName={kanzlei.kanzleiName} />
      )}
      <AnsprechpartnerKarte personen={kanzlei.ansprechpersonen} />
    </>
  );
}

export default async function PortalKontrollaufgabePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SP>;
}) {
  const seite = await tcmsPortalSeite();
  if (!seite.ok) {
    return (
      <Rahmen>
        <TcmsZustand zustand={seite.zustand} />
      </Rahmen>
    );
  }
  const { id } = await params;
  const sp = await searchParams;
  const gelesen = await ladeAufgabe(seite, id, sp);
  if (!gelesen.ok) {
    return (
      <Rahmen>
        <TcmsZustand zustand={gelesen.zustand} />
      </Rahmen>
    );
  }
  const d = gelesen.d;
  const k = d.kontrolle;
  const lage = aufgabeLage(d);
  // Bearbeitungsrecht entscheidet der Dienst (`rechte.bearbeiten`).
  const bearbeitbar = !lage.historisch && d.rechte.bearbeiten.erlaubt;
  const ich = seite.session.user.contactId.toLowerCase();
  const zugewiesen =
    ich === k.durchfuehrendId?.toLowerCase() || ich === k.vertretungId?.toLowerCase();
  const { namen, kanzlei } = await ladeKanzleiDaten(seite, d);
  const anlageHinweis = hinweisAus(eins(sp['anlage']));

  return (
    <Rahmen ohneTitel>
      <AufgabeKopf d={d} lage={lage} namen={namen} />
      <AufgabeAnleitung
        d={d}
        lage={lage}
        namen={namen}
        zugewiesen={zugewiesen}
        kanzleiName={kanzlei.kanzleiName}
      />
      {anlageHinweis ? (
        <p className="alert-warning mb-4" role="alert">
          {anlageHinweis}
        </p>
      ) : null}
      <NochOffen d={d} lage={lage} />

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
        <div className="xl:col-span-8 space-y-4">
          <Bearbeitung
            d={d}
            lage={lage}
            namen={namen}
            bearbeitbar={bearbeitbar}
            upload={kanzlei.upload}
          />
        </div>
        <div className="xl:col-span-4 space-y-4">
          <Seitenleiste d={d} lage={lage} namen={namen} kanzlei={kanzlei} />
        </div>
      </div>
      <p className="alert-info-sm mt-4">
        Angaben Ihrer Kanzlei. Statusangaben sind Arbeitsstände, keine Aussage über Angemessenheit
        oder Wirksamkeit.
      </p>
    </Rahmen>
  );
}
