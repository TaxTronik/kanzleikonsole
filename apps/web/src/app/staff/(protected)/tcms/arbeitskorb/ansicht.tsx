// =============================================================================
// Darstellung des Arbeitskorbs (TCMS Stufe 3, Bereich C). Reine Anzeige der
// Antwort von `arbeitskorbLesen`; Mandantennamen und Personen aus der
// kanzleikonsole. Vertrauliche Feststellungen erscheinen ohne Titel
// (FeststellungBezeichnung). Links führen in den jeweiligen Bereich des
// Mandanten; dort entscheidet der Dienst erneut.
// =============================================================================

import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  AlarmClock,
  Ban,
  CalendarClock,
  CheckCheck,
  FileCheck,
  FileText,
  Flame,
  Inbox,
  KeyRound,
  ListChecks,
  Paperclip,
  Pencil,
  SquareCheckBig,
  UserCheck,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { ArbeitskorbAntwortSchema } from '@taxtronik/tcms-contract';
import {
  AUSWIRKUNG_BADGE,
  AUSWIRKUNG_LABEL,
  EREIGNIS_QUELLE_LABEL,
  ereignistyp,
  relativTage,
} from '@taxtronik/tcms-domain';
import type { z } from 'zod';
import { AnzeigeBadge, KlasseBadge, VertraulichBadge } from '@/components/tcms/badges';
import { FeststellungBezeichnung } from '@/components/tcms/feststellung';
import { isoDatumText, isoZeitText } from '@/components/tcms/format';
import { KatalogIcon } from '@/components/tcms/icon';
import { TcmsLeer } from '@/components/tcms/leer';
import { badgeKlasse, tonChip } from '@/components/tcms/ton';
import type { TcmsNamen } from '@/server/tcms/namen';
import type { PortfolioMandant } from '@/server/tcms/portfolio';
import { TcmsText } from '@/components/tcms/text';

type Korb = z.output<typeof ArbeitskorbAntwortSchema>;
type VierAugenArt = Korb['vierAugen'][number]['art'];

const VIER_AUGEN: Readonly<Record<VierAugenArt, { label: string; icon: LucideIcon }>> = {
  UEBERSTEUERUNG: { label: 'Übersteuerung', icon: Pencil },
  FREQUENZ: { label: 'Frequenzabweichung', icon: CalendarClock },
  VERWERFEN: { label: 'Verwerfen', icon: Ban },
  RISIKOFREIGABE: { label: 'Inventarfreigabe', icon: UserCheck },
};

const basis = (mandantId: string) => `/staff/clients/${encodeURIComponent(mandantId)}/tcms`;

/** Ziel eines Vier-Augen-Antrags im Bereich des Mandanten (wie die Demo). */
function vierAugenHref(v: Korb['vierAugen'][number]): string {
  const b = basis(v.mandant.id);
  const objekt = v.objektId ? encodeURIComponent(v.objektId) : '';
  switch (v.art) {
    case 'UEBERSTEUERUNG':
      return objekt ? `${b}/risiken?risiko=${objekt}` : `${b}/risiken`;
    case 'FREQUENZ':
      return objekt ? `${b}/kontrollen?kontrolle=${objekt}` : `${b}/kontrollen`;
    case 'VERWERFEN':
      return objekt ? `${b}/feststellungen/${objekt}` : `${b}/feststellungen`;
    case 'RISIKOFREIGABE':
      return `${b}/risiken`;
  }
}

function Kennzahl({
  icon: Icon,
  ton,
  wert,
  label,
  href,
}: {
  icon: LucideIcon;
  ton: 'chip-brand' | 'chip-red' | 'chip-amber' | 'chip-gray';
  wert: number;
  label: string;
  href: string;
}) {
  return (
    <li>
      <a href={href} className="card p-3 flex items-center gap-3 hover:bg-surface-raised">
        <span className={`kpi-chip ${ton}`}>
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
        <span>
          <span className="block text-2xl font-bold text-primary">{wert}</span>
          <span className="block text-xs text-muted">{label}</span>
        </span>
      </a>
    </li>
  );
}

function Gruppe({
  id,
  icon: Icon,
  titel,
  anzahl,
  ton,
  fuss,
  children,
}: {
  id: string;
  icon: LucideIcon;
  titel: string;
  anzahl: number;
  ton: string;
  fuss: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="card overflow-hidden" aria-labelledby={`${id}-titel`}>
      <div className="card-header">
        <span className="inline-flex items-center gap-2">
          <Icon className="h-4 w-4 text-muted" aria-hidden="true" />
          <h2 id={`${id}-titel`} className="text-sm font-semibold text-primary">
            {titel}
          </h2>
        </span>
        <span className={anzahl > 0 ? ton : 'badge-gray'}>{anzahl}</span>
      </div>
      {children}
      <div className="card-footer">
        <span>{fuss}</span>
      </div>
    </section>
  );
}

function Zeile({ href, children }: { href: string; children: ReactNode }) {
  return (
    <li className="border-b border-default last:border-b-0">
      <Link href={href} className="flex items-start gap-3 px-6 py-3 hover:bg-surface-raised">
        {children}
      </Link>
    </li>
  );
}

/** Ungeklärte Anlagen aus Portal-Meldungen je Mandant (kk-tcms-s10nach, kanzleikonsole). */
export interface UngeklaerteJeMandant {
  mandantId: string;
  anzahl: number;
  /** ISO-Zeitpunkt der ältesten Anlage. */
  seit: string;
}

export function ArbeitskorbAnsicht({
  korb,
  mandanten,
  namen,
  nutzerId,
  berufstraeger,
  ungeklaert = [],
}: {
  korb: Korb;
  mandanten: readonly PortfolioMandant[];
  namen: TcmsNamen;
  nutzerId: string;
  /** Die Person ist bei mindestens einem Mandanten Berufsträger (Anzeige der Hinweise). */
  berufstraeger: boolean;
  /** Ungeklärte Anlagen aus Portal-Meldungen der zugänglichen Mandanten. */
  ungeklaert?: readonly UngeklaerteJeMandant[];
}) {
  const mandantJe = new Map(mandanten.map((m) => [m.id.toLowerCase(), m]));
  const mandant = (id: string) => mandantJe.get(id.toLowerCase())?.name ?? 'Unbekannter Mandant';
  const ueberfaellig = korb.durchfuehrungen.filter((d) => d.anzeige === 'UEBERFAELLIG').length;
  const gesamt =
    korb.durchfuehrungen.length +
    korb.gegenzeichnungen.length +
    korb.vierAugen.length +
    korb.p153.length +
    korb.ereignisse.length +
    korb.beschreibungen.length;
  const p153Bt = [
    ...new Set(
      korb.p153BeiAnderen.mandantIds.flatMap(
        (id) => mandantJe.get(id.toLowerCase())?.berufstraeger ?? [],
      ),
    ),
  ];
  return (
    <div className="p-8">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-primary">Arbeitskorb</h1>
          <p className="text-sm text-muted mt-1">
            Offene Tax-CMS-Aufgaben von {namen.name(nutzerId)} über alle Mandanten · Stand{' '}
            {isoDatumText(korb.heute)}
          </p>
        </div>
        <span className={gesamt ? 'badge-brand' : 'badge-green'}>
          {gesamt ? `${gesamt} offene Aufgaben` : 'nichts offen'}
        </span>
      </div>

      <ul className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <Kennzahl
          icon={AlarmClock}
          ton={ueberfaellig ? 'chip-red' : 'chip-gray'}
          wert={ueberfaellig}
          label="Durchführungen überfällig"
          href="#durchfuehrungen"
        />
        <Kennzahl
          icon={ListChecks}
          ton={korb.durchfuehrungen.length - ueberfaellig ? 'chip-brand' : 'chip-gray'}
          wert={korb.durchfuehrungen.length - ueberfaellig}
          label="fällig oder demnächst"
          href="#durchfuehrungen"
        />
        <Kennzahl
          icon={UserCheck}
          ton={korb.gegenzeichnungen.length ? 'chip-brand' : 'chip-gray'}
          wert={korb.gegenzeichnungen.length}
          label="Gegenzeichnungen"
          href="#gegenzeichnungen"
        />
        <Kennzahl
          icon={Users}
          ton={korb.vierAugen.length ? 'chip-amber' : 'chip-gray'}
          wert={korb.vierAugen.length}
          label="Vier-Augen-Bestätigungen"
          href="#vier-augen"
        />
        <Kennzahl
          icon={Flame}
          ton={korb.p153.length ? 'chip-red' : 'chip-gray'}
          wert={korb.p153.length}
          label="§-153-Würdigungen"
          href="#p153"
        />
        <Kennzahl
          icon={Inbox}
          ton={korb.ereignisse.length ? 'chip-amber' : 'chip-gray'}
          wert={korb.ereignisse.length}
          label="neue Ereignisse"
          href="#ereignisse"
        />
      </ul>

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-12">
        <div className="xl:col-span-7">
          <Durchfuehrungen korb={korb} mandant={mandant} ueberfaellig={ueberfaellig} />
        </div>
        <div className="xl:col-span-5">
          <Gegenzeichnungen korb={korb} mandant={mandant} namen={namen} />
        </div>
        <div className="xl:col-span-6">
          <P153 korb={korb} mandant={mandant} berufstraeger={berufstraeger} p153Bt={p153Bt} />
        </div>
        <div className="xl:col-span-6">
          <VierAugen korb={korb} mandant={mandant} namen={namen} />
        </div>
        <div className="xl:col-span-6">
          <Ereignisse korb={korb} mandant={mandant} namen={namen} />
        </div>
        <div className="xl:col-span-6">
          <Beschreibungen korb={korb} mandant={mandant} namen={namen} />
        </div>
        {ungeklaert.length ? (
          <div className="xl:col-span-12">
            <UngeklaerteAnlagenGruppe ungeklaert={ungeklaert} mandant={mandant} />
          </div>
        ) : null}
      </div>

      <p className="text-[11px] text-muted mt-6">
        Der Arbeitskorb zeigt nur eigene Aufgaben: zugewiesene Durchführungen und Gegenzeichnungen
        sowie Aufgaben aus {korb.mandantenZustaendig}{' '}
        {korb.mandantenZustaendig === 1 ? 'Mandat' : 'Mandaten'} mit Tax-CMS, in denen Sie
        Berufsträger oder Bearbeitung sind. Rechte werden beim Ausführen im jeweiligen Bereich
        erneut geprüft.
      </p>
    </div>
  );
}

type Teil = { korb: Korb; mandant: (id: string) => string };

function Durchfuehrungen({ korb, mandant, ueberfaellig }: Teil & { ueberfaellig: number }) {
  return (
    <Gruppe
      id="durchfuehrungen"
      icon={SquareCheckBig}
      titel="Durchführungen"
      anzahl={korb.durchfuehrungen.length}
      ton={ueberfaellig ? 'badge-red' : 'badge-brand'}
      fuss="Eigene Durchführungen: Fälligkeitsfenster offen, überfällig oder in den nächsten 14 Tagen fällig."
    >
      {korb.durchfuehrungen.length === 0 ? (
        <TcmsLeer
          icon={CheckCheck}
          text="Keine fälligen oder überfälligen Durchführungen in Ihrer Verantwortung."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th scope="col" className="th px-4">
                  Kontrolle
                </th>
                <th scope="col" className="th px-4">
                  Fälligkeit
                </th>
                <th scope="col" className="th px-4">
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {korb.durchfuehrungen.map((d) => (
                <tr key={d.id} className="border-t border-default align-top">
                  <th scope="row" className="px-4 py-2.5 text-left font-normal">
                    <Link
                      href={`${basis(d.mandant.id)}/durchfuehrungen/${encodeURIComponent(d.id)}`}
                      className="font-medium text-primary hover:underline"
                    >
                      {d.code} · <TcmsText>{d.titel}</TcmsText>
                    </Link>
                    {d.schluessel ? (
                      <span className="ml-1.5 inline-flex text-muted" title="Schlüsselkontrolle">
                        <KeyRound className="h-3 w-3" aria-hidden="true" />
                        <span className="sr-only">Schlüsselkontrolle</span>
                      </span>
                    ) : null}
                    <div className="text-[11px] text-muted mt-1">
                      {mandant(d.mandant.id)} · <TcmsText>{d.periode}</TcmsText> · Nachweise{' '}
                      {d.nachweise}/{d.mindestNachweise}
                    </div>
                  </th>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <span className="font-mono">{isoDatumText(d.faelligAm)}</span>
                    <div
                      className={`text-[11px] mt-1 ${d.tage < 0 ? 'text-red-700' : 'text-muted'}`}
                    >
                      {relativTage(d.tage)}
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    {d.anzeige === 'GEPLANT' ? (
                      <span className="badge-gray">demnächst fällig</span>
                    ) : (
                      <AnzeigeBadge status={d.anzeige} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Gruppe>
  );
}

function Gegenzeichnungen({ korb, mandant, namen }: Teil & { namen: TcmsNamen }) {
  return (
    <Gruppe
      id="gegenzeichnungen"
      icon={UserCheck}
      titel="Gegenzeichnungen"
      anzahl={korb.gegenzeichnungen.length}
      ton="badge-purple"
      fuss="Eigene Durchführungen erscheinen hier nicht (Vier-Augen-Prinzip)."
    >
      {korb.gegenzeichnungen.length === 0 ? (
        <TcmsLeer
          icon={CheckCheck}
          text="Keine eingereichten Durchführungen warten auf Ihre Gegenzeichnung."
        />
      ) : (
        <ul>
          {korb.gegenzeichnungen.map((g) => (
            <Zeile
              key={g.id}
              href={`${basis(g.mandant.id)}/durchfuehrungen/${encodeURIComponent(g.id)}`}
            >
              <span className="kpi-chip chip-brand">
                <FileCheck className="h-3.5 w-3.5" aria-hidden="true" />
              </span>
              <span className="grow">
                <span className="block text-sm font-medium text-primary">
                  {g.code} · <TcmsText>{g.titel}</TcmsText>
                </span>
                <span className="block text-[11px] text-muted mt-1">
                  {mandant(g.mandant.id)} · <TcmsText>{g.periode}</TcmsText>
                </span>
                <span className="block text-[11px] text-muted">
                  Durchgeführt von {namen.name(g.durchgefuehrtVon)}
                  {g.eingereichtAm ? ` · eingereicht ${isoZeitText(g.eingereichtAm)}` : ''} ·
                  Nachweise {g.nachweise}/{g.mindestNachweise}
                </span>
              </span>
              {g.schluessel ? (
                <span className="badge-brand shrink-0 gap-1">
                  <KeyRound className="h-3 w-3" aria-hidden="true" /> Schlüssel
                </span>
              ) : null}
            </Zeile>
          ))}
        </ul>
      )}
    </Gruppe>
  );
}

function P153({
  korb,
  mandant,
  berufstraeger,
  p153Bt,
}: Teil & { berufstraeger: boolean; p153Bt: readonly string[] }) {
  let inhalt: ReactNode;
  if (korb.p153.length > 0) {
    inhalt = (
      <ul>
        {korb.p153.map((f) => (
          <Zeile
            key={f.id}
            href={`${basis(f.mandant.id)}/feststellungen/${encodeURIComponent(f.id)}`}
          >
            <span className="kpi-chip chip-red">
              <Flame className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
            <span className="grow">
              <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-primary">
                <FeststellungBezeichnung
                  f={
                    f.vertraulich
                      ? { maskiert: true, nummer: f.nummer }
                      : { maskiert: false, nummer: f.nummer, titel: f.titel }
                  }
                />
                {f.vertraulich ? <VertraulichBadge /> : null}
              </span>
              <span className="block text-[11px] text-muted mt-1">
                {mandant(f.mandant.id)} · erfasst {isoDatumText(f.erfasstAm)}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-1.5">
              <span
                className={badgeKlasse(AUSWIRKUNG_BADGE[f.auswirkung])}
                title="Steuerliche Auswirkung"
              >
                Auswirkung {AUSWIRKUNG_LABEL[f.auswirkung]}
              </span>
              <KlasseBadge klasse={f.schwere} />
            </span>
          </Zeile>
        ))}
      </ul>
    );
  } else if (!berufstraeger && korb.p153BeiAnderen.anzahl > 0) {
    inhalt = (
      <div className="px-6 py-4">
        <p className="alert-info" role="note">
          In Ihren Mandaten{' '}
          {korb.p153BeiAnderen.anzahl === 1
            ? 'ist eine §-153-Würdigung'
            : `sind ${korb.p153BeiAnderen.anzahl} §-153-Würdigungen`}{' '}
          offen. Die Würdigung entscheidet ausschließlich der zuständige Berufsträger
          {p153Bt.length ? ` (${p153Bt.join(', ')})` : ''}.
        </p>
      </div>
    );
  } else {
    inhalt = (
      <TcmsLeer
        icon={CheckCheck}
        text={
          berufstraeger
            ? 'Keine offenen §-153-Würdigungen in Ihren Mandaten.'
            : '§-153-Würdigungen entscheiden ausschließlich Berufsträger; in Ihren Mandaten ist keine offen.'
        }
      />
    );
  }
  return (
    <Gruppe
      id="p153"
      icon={Flame}
      titel="§-153-Würdigungen"
      anzahl={korb.p153.length}
      ton="badge-red"
      fuss="Vier gleichrangige Optionen ohne Vorauswahl; Entscheidung höchstpersönlich durch den Berufsträger."
    >
      {inhalt}
    </Gruppe>
  );
}

function VierAugen({ korb, mandant, namen }: Teil & { namen: TcmsNamen }) {
  return (
    <Gruppe
      id="vier-augen"
      icon={Users}
      titel="Vier-Augen-Bestätigungen"
      anzahl={korb.vierAugen.length}
      ton="badge-yellow"
      fuss="Übersteuerungen, Frequenzabweichungen, Verwerfen und Inventarfreigaben bestätigt eine zweite Person."
    >
      {korb.vierAugen.length === 0 ? (
        <TcmsLeer icon={CheckCheck} text="Keine Anträge warten auf Sie als zweite Person." />
      ) : (
        <ul>
          {korb.vierAugen.map((v) => {
            const art = VIER_AUGEN[v.art];
            return (
              <Zeile key={v.key} href={vierAugenHref(v)}>
                <span className="kpi-chip chip-amber">
                  <art.icon className="h-3.5 w-3.5" aria-hidden="true" />
                </span>
                <span className="grow min-w-0">
                  <span className="block text-sm font-medium text-primary">
                    <TcmsText>{v.titel}</TcmsText>
                  </span>
                  <span className="block text-[11px] text-muted mt-1">
                    {mandant(v.mandant.id)} · <TcmsText>{v.detail}</TcmsText>
                  </span>
                  {v.begruendung ? (
                    <span
                      className="block truncate text-[11px] text-secondary mt-1"
                      title={v.begruendung}
                    >
                      „<TcmsText>{v.begruendung}</TcmsText>“
                    </span>
                  ) : null}
                  <span className="block text-[11px] text-muted">
                    Beantragt von{' '}
                    {v.beantragtVon.length
                      ? v.beantragtVon.map((id) => namen.name(id)).join(', ')
                      : '—'}
                    {v.beantragtAm ? ` · ${isoZeitText(v.beantragtAm)}` : ''}
                  </span>
                </span>
                <span className="badge-gray shrink-0">
                  <TcmsText>{art.label}</TcmsText>
                </span>
              </Zeile>
            );
          })}
        </ul>
      )}
    </Gruppe>
  );
}

function Ereignisse({ korb, mandant, namen }: Teil & { namen: TcmsNamen }) {
  return (
    <Gruppe
      id="ereignisse"
      icon={Inbox}
      titel="Neue Ereignisse"
      anzahl={korb.ereignisse.length}
      ton="badge-yellow"
      fuss="Jedes Ereignis wird triagiert; Verwerfen braucht eine Begründung."
    >
      {korb.ereignisse.length === 0 ? (
        <TcmsLeer icon={Inbox} text="Keine ungetriagierten Ereignisse in Ihren Mandaten." />
      ) : (
        <ul>
          {korb.ereignisse.map((e) => {
            const typ = ereignistyp(e.typ);
            return (
              <Zeile
                key={e.id}
                href={`${basis(e.mandant.id)}/ereignisse?e=${encodeURIComponent(e.id)}`}
              >
                <span className={`kpi-chip ${tonChip(typ?.ton)}`}>
                  <KatalogIcon name={typ?.icon ?? 'Bell'} className="h-3.5 w-3.5" />
                </span>
                <span className="grow">
                  <span className="block text-sm font-medium text-primary">
                    {e.typ} · <TcmsText>{e.titel}</TcmsText>
                  </span>
                  <span className="block text-[11px] text-muted mt-1">
                    {mandant(e.mandant.id)} · {EREIGNIS_QUELLE_LABEL[e.quelle]} ·{' '}
                    {namen.name(e.gemeldetVon)} · {isoDatumText(e.gemeldetAm)}
                  </span>
                </span>
                <span className="badge-brand shrink-0">neu</span>
              </Zeile>
            );
          })}
        </ul>
      )}
    </Gruppe>
  );
}

/**
 * Ungeklärte Anlagen aus Portal-Meldungen (kk-tcms-s10nach): Daten der
 * kanzleikonsole, nicht des Dienstes. Sie bleiben gebunden, bis jemand sie im
 * Ereigniseingang des Mandanten klärt.
 */
function UngeklaerteAnlagenGruppe({
  ungeklaert,
  mandant,
}: {
  ungeklaert: readonly UngeklaerteJeMandant[];
  mandant: (id: string) => string;
}) {
  const gesamt = ungeklaert.reduce((summe, u) => summe + u.anzahl, 0);
  return (
    <Gruppe
      id="ungeklaerte-anlagen"
      icon={Paperclip}
      titel="Ungeklärte Anlagen aus Portal-Meldungen"
      anzahl={gesamt}
      ton="badge-yellow"
      fuss="Das Tax-CMS hat die Meldung nicht innerhalb von 23 Stunden bestätigt; die Dokumente bleiben gesperrt, bis die Anlage im Ereigniseingang zugeordnet oder freigegeben ist."
    >
      <ul>
        {ungeklaert.map((u) => (
          <Zeile key={u.mandantId} href={`${basis(u.mandantId)}/ereignisse`}>
            <span className="kpi-chip chip-amber">
              <Paperclip className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
            <span className="grow">
              <span className="block text-sm font-medium text-primary">{mandant(u.mandantId)}</span>
              <span className="block text-[11px] text-muted mt-1">
                {u.anzahl} {u.anzahl === 1 ? 'Anlage' : 'Anlagen'} · seit {isoDatumText(u.seit)}
              </span>
            </span>
            <span className="badge-yellow shrink-0">ungeklärt</span>
          </Zeile>
        ))}
      </ul>
    </Gruppe>
  );
}

function Beschreibungen({ korb, mandant, namen }: Teil & { namen: TcmsNamen }) {
  return (
    <Gruppe
      id="beschreibungen"
      icon={FileText}
      titel="CMS-Beschreibungen im Kanzlei-Review"
      anzahl={korb.beschreibungen.length}
      ton="badge-brand"
      fuss="Review vor der Freigabe beim Mandanten."
    >
      {korb.beschreibungen.length === 0 ? (
        <TcmsLeer icon={FileCheck} text="Keine Beschreibungsversion wartet auf Ihr Review." />
      ) : (
        <ul>
          {korb.beschreibungen.map((b) => (
            <Zeile key={b.id} href={`${basis(b.mandant.id)}/beschreibung`}>
              <span className="kpi-chip chip-brand">
                <FileText className="h-3.5 w-3.5" aria-hidden="true" />
              </span>
              <span className="grow">
                <span className="block text-sm font-medium text-primary">
                  CMS-Beschreibung v{b.nummer}
                </span>
                <span className="block text-[11px] text-muted mt-1">
                  {mandant(b.mandant.id)} · Review angefordert von {namen.name(b.angefordertVon)}
                  {b.angefordertAm ? ` · ${isoZeitText(b.angefordertAm)}` : ''}
                </span>
              </span>
              <span className="badge-brand shrink-0">Kanzlei-Review</span>
            </Zeile>
          ))}
        </ul>
      )}
    </Gruppe>
  );
}
