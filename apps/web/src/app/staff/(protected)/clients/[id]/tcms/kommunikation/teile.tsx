// =============================================================================
// Teile der Seite „Kommunikation“ (TCMS Stufe 3, Bereich A): Freigaben,
// Kenntnisnahmen, Freigabestände sowie Kultur und Meldewege. Reine Darstellung
// des Modells aus page.tsx; „Neu adressieren“ läuft über ./actions.ts.
// Je Anforderung der Zustellstatus der jüngsten Nachricht (TCMS s6); ist sie
// unzustellbar oder verworfen, weist die Zeile auf die Neuadressierung hin.
// =============================================================================

import Link from 'next/link';
import { Bell, Landmark, Library, Send } from 'lucide-react';
import type {
  FreigabeHistorieZeile,
  FreigabenHistorie,
  KontextAntwort,
} from '@taxtronik/tcms-contract';
import { frequenzLabel } from '@taxtronik/tcms-domain';
import { AnzeigeBadge } from '@/components/tcms/badges';
import { isoDatumText, isoZeitText } from '@/components/tcms/format';
import { TcmsLeer } from '@/components/tcms/leer';
import { TcmsAktionsDialog } from '@/components/tcms/programm/dialog';
import { zustellungGescheitert, ZustellungAnzeige } from '@/components/tcms/zustellung';
import {
  codeText,
  FREIGABE_ART_LABEL,
  FREIGABE_STATUS,
} from '@/components/tcms/programm/freigaben';
import {
  ansprechpersonen,
  kontaktPersonen,
  rollenText,
  type KontaktRolle,
  type Person,
} from '@/components/tcms/programm/kontakte';
import type { TcmsNamen } from '@/server/tcms/namen';
import { freigabeNeuadressierenAction } from './actions';

export interface KommunikationModell {
  mandantId: string;
  basis: string;
  ctx: KontextAntwort;
  h: FreigabenHistorie;
  namen: TcmsNamen;
  rollen: readonly KontaktRolle[];
  /** Offene Anforderungen dürfen neu adressiert werden (Recht laut Dienst, aktueller Stand). */
  neuAdressierbar: boolean;
}

const mitStand = (m: KommunikationModell, href: string) =>
  m.ctx.historisch ? `${href}?stand=${m.ctx.stand}` : href;

function NeuAdressieren({
  mandantId,
  f,
  pool,
  name,
}: {
  mandantId: string;
  f: FreigabeHistorieZeile;
  pool: readonly Person[];
  name: string;
}) {
  const feld = `neuadressierung-${f.id}`;
  return (
    <TcmsAktionsDialog
      ausloeser={
        <>
          <Send className="h-3.5 w-3.5" aria-hidden="true" /> Neu adressieren
          <span className="sr-only"> – {f.titel}</span>
        </>
      }
      ausloeserKlasse="btn-secondary text-xs py-1"
      titel={`„${f.titel}“ neu adressieren`}
      beschreibung={
        <>
          <p>
            Die Anforderung geht an die gewählte Person. Ein bereits ausgestellter Code verfällt,
            die Fehlversuche beginnen neu; die Person erhält eine Nachricht über den Postausgang.
          </p>
          <p>Bisher: {name}.</p>
        </>
      }
      bestaetigen="Neu adressieren"
      gefahr
      aktion={freigabeNeuadressierenAction.bind(null, mandantId)}
      versteckt={{ freigabeId: f.id }}
      erfolg="Die Anforderung ist neu adressiert."
      deaktiviert={pool.length === 0}
      {...(pool.length === 0
        ? {
            deaktiviertGrund:
              f.art === 'KENNTNISNAHME'
                ? 'Kein Kontakt dieses Mandanten mit Rolle im Tax-CMS.'
                : 'Keine gesetzliche Vertretung dieses Mandanten im Tax-CMS hinterlegt.',
          }
        : {})}
      fieldIds={{ empfaengerId: feld }}
    >
      <div>
        <label className="label" htmlFor={feld}>
          {f.art === 'KENNTNISNAHME'
            ? 'Empfänger (Kontakt mit Rolle)'
            : 'Empfänger (gesetzliche Vertretung)'}
        </label>
        <select id={feld} name="empfaengerId" className="input" defaultValue="" required>
          <option value="">Bitte wählen …</option>
          {pool.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.id === f.empfaengerId.toLowerCase() ? ' (bisher)' : ''}
            </option>
          ))}
        </select>
      </div>
    </TcmsAktionsDialog>
  );
}

function StatusZelle({ m, f }: { m: KommunikationModell; f: FreigabeHistorieZeile }) {
  const offen = f.status === 'OFFEN';
  const unterzeile = f.erledigtAm
    ? isoZeitText(f.erledigtAm)
    : offen && !m.h.historisch
      ? codeText(f, isoDatumText)
      : '';
  const pool =
    f.art === 'KENNTNISNAHME'
      ? kontaktPersonen(m.rollen, m.namen)
      : kontaktPersonen(m.rollen, m.namen, ['GESETZLICHER_VERTRETER']);
  return (
    <td className="px-4 py-2 align-top">
      <span className={FREIGABE_STATUS[f.status].badge}>{FREIGABE_STATUS[f.status].label}</span>
      <span className="block text-xs text-muted mt-1">{unterzeile}</span>
      {f.anmerkung ? (
        <span className="block text-xs text-secondary mt-1">„{f.anmerkung}“</span>
      ) : null}
      <ZustellungAnzeige zustellung={f.zustellung} />
      {offen && zustellungGescheitert(f.zustellung) ? (
        <span className="block text-xs text-secondary mt-1">
          {m.neuAdressierbar
            ? 'Die Person hat die Anforderung nicht erhalten. Bitte neu adressieren.'
            : 'Die Person hat die Anforderung nicht erhalten.'}
        </span>
      ) : null}
      {m.neuAdressierbar && offen ? (
        <div className="mt-2">
          <NeuAdressieren
            mandantId={m.mandantId}
            f={f}
            pool={pool}
            name={m.namen.name(f.empfaengerId)}
          />
        </div>
      ) : null}
    </td>
  );
}

function Kopfzeile({ spalten }: { spalten: readonly string[] }) {
  return (
    <thead>
      <tr>
        {spalten.map((s) => (
          <th key={s} scope="col" className="th">
            {s}
          </th>
        ))}
      </tr>
    </thead>
  );
}

export function FreigabenKarte({ m }: { m: KommunikationModell }) {
  const freigaben = m.h.freigaben.filter((f) => f.art !== 'KENNTNISNAHME');
  return (
    <section className="card overflow-hidden" aria-labelledby="kommunikation-freigaben">
      <div className="card-header">
        <h3 id="kommunikation-freigaben" className="text-sm font-semibold text-primary">
          Freigaben
        </h3>
        <span className="badge-gray">{freigaben.length}</span>
      </div>
      {freigaben.length === 0 ? (
        <TcmsLeer icon={Send} text="Noch keine Freigabe über das Portal angefordert." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Freigaben</caption>
            <Kopfzeile spalten={['Gegenstand', 'Empfänger', 'Angefordert', 'Status']} />
            <tbody>
              {freigaben.map((f) => (
                <tr key={f.id} className="border-t border-default">
                  <td className="px-4 py-2 align-top">
                    <span className="block font-medium">{f.titel}</span>
                    <span className="block text-xs text-muted mt-1">
                      {FREIGABE_ART_LABEL[f.art]}
                    </span>
                  </td>
                  <td className="px-4 py-2 align-top">
                    <span className="block">{m.namen.name(f.empfaengerId)}</span>
                    <span className="block text-xs text-muted">
                      {rollenText(m.rollen, f.empfaengerId) ?? ''}
                    </span>
                  </td>
                  <td className="px-4 py-2 align-top whitespace-nowrap">
                    <span className="block text-xs">{isoZeitText(f.angefordertAm)}</span>
                    <span className="block text-xs text-muted">
                      {m.namen.name(f.angefordertVon)}
                    </span>
                  </td>
                  <StatusZelle m={m} f={f} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="card-footer">
        Bestätigung per Token und E-Mail-Code; ohne Aussage zu elektronischen Signaturen.
      </div>
    </section>
  );
}

export function KenntnisnahmenKarte({ m }: { m: KommunikationModell }) {
  const kenntnisnahmen = m.h.freigaben.filter((f) => f.art === 'KENNTNISNAHME');
  return (
    <section className="card overflow-hidden" aria-labelledby="kommunikation-kenntnisnahmen">
      <div className="card-header">
        <h3 id="kommunikation-kenntnisnahmen" className="text-sm font-semibold text-primary">
          Kenntnisnahmen
        </h3>
        <span className="text-xs text-muted">Anfordern folgt in Ausbaustufe B</span>
      </div>
      {kenntnisnahmen.length === 0 ? (
        <TcmsLeer icon={Send} text="Noch keine Kenntnisnahme angefordert." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Kenntnisnahmen</caption>
            <Kopfzeile spalten={['Person', 'Rolle', 'Dokument', 'Status']} />
            <tbody>
              {kenntnisnahmen.map((f) => (
                <tr key={f.id} className="border-t border-default">
                  <td className="px-4 py-2 align-top">{m.namen.name(f.empfaengerId)}</td>
                  <td className="px-4 py-2 align-top text-xs text-secondary">
                    {rollenText(m.rollen, f.empfaengerId) ?? '—'}
                  </td>
                  <td className="px-4 py-2 align-top">
                    <span className="block font-medium">{f.titel}</span>
                    <span className="block text-xs text-muted mt-1">
                      angefordert {isoDatumText(f.angefordertAm)} von{' '}
                      {m.namen.name(f.angefordertVon)}
                    </span>
                  </td>
                  <StatusZelle m={m} f={f} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="card-footer">
        Kenntnisnahmen haben keinen Freigabevorbehalt; sie werden mit Person und Zeitpunkt
        protokolliert.
      </div>
    </section>
  );
}

const ZIEL_STATUS = {
  FREIGEGEBEN: { label: 'freigegeben', badge: 'badge-green' },
  AUSSTEHEND: { label: 'ausstehend', badge: 'badge-yellow' },
  ENTWURF: { label: 'Entwurf', badge: 'badge-gray' },
} as const;

type Ziel = KontextAntwort['ziele'][number];

function zielUnterzeile(m: KommunikationModell, z: Ziel): string {
  if (z.freigabe === 'FREIGEGEBEN' && z.freigegebenAm) {
    return `${m.namen.name(z.freigegebenVon)} · ${isoZeitText(z.freigegebenAm)}`;
  }
  return z.freigabe === 'AUSSTEHEND' ? 'Freigabe angefordert' : 'Entwurf';
}

function zielStatus(z: Ziel): (typeof ZIEL_STATUS)[keyof typeof ZIEL_STATUS] {
  return z.freigabe === 'FREIGEGEBEN' || z.freigabe === 'AUSSTEHEND'
    ? ZIEL_STATUS[z.freigabe]
    : ZIEL_STATUS.ENTWURF;
}

function ZieleListe({ m }: { m: KommunikationModell }) {
  if (m.ctx.ziele.length === 0)
    return <p className="px-4 py-2 text-sm text-muted">Keine Ziele erfasst.</p>;
  return (
    <ul>
      {m.ctx.ziele.map((z) => (
        <li key={z.id} className="flex items-start gap-2 border-t border-default px-4 py-2">
          <span className="min-w-0 grow">
            <span className="block text-sm truncate" title={z.text}>
              {z.text}
            </span>
            <span className="block text-xs text-muted mt-1">{zielUnterzeile(m, z)}</span>
          </span>
          <span className={`shrink-0 ${zielStatus(z).badge}`}>{zielStatus(z).label}</span>
        </li>
      ))}
    </ul>
  );
}

function BeschreibungsListe({ m }: { m: KommunikationModell }) {
  const freigegeben = m.ctx.beschreibungen.filter(
    (b) => b.freigegebenAm !== null && b.freigegebenAm.slice(0, 10) <= m.ctx.stand,
  );
  if (freigegeben.length === 0) {
    return <p className="px-4 py-2 text-sm text-muted">Noch keine Version freigegeben.</p>;
  }
  return (
    <ul>
      {freigegeben
        .map((b, i) => ({ b, abgeloest: i < freigegeben.length - 1 }))
        .reverse()
        .map(({ b, abgeloest }) => (
          <li key={b.id} className="border-t border-default">
            <Link
              href={mitStand(m, `${m.basis}/beschreibung`)}
              className="flex items-start gap-2 px-4 py-2 hover:bg-surface-raised"
            >
              <span className="grow">
                <span className="block text-sm font-medium">Version {b.nummer}</span>
                <span className="block text-xs text-muted mt-1">
                  {m.namen.name(b.freigegebenVon)} · {isoZeitText(b.freigegebenAm)}
                </span>
              </span>
              <span className={`shrink-0 ${abgeloest ? 'badge-gray' : 'badge-green'}`}>
                {abgeloest ? 'abgelöst' : 'freigegeben'}
              </span>
            </Link>
          </li>
        ))}
    </ul>
  );
}

export function FreigabestaendeKarte({ m }: { m: KommunikationModell }) {
  return (
    <section className="card overflow-hidden" aria-labelledby="kommunikation-staende">
      <div className="card-header">
        <h3 id="kommunikation-staende" className="text-sm font-semibold text-primary">
          Freigabestände
        </h3>
      </div>
      <h4 className="px-4 py-2 text-xs font-semibold text-secondary bg-surface-raised">
        Compliance-Ziele
      </h4>
      <ZieleListe m={m} />
      <h4 className="px-4 py-2 text-xs font-semibold text-secondary bg-surface-raised">
        CMS-Beschreibung
      </h4>
      <BeschreibungsListe m={m} />
    </section>
  );
}

type Kontrolle = KontextAntwort['kontrollen'][number];

function designText(m: KommunikationModell, k: Kontrolle): string {
  if (k.design === 'ANGEMESSEN' && k.designAm) {
    return `Designbeurteilung: angemessen · ${m.namen.name(k.designVon)} · ${isoDatumText(k.designAm)}`;
  }
  return k.design === 'MANGEL' ? 'Designbeurteilung: Mangel' : 'Designbeurteilung: nicht beurteilt';
}

function KenntnisnahmeKontrolle({ m }: { m: KommunikationModell }) {
  const k22 = m.ctx.kontrollen.find((k) => k.code === 'K-EC-22') ?? null;
  if (!k22) {
    return (
      <span className="text-sm text-muted">
        Die Kenntnisnahme-Kontrolle K-EC-22 ist nicht eingerichtet.
      </span>
    );
  }
  return (
    <span className="grow">
      <Link
        href={mitStand(m, `${m.basis}/kontrollen`)}
        className="block text-sm font-medium underline"
      >
        K-EC-22 · {k22.titel}
      </Link>
      <span className="block text-xs text-muted mt-1">
        {frequenzLabel(k22.frequenz)} · {designText(m, k22)}
      </span>
      {k22.letzte ? (
        <span className="flex items-center gap-1.5 mt-1 text-xs text-muted">
          Letzte: {k22.letzte.periodeLabel} <AnzeigeBadge status={k22.letzte.anzeige} />
        </span>
      ) : null}
    </span>
  );
}

export function KulturKarte({ m }: { m: KommunikationModell }) {
  const portalMeldungen = m.ctx.ereignisse.filter((e) => e.quelle === 'PORTAL').length;
  const meldeberechtigt = ansprechpersonen(m.rollen, m.namen);
  return (
    <section className="card overflow-hidden" aria-labelledby="kommunikation-kultur">
      <div className="card-header">
        <h3 id="kommunikation-kultur" className="text-sm font-semibold text-primary">
          Kultur und Meldewege
        </h3>
      </div>
      <ul>
        <li className="flex items-start gap-3 px-4 py-3">
          <span className="kpi-chip chip-brand shrink-0" aria-hidden="true">
            <Landmark className="h-4 w-4" />
          </span>
          <KenntnisnahmeKontrolle m={m} />
        </li>
        <li className="flex items-start gap-3 border-t border-default px-4 py-3">
          <span className="kpi-chip chip-amber shrink-0" aria-hidden="true">
            <Bell className="h-4 w-4" />
          </span>
          <span className="grow">
            <span className="block text-sm font-medium">Ereignismeldung im Portal</span>
            <span className="block text-xs text-muted mt-1">
              Tax-CMS → Ereignis melden · {portalMeldungen} Meldungen aus dem Portal bisher
            </span>
            <span className="block text-xs text-muted mt-1">
              Meldeberechtigt:{' '}
              {meldeberechtigt.length
                ? meldeberechtigt.map((x) => `${x.name} (${x.rolle})`).join(', ')
                : '—'}
            </span>
          </span>
        </li>
        <li className="flex items-start gap-3 border-t border-default px-4 py-3">
          <span className="kpi-chip chip-gray shrink-0" aria-hidden="true">
            <Library className="h-4 w-4" />
          </span>
          <span className="grow">
            <span className="block text-sm font-medium text-secondary">
              Steuerrichtlinie, Arbeitsanweisungen, Schulungen
            </span>
            <span className="block text-xs text-muted mt-1">
              Versionierte Richtlinien mit Schulungsnachweisen folgen in Ausbaustufe B.
            </span>
          </span>
        </li>
      </ul>
    </section>
  );
}
