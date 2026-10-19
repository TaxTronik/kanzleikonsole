// =============================================================================
// /staff/tcms — Tax-CMS-Portfolio der Kanzlei (TCMS Stufe 3, portiert aus der
// Demo staff/tcms/page.tsx).
//
// Kennzahlen je Mandant liefert der Dienst (`POST /v1/portfolio` mit der
// bestätigten Mandantenliste der Seite, ADR 0001 §3.3); Namen und
// Berufsträger:innen kommen aus der kanzleikonsole. Mandanten der Liste ohne
// Anker im TCMS erscheinen als „nicht im Tax-CMS angelegt“. Filter laufen per
// GET (Lesezeichen möglich) und wählen nur aus – sie berechnen nichts neu.
// Links zum Arbeitskorb (alle) und zum Katalog (nur Admin/Partner, wie die
// Katalogseite selbst; Integration Stufe 3).
// =============================================================================

import Link from 'next/link';
import {
  AlarmClock,
  BookOpen,
  CalendarRange,
  Flame,
  Inbox,
  LayoutGrid,
  ListChecks,
  Search,
  ShieldCheck,
} from 'lucide-react';
import { ENDPUNKTE, type PortfolioAntwort } from '@taxtronik/tcms-contract';
import { ANZEIGE_LABEL, KLASSE_LABEL, PHASEN } from '@taxtronik/tcms-domain';
import { isoDatumKurzText, isoDatumText } from '@/components/tcms/format';
import { TcmsLeer } from '@/components/tcms/leer';
import { Fortschritt, MiniSteps, PHASEN_KURZ } from '@/components/tcms/visual';
import { TcmsZustand } from '@/components/tcms/zustand';
import { isStaffAdmin } from '@/server/auth/rbac';
import { portfolioMandanten, type PortfolioMandant } from '@/server/tcms/portfolio';
import { tcmsKanzleiSeite, tcmsLesen } from '@/server/tcms/seite';

export const metadata = { title: 'Tax-CMS' };

type Zeile = PortfolioAntwort['zeilen'][number];
type SP = Record<string, string | string[] | undefined>;

const eins = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

interface Filter {
  q: string;
  phase: string;
  ueberfaellig: boolean;
  handlung: boolean;
  zustaendig: boolean;
}

function filterAus(sp: SP): Filter {
  const phase = eins(sp['phase']);
  return {
    q: eins(sp['q']).trim().slice(0, 100),
    phase: /^[1-7]$/.test(phase) || phase === 'ohne' ? phase : '',
    ueberfaellig: eins(sp['ueberfaellig']) === '1',
    handlung: eins(sp['handlung']) === '1',
    zustaendig: eins(sp['zustaendig']) === '1',
  };
}

function passt(m: PortfolioMandant, z: Zeile | undefined, f: Filter): boolean {
  if (f.q && !m.name.toLocaleLowerCase('de').includes(f.q.toLocaleLowerCase('de'))) return false;
  if (f.zustaendig && !m.zustaendig) return false;
  const mitProgramm = z?.hatProgramm === true;
  if (f.phase === 'ohne' && mitProgramm) return false;
  if (f.phase && f.phase !== 'ohne' && (!mitProgramm || String(z!.phase) !== f.phase)) return false;
  if (f.ueberfaellig && !(z && z.ueberfaellig > 0)) return false;
  if (f.handlung && !z?.handlungsbedarf) return false;
  return true;
}

export default async function TcmsPortfolioPage({ searchParams }: { searchParams: Promise<SP> }) {
  const seite = await tcmsKanzleiSeite();
  if (!seite.ok) return <TcmsZustand zustand={seite.zustand} />;
  const filter = filterAus(await searchParams);

  const portfolio = await tcmsLesen(seite, ENDPUNKTE.portfolioLesen);
  if (!portfolio.ok) return <TcmsZustand zustand={portfolio.zustand} />;
  const mandanten = await portfolioMandanten(seite);

  // Reihenfolge des Dienstes (Handlungsbedarf zuerst), danach Mandanten ohne Anker.
  const zeileJe = new Map(portfolio.daten.zeilen.map((z) => [z.mandant.id.toLowerCase(), z]));
  const mandantJe = new Map(mandanten.map((m) => [m.id.toLowerCase(), m]));
  const geordnet: Array<{ m: PortfolioMandant; z: Zeile | undefined }> = [
    ...portfolio.daten.zeilen.flatMap((z) => {
      const m = mandantJe.get(z.mandant.id.toLowerCase());
      return m ? [{ m, z }] : [];
    }),
    ...mandanten.filter((m) => !zeileJe.has(m.id.toLowerCase())).map((m) => ({ m, z: undefined })),
  ];
  const sichtbar = geordnet.filter(({ m, z }) => passt(m, z, filter));
  const mitProgramm = portfolio.daten.zeilen.filter((z) => z.hatProgramm);
  const summe = (feld: (z: Zeile) => number) => mitProgramm.reduce((s, z) => s + feld(z), 0);
  const filterAktiv = Boolean(
    filter.q || filter.phase || filter.ueberfaellig || filter.handlung || filter.zustaendig,
  );

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold text-primary">Tax-CMS</h1>
      <p className="text-sm text-muted mb-3">Compliance-Programme der Mandanten im Überblick</p>
      <nav aria-label="Tax-CMS-Arbeitsbereiche" className="flex flex-wrap gap-2 mb-6">
        <Link href="/staff/tcms/arbeitskorb" className="btn-secondary text-xs py-1">
          <ListChecks className="h-3.5 w-3.5" aria-hidden="true" /> Mein Arbeitskorb
        </Link>
        {isStaffAdmin(seite.session) ? (
          <Link href="/staff/tcms/katalog" className="btn-secondary text-xs py-1">
            <BookOpen className="h-3.5 w-3.5" aria-hidden="true" /> Katalog
          </Link>
        ) : null}
      </nav>

      <ul className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-3 mb-4">
        <Kennzahl
          icon={LayoutGrid}
          ton="chip-brand"
          wert={mitProgramm.length}
          label="Mandanten mit Tax-CMS"
          href="/staff/tcms"
        />
        <Kennzahl
          icon={AlarmClock}
          ton={summe((z) => z.ueberfaellig) ? 'chip-red' : 'chip-gray'}
          wert={summe((z) => z.ueberfaellig)}
          label="Kontrollen überfällig"
          href="/staff/tcms?ueberfaellig=1"
        />
        <Kennzahl
          icon={Flame}
          ton={summe((z) => z.feststellungenHochOffen) ? 'chip-red' : 'chip-gray'}
          wert={summe((z) => z.feststellungenHochOffen)}
          label="Feststellungen hoch/kritisch offen"
          href="/staff/tcms?handlung=1"
        />
        <Kennzahl
          icon={Inbox}
          ton={summe((z) => z.ereignisseNeu) ? 'chip-amber' : 'chip-gray'}
          wert={summe((z) => z.ereignisseNeu)}
          label="Ereignisse nicht triagiert"
          href="/staff/tcms?handlung=1"
        />
        <Kennzahl
          icon={CalendarRange}
          ton="chip-gray"
          wert={mitProgramm.filter((z) => z.zeitraum.art === 'LAUFEND').length}
          label="Laufende Wirksamkeitszeiträume"
          href="/staff/tcms?phase=6"
        />
      </ul>

      <form
        method="get"
        action="/staff/tcms"
        className="card p-4 mb-4 flex flex-wrap items-end gap-4"
      >
        <div>
          <label className="label-sm" htmlFor="tcms-f-q">
            Suche
          </label>
          <input
            id="tcms-f-q"
            name="q"
            type="search"
            className="input w-56"
            placeholder="Mandant …"
            defaultValue={filter.q}
          />
        </div>
        <div>
          <label className="label-sm" htmlFor="tcms-f-phase">
            Phase
          </label>
          <select id="tcms-f-phase" name="phase" className="input w-64" defaultValue={filter.phase}>
            <option value="">Alle</option>
            {PHASEN_KURZ.map((p, i) => (
              <option key={p} value={String(i + 1)}>
                Phase {i + 1} · {p}
              </option>
            ))}
            <option value="ohne">ohne Tax-CMS</option>
          </select>
        </div>
        <fieldset className="flex flex-wrap gap-4 pb-2">
          <legend className="sr-only">Weitere Filter</legend>
          <label className="inline-flex items-center gap-1.5 text-sm">
            <input type="checkbox" name="zustaendig" value="1" defaultChecked={filter.zustaendig} />{' '}
            nur meine Mandate
          </label>
          <label className="inline-flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              name="ueberfaellig"
              value="1"
              defaultChecked={filter.ueberfaellig}
            />{' '}
            nur mit Überfälligem
          </label>
          <label className="inline-flex items-center gap-1.5 text-sm">
            <input type="checkbox" name="handlung" value="1" defaultChecked={filter.handlung} /> nur
            mit Handlungsbedarf
          </label>
        </fieldset>
        <div className="flex gap-2 ml-auto">
          {filterAktiv ? (
            <Link href="/staff/tcms" className="btn-secondary">
              Zurücksetzen
            </Link>
          ) : null}
          <button type="submit" className="btn-secondary">
            <Search className="h-4 w-4" aria-hidden="true" /> Anwenden
          </button>
        </div>
      </form>

      <div className="card overflow-hidden">
        {geordnet.length === 0 ? (
          <TcmsLeer icon={ShieldCheck} text="Ihnen ist noch kein Mandant zugänglich." />
        ) : sichtbar.length === 0 ? (
          <TcmsLeer icon={Search} text="Kein Mandant entspricht dem Filter.">
            <Link href="/staff/tcms" className="btn-secondary">
              Filter zurücksetzen
            </Link>
          </TcmsLeer>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Tax-CMS-Portfolio</caption>
              <thead>
                <tr>
                  <th className="th">Mandant</th>
                  <th className="th">Phase</th>
                  <th
                    className="th th-right"
                    title="Risiken, deren Nettoklasse über dem Risikoappetit liegt"
                  >
                    Über Appetit
                  </th>
                  <th className="th">Kontrollen fällig / überfällig</th>
                  <th className="th th-right">Feststellungen offen</th>
                  <th className="th th-right">Ereignisse neu</th>
                  <th className="th">Wirksamkeitszeitraum</th>
                  <th className="th">Nächster Termin</th>
                  <th className="th">Berufsträger:in</th>
                </tr>
              </thead>
              <tbody>
                {sichtbar.map(({ m, z }) => (
                  <PortfolioZeile key={m.id} m={m} z={z} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="card-footer">
          <span>Sortierung: zuerst Handlungsbedarf. Der Mandant öffnet das Cockpit.</span>
          <span>
            {sichtbar.length} von {geordnet.length} Mandanten · Stand{' '}
            {isoDatumText(portfolio.daten.heute)}
          </span>
        </div>
      </div>
      <p className="text-xs text-muted mt-4">
        Statusangaben sind Betriebsinformationen, keine Aussage über Angemessenheit oder
        Wirksamkeit.
      </p>
    </div>
  );
}

function Kennzahl({
  icon: Icon,
  ton,
  wert,
  label,
  href,
}: {
  icon: typeof LayoutGrid;
  ton: 'chip-brand' | 'chip-red' | 'chip-amber' | 'chip-gray';
  wert: number;
  label: string;
  href: string;
}) {
  return (
    <li>
      <Link href={href} className="card p-3 flex items-center gap-3 hover:bg-surface-raised">
        <span className={`kpi-chip ${ton}`}>
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
        <span>
          <span className="block text-2xl font-bold text-primary">{wert}</span>
          <span className="block text-xs text-muted">{label}</span>
        </span>
      </Link>
    </li>
  );
}

function OhneProgrammZeile({
  m,
  z,
  bt,
}: {
  m: PortfolioMandant;
  z: Zeile | undefined;
  bt: string;
}) {
  const zustand = !z
    ? 'nicht im Tax-CMS angelegt'
    : z.entwurf
      ? 'Einrichtung läuft'
      : 'kein Tax-CMS eingerichtet';
  return (
    <tr className="border-t border-default">
      <td className="px-6 py-3">
        <Link href={mandantHref(m)} className="font-medium text-primary hover:underline">
          {m.name}
        </Link>
        <span className="block text-xs text-muted">{zustand}</span>
      </td>
      <td className="px-6 py-3 text-muted" colSpan={7}>
        {!z
          ? 'Im Cockpit lässt sich der Mandant im Tax-CMS anlegen.'
          : 'Phase, Risiken und Kontrollen entstehen in der Einrichtung.'}
      </td>
      <td className="px-6 py-3 text-secondary">{bt}</td>
    </tr>
  );
}

function mandantHref(m: PortfolioMandant): string {
  return `/staff/clients/${encodeURIComponent(m.id)}/tcms`;
}

function PortfolioZeile({ m, z }: { m: PortfolioMandant; z: Zeile | undefined }) {
  const bt = m.berufstraeger.length ? m.berufstraeger.join(', ') : '–';
  if (!z || !z.hatProgramm) return <OhneProgrammZeile m={m} z={z} bt={bt} />;
  const href = mandantHref(m);
  return (
    <tr className="border-t border-default align-top">
      <td className="px-6 py-3">
        <Link href={href} className="font-medium text-primary hover:underline">
          {m.name}
        </Link>
        {z.paket ? (
          <span
            className="block text-xs text-muted"
            title={z.teilbereich ? `Teilbereich: ${z.teilbereich}` : undefined}
          >
            {z.paket}
          </span>
        ) : null}
      </td>
      <td className="px-6 py-3">
        <span
          className="inline-flex items-center gap-2"
          title={`Phase ${z.phase} von ${PHASEN.length}: ${z.phaseName}`}
        >
          <MiniSteps aktiv={z.phase} />
          <span className="text-xs text-muted">
            {z.phase}/{PHASEN.length}
          </span>
        </span>
      </td>
      <AppetitZelle z={z} href={href} />
      <FaelligZelle z={z} href={href} />
      <td className="px-6 py-3 text-right">
        {z.p153Offen > 0 ? (
          <Link
            href={`${href}/feststellungen`}
            className="badge-red mr-2"
            title={`${z.p153Offen} §-153-Würdigung(en) offen`}
          >
            §153
          </Link>
        ) : null}
        <span className={z.feststellungenOffen === 0 ? 'text-muted' : 'font-medium text-primary'}>
          {z.feststellungenOffen}
        </span>
      </td>
      <td className="px-6 py-3 text-right">
        {z.ereignisseNeu > 0 ? (
          <Link href={`${href}/ereignisse`} className="font-medium text-primary hover:underline">
            {z.ereignisseNeu}
          </Link>
        ) : (
          <span className="text-muted">0</span>
        )}
      </td>
      <ZeitraumZelle z={z} />
      <TerminZelle z={z} href={href} />
      <td className="px-6 py-3 text-secondary">{bt}</td>
    </tr>
  );
}

function AppetitZelle({ z, href }: { z: Zeile; href: string }) {
  return (
    <td
      className="px-6 py-3 text-right font-mono"
      title={`Risikoappetit ${z.appetit ? KLASSE_LABEL[z.appetit] : '–'} · ${z.risiken} aktive Risiken`}
    >
      {z.ueberAppetit > 0 ? (
        <Link
          href={`${href}/risiken?appetit=1`}
          className="text-red-700 font-semibold hover:underline"
        >
          {z.ueberAppetit}
        </Link>
      ) : z.risiken > 0 ? (
        '0'
      ) : (
        <span className="text-muted">–</span>
      )}
    </td>
  );
}

function FaelligZelle({ z, href }: { z: Zeile; href: string }) {
  return (
    <td className="px-6 py-3 whitespace-nowrap">
      {z.faellig === 0 && z.ueberfaellig === 0 ? (
        <span className="text-muted">nichts fällig</span>
      ) : (
        <>
          {z.faellig} fällig
          {z.ueberfaellig > 0 ? (
            <>
              {' · '}
              <Link href={`${href}/kontrollen`} className="text-red-700 hover:underline">
                {z.ueberfaellig} überfällig
              </Link>
            </>
          ) : null}
        </>
      )}
      {z.zurGegenzeichnung > 0 ? (
        <span className="block text-xs text-secondary">
          {z.zurGegenzeichnung} zur Gegenzeichnung
        </span>
      ) : null}
    </td>
  );
}

function ZeitraumZelle({ z }: { z: Zeile }) {
  const zr = z.zeitraum;
  return (
    <td className="px-6 py-3 min-w-[9rem]">
      {zr.art === 'LAUFEND' ? (
        <span className="block" title={`${isoDatumText(zr.ab)} – ${isoDatumText(zr.bis)}`}>
          <Fortschritt
            anteil={zr.monate > 0 ? zr.monat / zr.monate : 0}
            label={`Monat ${zr.monat} von ${zr.monate}`}
          />
          <span className="block text-xs text-muted mt-1">
            Monat {zr.monat} von {zr.monate}
          </span>
        </span>
      ) : zr.art === 'ABGESCHLOSSEN' ? (
        <span>
          {z.phase === 7 ? 'Regelbetrieb' : 'abgelaufen'} · {isoDatumKurzText(zr.ab)}–
          {isoDatumText(zr.bis)}
        </span>
      ) : zr.art === 'BEVORSTEHEND' ? (
        <span className="text-secondary">beginnt {isoDatumText(zr.ab)}</span>
      ) : (
        <span className="text-muted">noch nicht begonnen</span>
      )}
    </td>
  );
}

function TerminZelle({ z, href }: { z: Zeile; href: string }) {
  const t = z.naechsterTermin;
  return (
    <td className="px-6 py-3">
      {t ? (
        <Link
          href={`${href}/durchfuehrungen/${encodeURIComponent(t.durchfuehrungId)}`}
          className="hover:underline"
          title={`${t.code} · ${t.titel} · ${t.periode} · ${ANZEIGE_LABEL[t.anzeige]}`}
        >
          <span className="block font-mono">{isoDatumKurzText(t.datum)}</span>
          <span className="block text-xs text-muted">{t.code}</span>
        </Link>
      ) : (
        <span className="text-muted">–</span>
      )}
    </td>
  );
}
