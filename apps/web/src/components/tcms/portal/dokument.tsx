// =============================================================================
// Vorgelegte Fassung einer CMS-Beschreibung im Portal (TCMS Stufe 3, Bereich D;
// aus der Demo components/portal/freigabe.tsx, Dokument, und
// components/beschreibung/abschnitt.tsx in reiner Leseform).
//
// Eingefrorene Fassung: Abschnitte und Bausteine aus dem Snapshot, so wie sie
// beim Anfordern eingefroren und mit SHA-256 gebunden wurden (inklusive der
// damals übergebenen Anzeigenamen – Inhalt des Dokuments, keine Namens-
// auflösung). Ohne Snapshot: aktuelle Abschnitte und lebende Bausteine zum
// Stand der Antwort. Fehlen Daten eines Bausteins, steht ein Hinweis statt
// erfundener Werte. Die vollständige Bausteinansicht liegt bei Bereich A
// (Beschreibung); beim Zusammenführen kann diese Leseform sie verwenden.
// =============================================================================

import type { ReactNode } from 'react';
import { Lock } from 'lucide-react';
import type { BausteinSatzDaten, BeschreibungAbschnitt } from '@taxtronik/tcms-contract';
import {
  ABSCHNITTE,
  BAUSTEIN_LABEL,
  BAUSTEIN_QUELLE,
  KLASSE_LABEL,
  type BausteinArt,
} from '@taxtronik/tcms-domain';
import { HashKurz } from '../badges';
import { isoDatumText } from '../format';

type Satz = Partial<BausteinSatzDaten>;

function Leer({ art }: { art: BausteinArt }) {
  return (
    <p className="text-xs text-muted">
      {BAUSTEIN_LABEL[art]} (aus {BAUSTEIN_QUELLE[art]}) – in dieser Fassung ohne Daten.
    </p>
  );
}

function Tabelle({
  titel,
  kopf,
  zeilen,
}: {
  titel: string;
  kopf: readonly string[];
  zeilen: ReadonlyArray<readonly string[]>;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <caption className="text-left font-medium text-secondary mb-1">{titel}</caption>
        <thead>
          <tr>
            {kopf.map((k) => (
              <th key={k} scope="col" className="th">
                {k}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {zeilen.map((z, i) => (
            <tr key={i} className="border-t border-default">
              {z.map((zelle, j) => (
                <td key={j} className="px-3 py-1 align-top">
                  {zelle}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function zielFreigabe(ziel: BausteinSatzDaten['ZIELE']['ziele'][number]): string {
  if (ziel.freigabe === 'AUSSTEHEND') return 'ausstehend';
  if (ziel.freigabe !== 'FREIGEGEBEN') return 'Entwurf';
  const von = ziel.freigegebenVon ? ` · ${ziel.freigegebenVon}` : '';
  const am = ziel.freigegebenAm ? ` · ${isoDatumText(ziel.freigegebenAm)}` : '';
  return `freigegeben${von}${am}`;
}

function designText(k: BausteinSatzDaten['KONTROLLMATRIX']['kontrollen'][number]): string {
  if (k.design === 'ANGEMESSEN') return `angemessen${k.designVon ? ` · ${k.designVon}` : ''}`;
  return k.design === 'MANGEL' ? 'Mangel' : 'nicht beurteilt';
}

const REGISTRIERUNG: Readonly<Record<string, string>> = {
  VOLLSTAENDIG: 'vollständig',
  FEHLT: 'fehlt',
  PRUEFEN: 'prüfen',
};

/** Je Baustein die Darstellung aus den Daten der Fassung; null = keine Daten. */
const BAUSTEINE: { readonly [A in BausteinArt]: (satz: Satz) => ReactNode | null } = {
  TEILBEREICH: ({ TEILBEREICH: t }) =>
    t ? (
      <div className="text-xs space-y-1">
        <p className="font-medium text-secondary">{BAUSTEIN_LABEL.TEILBEREICH}</p>
        <p>
          <strong>{t.name}</strong> – {t.abgrenzung}
        </p>
        {t.einschluesse.length ? <p>Eingeschlossen: {t.einschluesse.join(', ')}</p> : null}
        {t.ausschluesse.length ? <p>Ausgeschlossen: {t.ausschluesse.join(', ')}</p> : null}
      </div>
    ) : null,
  ZIELE: ({ ZIELE: z }) =>
    z ? (
      <Tabelle
        titel={`${BAUSTEIN_LABEL.ZIELE} (Risikoappetit ${KLASSE_LABEL[z.appetit]})`}
        kopf={['Ziel', 'Wesentlichkeit', 'Freigabe']}
        zeilen={z.ziele.map((ziel) => [
          ziel.text,
          `${ziel.wesentlichkeitEur.toLocaleString('de-DE')} €`,
          zielFreigabe(ziel),
        ])}
      />
    ) : null,
  RISIKOINVENTAR: ({ RISIKOINVENTAR: r }) =>
    r ? (
      <Tabelle
        titel={BAUSTEIN_LABEL.RISIKOINVENTAR}
        kopf={['Code', 'Risiko', 'Brutto', 'Netto', 'Kontrollen']}
        zeilen={r.risiken.map((x) => [
          x.code,
          x.titel,
          KLASSE_LABEL[x.brutto],
          `${KLASSE_LABEL[x.netto]}${x.ueberAppetit ? ' (über Appetit)' : ''}`,
          String(x.kontrollen),
        ])}
      />
    ) : null,
  KONTROLLMATRIX: ({ KONTROLLMATRIX: k }) =>
    k ? (
      <Tabelle
        titel={BAUSTEIN_LABEL.KONTROLLMATRIX}
        kopf={['Code', 'Kontrolle', 'Frequenz', 'Partei', 'Designbeurteilung']}
        zeilen={k.kontrollen.map((x) => [
          x.code,
          x.titel,
          x.frequenz,
          x.partei === 'MANDANT' ? 'Mandant' : 'Kanzlei',
          designText(x),
        ])}
      />
    ) : null,
  VERANTWORTUNG: ({ VERANTWORTUNG: v }) =>
    v ? (
      <div className="space-y-2">
        {v.rollen.length ? (
          <p className="text-xs">{v.rollen.map((r) => `${r.rolle}: ${r.name}`).join(' · ')}</p>
        ) : null}
        <Tabelle
          titel={BAUSTEIN_LABEL.VERANTWORTUNG}
          kopf={['Code', 'Kontrolle', 'Durchführung', 'Vertretung', 'Gegenzeichnung']}
          zeilen={v.kontrollen.map((x) => [
            x.code,
            x.titel,
            x.durchfuehrend,
            x.vertretung,
            x.gegenzeichnung,
          ])}
        />
      </div>
    ) : null,
  LAENDER: ({ LAENDER: l }) =>
    l ? (
      <Tabelle
        titel={`${BAUSTEIN_LABEL.LAENDER}${l.stand ? ` (Stand ${isoDatumText(l.stand)})` : ''}`}
        kopf={['Land', 'Fernverkäufe lfd. Jahr', 'Registrierung']}
        zeilen={l.laender.map((x) => [
          `${x.land} · ${x.name}`,
          `${x.fernverkaeufeLfdEur.toLocaleString('de-DE')} €`,
          REGISTRIERUNG[x.registrierung] ?? x.registrierung,
        ])}
      />
    ) : null,
  FESTSTELLUNGEN: ({ FESTSTELLUNGEN: f }) =>
    f ? (
      <Tabelle
        titel={BAUSTEIN_LABEL.FESTSTELLUNGEN}
        kopf={['Nummer', 'Feststellung', 'Schwere', 'Status', 'offene Maßnahmen']}
        zeilen={f.feststellungen.map((x) => [
          x.nummer,
          x.titel,
          KLASSE_LABEL[x.schwere],
          x.status,
          String(x.massnahmenOffen),
        ])}
      />
    ) : null,
};

/** Lesende Darstellung eines Bausteins aus den Daten der Fassung. */
export function BausteinLesen({ art, satz }: { art: BausteinArt; satz: Satz | null }) {
  return BAUSTEINE[art](satz ?? {}) ?? <Leer art={art} />;
}

/** Abschnitte 0–7 und Anhang in fester Reihenfolge (Gliederung der Domain). */
export function BeschreibungLesen({
  abschnitte,
  satz,
  snapshotSha256,
  eingefroren,
}: {
  abschnitte: readonly BeschreibungAbschnitt[];
  satz: Satz | null;
  snapshotSha256: string | null;
  eingefroren: boolean;
}) {
  return (
    <div className="space-y-4">
      {eingefroren && snapshotSha256 ? (
        <p className="text-xs text-muted flex flex-wrap items-center gap-2">
          <span className="badge-gray gap-1">
            <Lock className="h-3 w-3" aria-hidden="true" />
            <HashKurz wert={snapshotSha256} />
          </span>
          Vorgelegte Fassung, durch SHA-256 gebunden.
        </p>
      ) : null}
      {ABSCHNITTE.map((vorlage) => {
        const abschnitt = abschnitte.find((a) => a.key === vorlage.key);
        const bloecke = abschnitt?.bloecke ?? [];
        return (
          <section
            key={vorlage.key}
            aria-label={`${vorlage.nr} ${vorlage.titel}`}
            className="space-y-2"
          >
            <h4 className="text-sm font-semibold text-primary">
              {vorlage.nr} · {vorlage.titel}
            </h4>
            {bloecke.length === 0 ? (
              <p className="text-xs text-muted">Kein Inhalt.</p>
            ) : (
              bloecke.map((b, i) =>
                b.typ === 'text' ? (
                  <p key={i} className="text-sm text-secondary whitespace-pre-wrap">
                    {b.text}
                  </p>
                ) : (
                  <BausteinLesen key={i} art={b.art} satz={satz} />
                ),
              )
            )}
          </section>
        );
      })}
    </div>
  );
}
