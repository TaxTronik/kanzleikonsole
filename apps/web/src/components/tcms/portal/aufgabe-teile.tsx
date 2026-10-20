// =============================================================================
// Teile der Kontrollaufgabe im Portal (TCMS Stufe 3, Bereich D; aus der Demo
// portal/tcms/aufgaben/[id]/page.tsx): Kopf, Anleitung, Status, Bestätigung
// durch eine zweite Person, nächste Schritte und Ansprechpartner. Reine
// Anzeigeauswahl auf Status, Zeitpunkten und Rechten der Antwort des Dienstes;
// Namen aus der kanzleikonsole. Aktionen kommen gebunden von der Seite.
// =============================================================================

import Link from 'next/link';
import type { ReactNode } from 'react';
import { History, RotateCcw, UserCheck, UserRound } from 'lucide-react';
import type { Kontrollaufgabe } from '@taxtronik/tcms-contract';
import { AnzeigeBadge } from '../badges';
import { isoDatumKurzText, isoDatumText, isoZeitText } from '../format';
import { TcmsAktionsKnopf, TcmsFormDialog, type TcmsFormAktion } from '../ereignisse/aktionen';
import { aufgabeStatusText } from './texte';
import { TcmsText } from '@/components/tcms/text';

type Namen = { name(id: string | null | undefined): string };

/** Abgeleitete Lage der Aufgabe (nur aus Feldern der Antwort). */
export interface AufgabeLage {
  offen: boolean;
  abgeschlossen: boolean;
  bestaetigungOffen: boolean;
  historisch: boolean;
}

export function aufgabeLage(d: Kontrollaufgabe): AufgabeLage {
  return {
    offen:
      d.status === 'GEPLANT' || d.status === 'IN_DURCHFUEHRUNG' || d.status === 'ZURUECKGEWIESEN',
    abgeschlossen: d.status === 'OHNE_BEFUND' || d.status === 'MIT_BEFUND',
    bestaetigungOffen:
      d.status === 'ZUR_GEGENZEICHNUNG' &&
      d.kontrolle.gegenzeichnungMandant &&
      !d.mandantBestaetigtVon,
    historisch: d.historisch,
  };
}

/** Warum keine Anlagen hochgeladen werden können (Anzeige). */
export function anlagenGesperrtText(d: Kontrollaufgabe, lage: AufgabeLage): string {
  if (lage.historisch) return 'Historischer Stand – nur Lesen.';
  if (d.status === 'ZUR_GEGENZEICHNUNG') return 'Nach dem Übermitteln gesperrt.';
  if (lage.abgeschlossen) return 'Abgeschlossen – Anlagen gesperrt und unveränderlich.';
  if (d.status === 'ENTFALLEN') return 'Entfallen – keine Uploads.';
  return d.rechte.bearbeiten.grund ?? 'Upload nicht möglich.';
}

function statusText(d: Kontrollaufgabe, lage: AufgabeLage): string {
  return aufgabeStatusText({
    anzeige: d.anzeige,
    faelligAm: d.faelligAm,
    periodeBis: d.periodeBis,
    bestaetigungOffen: lage.bestaetigungOffen,
  });
}

export function AufgabeKopf({
  d,
  lage,
  namen,
}: {
  d: Kontrollaufgabe;
  lage: AufgabeLage;
  namen: Namen;
}) {
  const k = d.kontrolle;
  return (
    <>
      {lage.historisch ? (
        <div
          className="alert-warning mb-3 flex flex-wrap items-center justify-between gap-2"
          role="status"
        >
          <span className="inline-flex items-center gap-2">
            <History className="h-4 w-4" aria-hidden="true" />
            <strong>Stand zum {isoDatumText(d.stand)} – nur Lesen.</strong>
          </span>
          <Link
            href={`/portal/tcms/aufgaben/${encodeURIComponent(d.id)}`}
            className="btn-secondary text-xs py-1"
          >
            Zum aktuellen Stand
          </Link>
        </div>
      ) : null}
      <h1 className="text-2xl font-bold text-primary">
        Kontrollaufgabe · <TcmsText>{k.titel}</TcmsText> <TcmsText>{d.periodeLabel}</TcmsText>
      </h1>
      <div className="flex flex-wrap items-center gap-2 my-3">
        <span className="badge-gray font-mono">{k.code}</span>
        <AnzeigeBadge status={d.anzeige} />
        <span className="text-sm text-secondary">{statusText(d, lage)}</span>
        <span className="badge-gray">
          Formular-Version v{k.version} · {isoDatumText(k.gueltigAb)}
        </span>
        {d.original ? (
          <span className="badge-gray">
            Nachtrag zu <TcmsText>{d.original.periodeLabel}</TcmsText>
          </span>
        ) : null}
      </div>
      {d.status === 'ZURUECKGEWIESEN' && d.zurueckweisungsgrund ? (
        <div className="alert-warning mb-3 flex items-start gap-2">
          <RotateCcw className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
          <span>
            <strong>
              Zur Überarbeitung zurückgegeben von {namen.name(d.zurueckgewiesenVon)}
              {d.zurueckgewiesenAm ? ` am ${isoZeitText(d.zurueckgewiesenAm)}` : ''}:
            </strong>{' '}
            <TcmsText>{d.zurueckweisungsgrund}</TcmsText>
          </span>
        </div>
      ) : null}
    </>
  );
}

/** Anleitung je Lage (Sie-Form). */
export function AufgabeAnleitung({
  d,
  lage,
  namen,
  zugewiesen,
  kanzleiName,
}: {
  d: Kontrollaufgabe;
  lage: AufgabeLage;
  namen: Namen;
  zugewiesen: boolean;
  kanzleiName: string;
}) {
  const k = d.kontrolle;
  const gzm = k.gegenzeichnungMandant;
  let text: ReactNode;
  if (lage.offen && zugewiesen) {
    text = (
      <>
        <TcmsText>{k.ziel}</TcmsText> Bitte erledigen Sie die Schritte für{' '}
        <TcmsText>{d.periodeLabel}</TcmsText> und laden Sie die Anlagen hoch (
        <TcmsText>{k.nachweis}</TcmsText>). Nach dem Übermitteln{' '}
        {gzm
          ? 'bestätigt eine zweite Person bei Ihnen die Vollständigkeit; danach prüft die Kanzlei.'
          : 'prüft die Kanzlei.'}
      </>
    );
  } else if (lage.offen) {
    text = `Diese Aufgabe bearbeitet ${namen.name(k.durchfuehrendId)} (Vertretung ${namen.name(k.vertretungId)}). Sie sehen den ${
      lage.historisch ? `Stand zum ${isoDatumText(d.stand)}` : 'aktuellen Stand'
    }.`;
  } else if (lage.bestaetigungOffen && d.rechte.mandantBestaetigen.erlaubt) {
    text = `${namen.name(d.durchgefuehrtVon)} hat die Aufgabe am ${isoZeitText(d.eingereichtAm)} übermittelt. Bitte prüfen Sie die Angaben und Anlagen auf Vollständigkeit und bestätigen Sie sie. Danach prüft die Kanzlei und schließt die Aufgabe ab.`;
  } else if (d.status === 'ZUR_GEGENZEICHNUNG') {
    text = `Vielen Dank – die Angaben wurden am ${isoZeitText(d.eingereichtAm)} von ${namen.name(d.durchgefuehrtVon)} übermittelt. Die Anlagen sind jetzt gesperrt. ${
      lage.bestaetigungOffen
        ? 'Als Nächstes bestätigt eine zweite Person bei Ihnen die Vollständigkeit.'
        : `Die Kanzlei (${kanzleiName}) prüft und schließt die Aufgabe ab.`
    }`;
  } else if (lage.abgeschlossen) {
    text = `Die Kanzlei hat die Aufgabe am ${isoZeitText(d.abgeschlossenAm)} abgeschlossen (${
      d.status === 'OHNE_BEFUND' ? 'ohne Befund' : 'mit Befund'
    }). Die Angaben und Anlagen sind unveränderlich gespeichert.`;
  } else {
    text = d.entfallenBegruendung ? (
      <>
        Diese Aufgabe ist entfallen: <TcmsText>{d.entfallenBegruendung}</TcmsText>
      </>
    ) : (
      'Diese Aufgabe ist entfallen.'
    );
  }
  return <p className={lage.abgeschlossen ? 'alert-success mb-4' : 'alert-info-sm mb-4'}>{text}</p>;
}

function Punkt({
  ton,
  children,
}: {
  ton: 'green' | 'amber' | 'red' | 'gray';
  children: ReactNode;
}) {
  return (
    <li className="flex items-start gap-2 text-sm">
      <span className={`status-dot dot-${ton} mt-1.5`} aria-hidden="true" />
      <span>{children}</span>
    </li>
  );
}

/** Zeitpunkte der Aufgabe als Punkte (nur vorhandene). */
function statusPunkte(
  d: Kontrollaufgabe,
  namen: Namen,
): Array<[Parameters<typeof Punkt>[0]['ton'], string]> {
  const punkte: Array<[Parameters<typeof Punkt>[0]['ton'], string]> = [
    ['gray', `fällig ab ${isoDatumKurzText(d.periodeBis)} · Frist ${isoDatumText(d.faelligAm)}`],
  ];
  if (d.begonnenAm) {
    punkte.push([
      'green',
      `begonnen ${isoZeitText(d.begonnenAm)} – ${namen.name(d.durchgefuehrtVon)}`,
    ]);
  }
  if (d.nachweise.length > 0) {
    punkte.push([
      'green',
      `${d.nachweise.length === 1 ? '1 Anlage' : `${d.nachweise.length} Anlagen`} hochgeladen`,
    ]);
  }
  if (d.status === 'ZURUECKGEWIESEN' && d.zurueckgewiesenAm) {
    punkte.push(['amber', `zurückgegeben ${isoZeitText(d.zurueckgewiesenAm)}`]);
  }
  if (d.eingereichtAm && d.status !== 'ZURUECKGEWIESEN') {
    punkte.push([
      'green',
      `übermittelt ${isoZeitText(d.eingereichtAm)} – ${namen.name(d.durchgefuehrtVon)}`,
    ]);
  }
  if (d.mandantBestaetigtVon) {
    punkte.push([
      'green',
      `bestätigt ${d.mandantBestaetigtAm ? isoZeitText(d.mandantBestaetigtAm) : ''} – ${namen.name(d.mandantBestaetigtVon)}`,
    ]);
  }
  if (d.abgeschlossenAm) {
    punkte.push([
      'green',
      `abgeschlossen ${isoZeitText(d.abgeschlossenAm)} – Kanzlei (${namen.name(d.gegengezeichnetVon)})`,
    ]);
  }
  if (d.anzeige === 'UEBERFAELLIG')
    punkte.push(['red', `Frist ${isoDatumText(d.faelligAm)} überschritten`]);
  return punkte;
}

export function AufgabeStatusKarte({ d, namen }: { d: Kontrollaufgabe; namen: Namen }) {
  return (
    <section className="card" aria-labelledby="tcms-aufgabe-status">
      <div className="card-header">
        <h2 id="tcms-aufgabe-status" className="text-sm font-semibold text-primary">
          Status
        </h2>
      </div>
      <ul className="p-4 space-y-2">
        {statusPunkte(d, namen).map(([ton, text]) => (
          <Punkt key={text} ton={ton}>
            {text}
          </Punkt>
        ))}
      </ul>
    </section>
  );
}

/** Bestätigung durch eine zweite Person beim Mandanten (Rechte und Gründe laut Dienst). */
export function BestaetigungKarte({
  d,
  namen,
  zurueckgeben,
  bestaetigen,
  minBegruendung,
}: {
  d: Kontrollaufgabe;
  namen: Namen;
  zurueckgeben: TcmsFormAktion;
  bestaetigen: TcmsFormAktion;
  minBegruendung: number;
}) {
  const r = d.rechte;
  return (
    <section className="card" aria-labelledby="tcms-aufgabe-bestaetigung">
      <div className="card-header">
        <h2 id="tcms-aufgabe-bestaetigung" className="text-sm font-semibold text-primary">
          Bestätigung
        </h2>
        <span className="badge-purple">zweite Person</span>
      </div>
      <div className="p-4 space-y-3">
        <p className="text-sm text-secondary">
          Eine zweite Person bei Ihnen bestätigt, dass die Angaben von{' '}
          {namen.name(d.durchgefuehrtVon)} vollständig sind (vorgesehen:{' '}
          {namen.name(d.kontrolle.gegenzeichnerId)}). Die durchführende Person kann nicht selbst
          bestätigen.
        </p>
        <div className="flex flex-wrap items-start justify-end gap-2">
          <TcmsFormDialog
            aktion={zurueckgeben}
            ausloeser="Zur Überarbeitung zurückgeben …"
            titel="Zur Überarbeitung zurückgeben"
            hinweis="Bitte beschreiben Sie, was fehlt oder zu korrigieren ist. Die Anlagen werden für die Überarbeitung wieder freigegeben."
            bestaetigen="Zurückgeben"
            begruendung={{ min: minBegruendung, max: 4000 }}
            gesperrt={r.zurueckweisen.erlaubt ? null : (r.zurueckweisen.grund ?? 'Nicht möglich.')}
            erfolg="Zur Überarbeitung zurückgegeben."
          />
          <TcmsAktionsKnopf
            aktion={bestaetigen}
            className="btn-primary"
            gesperrt={
              r.mandantBestaetigen.erlaubt ? null : (r.mandantBestaetigen.grund ?? 'Nicht möglich.')
            }
            bestaetigung={{
              titel: 'Vollständigkeit bestätigen',
              text: 'Bestätigen Sie die Vollständigkeit der Angaben und Anlagen? Die Bestätigung wird mit Ihrem Namen und dem Zeitpunkt protokolliert.',
              bestaetigen: 'Bestätigen',
            }}
          >
            <UserCheck className="h-4 w-4" aria-hidden="true" /> Vollständigkeit bestätigen
          </TcmsAktionsKnopf>
        </div>
      </div>
    </section>
  );
}

export function NachUebermittlungKarte({
  d,
  namen,
  kanzleiName,
}: {
  d: Kontrollaufgabe;
  namen: Namen;
  kanzleiName: string;
}) {
  const gegenzeichner = namen.name(d.kontrolle.gegenzeichnerId);
  return (
    <section className="card" aria-labelledby="tcms-aufgabe-danach">
      <div className="card-header">
        <h2 id="tcms-aufgabe-danach" className="text-sm font-semibold text-primary">
          Nach der Übermittlung
        </h2>
      </div>
      <p className="p-4 text-sm text-secondary">
        {d.kontrolle.gegenzeichnungMandant
          ? `Eine zweite Person (${gegenzeichner}) bestätigt die Vollständigkeit. Danach prüft die Kanzlei (${kanzleiName}) und schließt die Aufgabe ab.`
          : `Die Kanzlei (${kanzleiName}) prüft Ihre Angaben und schließt die Aufgabe ab. Bei Rückfragen erhalten Sie die Aufgabe mit einer Begründung zurück.`}
      </p>
    </section>
  );
}

export function AnsprechpartnerKarte({
  personen,
}: {
  personen: ReadonlyArray<{ id: string; name: string }>;
}) {
  return (
    <section className="card" aria-labelledby="tcms-aufgabe-kanzlei">
      <div className="card-header">
        <h2 id="tcms-aufgabe-kanzlei" className="text-sm font-semibold text-primary">
          Ansprechpartner in der Kanzlei
        </h2>
      </div>
      <ul className="p-4 space-y-1">
        {personen.map((p) => (
          <li key={p.id} className="flex items-center gap-2 text-sm">
            <UserRound className="h-4 w-4 text-muted" aria-hidden="true" />{' '}
            <TcmsText>{p.name}</TcmsText>
          </li>
        ))}
        {personen.length === 0 ? <li className="text-sm text-muted">Ihr Kanzleiteam</li> : null}
      </ul>
    </section>
  );
}
