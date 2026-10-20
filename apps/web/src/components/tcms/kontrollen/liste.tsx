// =============================================================================
// Kontrollmatrix als Liste und als Matrix Risiken × Kontrollen (TCMS Stufe 3,
// portiert aus der Demo staff/clients/[id]/tcms/kontrollen/page.tsx und
// components/kontrollen/matrix.tsx). Anzeige von `GET …/kontrollen`; Risiken
// (Klasse, GT) aus dem Kontext, Namen aus der kanzleikonsole. Frequenz,
// Design, Betrieb und Fälligkeit berechnet der Dienst.
// =============================================================================

import Link from 'next/link';
import { KeyRound } from 'lucide-react';
import type { KontextAntwort, KontrolleEintrag } from '@taxtronik/tcms-contract';
import {
  ANZEIGE_LABEL,
  AUSFUEHRUNG_LABEL,
  frequenzLabel,
  gleicheFrequenz,
  katalogKontrolle,
  KLASSE_RANG,
  KONTROLLART_LABEL,
  PARTEI_LABEL,
} from '@taxtronik/tcms-domain';
import type { TcmsNamen } from '@/server/tcms/namen';
import { GtBadge, KlasseBadge } from '../badges';
import { isoDatumText } from '../format';
import { kurzName } from '../risiken/labels';
import { DesignBadge, DurchfuehrungBadge, SchluesselBadge } from './badges';
import { TcmsText } from '@/components/tcms/text';

type Risiko = KontextAntwort['risiken'][number];

/** Name kurz, wenn bekannt (sonst „Unbekannte Person“ bzw. „—“ unverändert). */
export function personKurz(namen: TcmsNamen, id: string | null): string {
  const name = namen.name(id);
  return namen.bekannt(id) ? kurzName(name) : name;
}

function FrequenzZelle({ k, namen }: { k: KontrolleEintrag; namen: TcmsNamen }) {
  const offen = k.abweichung && !k.abweichung.freigegebenVon ? k.abweichung : null;
  const frei = k.abweichung?.freigegebenVon ? k.abweichung : null;
  return (
    <div className="flex flex-col items-start gap-1">
      <span className="inline-flex flex-wrap items-center gap-1">
        <span>{frequenzLabel(k.frequenz)}</span>
        {frei ? (
          <span
            className="badge-yellow"
            title={`Begründete Abweichung: „${frei.begruendung ?? ''}“ · freigegeben von ${namen.name(frei.freigegebenVon)}\nVorlage: ${frequenzLabel(k.vorlage)} · Matrix: ${frequenzLabel(k.ableitung.mindest)}`}
          >
            abweichend
          </span>
        ) : k.ableitung.abweichendVonVorlage ? (
          <span className="badge-gray" title={k.ableitung.begruendung}>
            aus Matrix
          </span>
        ) : null}
        {offen ? (
          <span
            className="badge-purple"
            title={`Beantragt von ${namen.name(offen.beantragtVon)}: ${frequenzLabel(offen.frequenz)} – „${offen.begruendung ?? ''}“`}
          >
            Abweichung beantragt
          </span>
        ) : null}
      </span>
      {!gleicheFrequenz(k.vorlage, k.frequenz) ? (
        <span className="text-xs text-muted" title={k.ableitung.begruendung}>
          Vorlage: {frequenzLabel(k.vorlage)}
        </span>
      ) : null}
    </div>
  );
}

interface ZeilenKontext {
  risikoCode: ReadonlyMap<string, string>;
  namen: TcmsNamen;
  wirksamAb: string | null;
  detailHref: (kontrolleId: string) => string;
  risikoHref: (risikoId: string) => string;
  feststellungHref: (feststellungId: string) => string;
}

function KontrolleZelle({ k, z }: { k: KontrolleEintrag; z: ZeilenKontext }) {
  const href = z.detailHref(k.id);
  return (
    <td className="px-3 py-2 min-w-[12rem]">
      <Link href={href} scroll={false} className="block font-mono text-xs text-muted">
        {k.code}
      </Link>
      <Link href={href} scroll={false} className="font-medium text-primary hover:underline">
        <TcmsText>{k.titel}</TcmsText>
      </Link>
      <span className="mt-1 flex flex-wrap gap-1">
        {k.risikoIds.length > 0 ? (
          k.risikoIds.map((rid, i) => {
            const code = z.risikoCode.get(rid) ?? k.risikoCodes[i] ?? '';
            return (
              <Link
                key={rid}
                href={z.risikoHref(rid)}
                className="font-mono text-xs text-muted hover:underline"
                title={`abgedecktes Risiko ${code}`}
              >
                {code.replace(/^EC-/, '')}
              </Link>
            );
          })
        ) : (
          <span className="text-xs text-muted">alle Risiken (Kultur, Kommunikation)</span>
        )}
      </span>
      {!k.pflichtattributeOk || k.pflichtattributeLuecken.length ? (
        <span className="block text-xs text-red-700">
          Pflichtattribute unvollständig
          {k.pflichtattributeLuecken.length ? `: ${k.pflichtattributeLuecken.join(', ')}` : ''}
        </span>
      ) : null}
    </td>
  );
}

function PersonenZelle({ k, namen }: { k: KontrolleEintrag; namen: TcmsNamen }) {
  const gegenzeichnung = k.gegenzeichnungMandant
    ? `GZ ${personKurz(namen, k.vertretungId)} (Mandant)`
    : k.gegenzeichnerId
      ? `GZ ${personKurz(namen, k.gegenzeichnerId)}${k.schluessel ? ' (Pflicht)' : ''}`
      : 'ohne Gegenzeichnung';
  return (
    <td className="px-3 py-2 whitespace-nowrap">
      <span
        className="block"
        title={`Durchführend: ${namen.name(k.durchfuehrendId)} · Vertretung: ${namen.name(k.vertretungId)}`}
      >
        {personKurz(namen, k.durchfuehrendId)} / {personKurz(namen, k.vertretungId)}
      </span>
      <span className="block text-xs text-muted">{gegenzeichnung}</span>
    </td>
  );
}

function LetzteZelle({ k, z }: { k: KontrolleEintrag; z: ZeilenKontext }) {
  const f = k.letzte?.feststellung ?? null;
  if (!k.letzte) {
    return (
      <td className="px-3 py-2">
        <span
          className="text-muted"
          title="noch keine abgeschlossene oder eingereichte Durchführung"
        >
          —
        </span>
      </td>
    );
  }
  const p153 = !!f && !f.maskiert && f.p153Offen;
  return (
    <td className="px-3 py-2">
      <span className="flex flex-col items-start gap-1">
        <DurchfuehrungBadge d={k.letzte} />
        {f ? (
          <Link
            href={z.feststellungHref(f.id)}
            className={`text-xs hover:underline ${p153 ? 'text-red-700' : ''}`}
          >
            → {f.nummer}
            {p153 ? ' (§ 153 offen)' : ''}
          </Link>
        ) : null}
      </span>
    </td>
  );
}

function NaechsteZelle({ k, wirksamAb }: { k: KontrolleEintrag; wirksamAb: string | null }) {
  const n = k.naechste;
  let inhalt;
  if (n) {
    const ueber = n.anzeige === 'UEBERFAELLIG';
    inhalt = (
      <span
        className={ueber ? 'text-red-700' : 'text-secondary'}
        title={`${n.periodeLabel} · ${ANZEIGE_LABEL[n.anzeige]}`}
      >
        {isoDatumText(n.faelligAm)}
        {ueber ? <span className="sr-only"> (überfällig)</span> : null}
      </span>
    );
  } else if (k.frequenz.turnus === 'KEIN') {
    inhalt = <span className="text-secondary">nach Ereignis</span>;
  } else if (!wirksamAb) {
    inhalt = (
      <span
        className="text-xs text-muted"
        title="Durchführungen werden ab Beginn des Wirksamkeitszeitraums geplant"
      >
        ab Wirksamkeitszeitraum
      </span>
    );
  } else {
    inhalt = (
      <span className="text-muted" title="keine geplante Durchführung">
        —
      </span>
    );
  }
  return <td className="px-3 py-2 whitespace-nowrap">{inhalt}</td>;
}

function KontrollZeile({
  k,
  z,
  ausgewaehlt,
}: {
  k: KontrolleEintrag;
  z: ZeilenKontext;
  ausgewaehlt: boolean;
}) {
  const kat = katalogKontrolle(k.code);
  return (
    <tr
      className={`border-t border-default align-top ${ausgewaehlt ? 'bg-surface-raised' : ''}`}
      aria-current={ausgewaehlt ? 'true' : undefined}
    >
      <KontrolleZelle k={k} z={z} />
      <td className="px-3 py-2 whitespace-nowrap">
        <span className="inline-flex gap-1">
          <span className="badge-gray" title={KONTROLLART_LABEL[k.art]}>
            {k.art}
            <span className="sr-only"> ({KONTROLLART_LABEL[k.art]})</span>
          </span>
          <span className="badge-gray" title={AUSFUEHRUNG_LABEL[k.ausfuehrung]}>
            {k.ausfuehrung}
            <span className="sr-only"> ({AUSFUEHRUNG_LABEL[k.ausfuehrung]})</span>
          </span>
        </span>
      </td>
      <td className="px-3 py-2">
        <GtBadge gt={k.gt} />
      </td>
      <td className="px-3 py-2 min-w-[8rem]">
        <FrequenzZelle k={k} namen={z.namen} />
      </td>
      <td className="px-3 py-2">
        <span className="badge-gray">{PARTEI_LABEL[k.partei]}</span>
        {kat?.review ? <span className="block text-xs text-muted mt-1">{kat.review}</span> : null}
      </td>
      <PersonenZelle k={k} namen={z.namen} />
      <td className="px-3 py-2">
        {k.schluessel ? (
          <SchluesselBadge kurz />
        ) : (
          <span className="text-muted">
            <span aria-hidden="true">·</span>
            <span className="sr-only">nein</span>
          </span>
        )}
      </td>
      <td className="px-3 py-2 whitespace-nowrap">
        <DesignBadge
          design={k.design}
          von={personKurz(z.namen, k.designVon)}
          am={k.designAm}
          begruendung={k.designBegruendung}
          kurz
        />
      </td>
      <LetzteZelle k={k} z={z} />
      <NaechsteZelle k={k} wirksamAb={z.wirksamAb} />
    </tr>
  );
}

export function KontrollTabelle({
  kontrollen,
  risikoCode,
  namen,
  wirksamAb,
  detailHref,
  risikoHref,
  feststellungHref,
  ausgewaehlt,
}: {
  kontrollen: readonly KontrolleEintrag[];
  risikoCode: ReadonlyMap<string, string>;
  namen: TcmsNamen;
  wirksamAb: string | null;
  detailHref: (kontrolleId: string) => string;
  risikoHref: (risikoId: string) => string;
  feststellungHref: (feststellungId: string) => string;
  ausgewaehlt: string | null;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">Kontrollen des Programms ({kontrollen.length})</caption>
        <thead>
          <tr>
            <th scope="col" className="th">
              Kontrolle
            </th>
            <th
              scope="col"
              className="th"
              title="Art (P präventiv · D detektiv · K korrigierend) / Ausführung (M manuell · IT IT-gestützt · A automatisiert)"
            >
              Art / Ausf.
            </th>
            <th scope="col" className="th" title="Governance-Typ des maßgeblichen Risikos">
              GT
            </th>
            <th scope="col" className="th">
              Frequenz
            </th>
            <th scope="col" className="th">
              Partei
            </th>
            <th scope="col" className="th" title="Durchführend / Vertretung · Gegenzeichnung (GZ)">
              Personen
            </th>
            <th scope="col" className="th">
              <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="sr-only">Schlüsselkontrolle</span>
            </th>
            <th scope="col" className="th">
              Design
            </th>
            <th scope="col" className="th">
              Letzte Durchführung
            </th>
            <th scope="col" className="th">
              Nächste Fälligkeit
            </th>
          </tr>
        </thead>
        <tbody>
          {kontrollen.map((k) => (
            <KontrollZeile
              key={k.id}
              k={k}
              z={{ risikoCode, namen, wirksamAb, detailHref, risikoHref, feststellungHref }}
              ausgewaehlt={ausgewaehlt === k.id}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Matrix Risiken × Kontrollen (Fachkonzept S6): Punkt je Zuordnung, gefüllt =
 * Schlüsselkontrolle; Risiken ohne Kontrolle rot markiert und benannt.
 */
export function KontrollMatrix({
  risiken,
  kontrollen,
  kontrolleHref,
  risikoHref,
}: {
  risiken: readonly Risiko[];
  kontrollen: readonly KontrolleEintrag[];
  kontrolleHref: (id: string) => string;
  risikoHref: (id: string) => string;
}) {
  const zeilen = [...risiken].sort(
    (a, b) =>
      KLASSE_RANG[b.bewertung.brutto.klasse] - KLASSE_RANG[a.bewertung.brutto.klasse] ||
      a.code.localeCompare(b.code),
  );
  const ohneKontrolle = zeilen.filter((r) => r.kontrollIds.length === 0);
  const ohneRisiko = kontrollen.filter((k) => k.risikoIds.length === 0);
  return (
    <>
      <div className="overflow-x-auto">
        <table className="text-sm">
          <caption className="sr-only">
            Zuordnung der Risiken (Zeilen) zu den Kontrollen (Spalten)
          </caption>
          <thead>
            <tr>
              <th scope="col" className="th sticky left-0 bg-surface-raised min-w-[16rem]">
                Risiko × Kontrolle
              </th>
              <th scope="col" className="th">
                Brutto
              </th>
              <th scope="col" className="th">
                GT
              </th>
              {kontrollen.map((k) => (
                <th
                  key={k.id}
                  scope="col"
                  className="th px-1 text-center"
                  title={`${k.code} · ${k.titel}`}
                >
                  <Link
                    href={kontrolleHref(k.id)}
                    className="font-mono"
                    aria-label={`${k.code} · ${k.titel}`}
                  >
                    {k.code.replace(/^K-EC-/, '')}
                  </Link>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {zeilen.map((r) => (
              <tr key={r.id} className="border-t border-default">
                <th
                  scope="row"
                  className="sticky left-0 bg-surface-raised px-3 py-1.5 text-left font-normal whitespace-nowrap"
                >
                  <Link href={risikoHref(r.id)} className="hover:underline">
                    <span className="font-mono font-medium">{r.code}</span>{' '}
                    <span className="text-xs text-muted" title={r.titel}>
                      ·{' '}
                      <TcmsText>
                        {r.titel.length > 34 ? `${r.titel.slice(0, 33)}…` : r.titel}
                      </TcmsText>
                    </span>
                  </Link>
                  {r.kontrollIds.length === 0 ? (
                    <span className="badge-red ml-2">ohne Kontrolle</span>
                  ) : null}
                </th>
                <td className="px-2 py-1.5">
                  <KlasseBadge klasse={r.bewertung.brutto.klasse} />
                </td>
                <td className="px-2 py-1.5">
                  <GtBadge gt={r.gt} />
                </td>
                {kontrollen.map((k) => {
                  const zu = r.kontrollIds.includes(k.id);
                  return (
                    <td key={k.id} className="px-1 py-1.5 text-center">
                      {zu ? (
                        <Link
                          href={kontrolleHref(k.id)}
                          title={`${k.schluessel ? 'Schlüsselkontrolle' : 'Zugeordnete Kontrolle'}: ${k.code} → ${r.code}`}
                          className={k.schluessel ? 'text-brand-600' : 'text-muted'}
                        >
                          <span aria-hidden="true">{k.schluessel ? '●' : '○'}</span>
                          <span className="sr-only">
                            {k.schluessel ? 'Schlüsselkontrolle' : 'zugeordnet'} {k.code}
                          </span>
                        </Link>
                      ) : null}
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr className="border-t border-default">
              <th
                scope="row"
                className="sticky left-0 bg-surface-raised px-3 py-1.5 text-left text-xs text-muted font-normal"
              >
                Risiken je Kontrolle
              </th>
              <td />
              <td />
              {kontrollen.map((k) => (
                <td
                  key={k.id}
                  className="px-1 py-1.5 text-center font-mono text-xs"
                  title={k.risikoCodes.join(', ') || 'keine Risikozuordnung'}
                >
                  {k.risikoIds.length}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <p className="border-t border-default p-4 text-sm text-secondary">
        <span className="text-brand-600" aria-hidden="true">
          ●
        </span>{' '}
        Schlüsselkontrolle ·{' '}
        <span className="text-muted" aria-hidden="true">
          ○
        </span>{' '}
        zugeordnete Kontrolle.{' '}
        {ohneKontrolle.length === 0
          ? `Alle ${zeilen.length} Risiken sind mindestens einer Kontrolle zugeordnet.`
          : `${ohneKontrolle.length} ${ohneKontrolle.length === 1 ? 'Risiko ist' : 'Risiken sind'} ohne Kontrolle: ${ohneKontrolle.map((r) => r.code).join(', ')}.`}
        {ohneRisiko.length
          ? ` Ohne Risikozuordnung: ${ohneRisiko.map((k) => k.code).join(', ')} (Grundelemente Kultur/Kommunikation).`
          : ''}
      </p>
    </>
  );
}
