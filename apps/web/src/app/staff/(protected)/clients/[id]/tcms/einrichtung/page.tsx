// =============================================================================
// /staff/clients/:id/tcms/einrichtung — Einrichtungsassistent des Tax-CMS
// (TCMS Stufe 3, Bereich A; portiert aus der Demo
// staff/clients/[id]/tcms/setup/page.tsx).
//
//   1. tcmsMandantSeite(id) zuerst (Zugriff, Modul, Dienst, Akteur).
//   2. Zuständigkeit und Kanzleipersonen aus der kanzleikonsole
//      (server/tcms/programm/zustaendigkeit.ts) – nur als Vorbelegung an den
//      Dienst, nie für Rechte.
//   3. `einrichtungLesen` liefert Entwurf, Plan (Risiken, Kontrollen,
//      Frequenzen, Prüflast) und offene Punkte je Schritt; 404 = Mandant noch
//      nicht im Tax-CMS. Die Demo rechnete den Plan selbst (berechnePlan) –
//      hier zeigt die Seite nur, was der Dienst berechnet hat.
//   4. Rollen der Mandantenseite (`kontakteLesen`) und Namen aus der
//      kanzleikonsole für Auswahllisten und Anzeige.
// =============================================================================

import Link from 'next/link';
import type { ReactNode } from 'react';
import { CheckCircle2, Lock, ShieldCheck } from 'lucide-react';
import { ENDPUNKTE, type EinrichtungView, type PlanView } from '@taxtronik/tcms-contract';
import {
  KATALOG_KONTROLLEN,
  KATALOG_RISIKEN,
  KLASSE_LABEL,
  KLASSE_RANG,
  PAKET,
  PROFIL_FRAGEN,
  TURNUS_LABEL,
  type Geschaeftsprofil,
} from '@taxtronik/tcms-domain';
import { isoDatumText, isoZeitText } from '@/components/tcms/format';
import { TcmsLeer } from '@/components/tcms/leer';
import {
  SCHRITTE,
  Schrittleiste,
  StufeOffen,
  StufeZu,
  Zusammenfassung,
  type ZusammenfassungDaten,
} from '@/components/tcms/programm/einrichtung';
import {
  aktiveRollen,
  ansprechpersonen,
  kontaktPersonen,
} from '@/components/tcms/programm/kontakte';
import { TcmsZustand } from '@/components/tcms/zustand';
import { isStaffAdmin } from '@/server/auth/rbac';
import { personIdsAus, type TcmsNamen } from '@/server/tcms/namen';
import { einrichtungLesenQuery } from '@/server/tcms/programm/einrichtung';
import {
  tcmsZustaendigkeitTx,
  type TcmsZustaendigkeit,
} from '@/server/tcms/programm/zustaendigkeit';
import {
  tcmsLesen,
  tcmsLesenOptional,
  tcmsMandantSeite,
  tcmsNamenLesen,
  tcmsTenantLesen,
  type TcmsMandantSeite,
} from '@/server/tcms/seite';
import { TCMS_KEIN_RECHT } from '@/server/tcms/zustand';
import {
  SchrittKontrollen,
  SchrittProfil,
  SchrittRisiken,
  SchrittTeilbereich,
  SchrittZiele,
  type KontrollGruppe,
} from './schritte';
import { TcmsText } from '@/components/tcms/text';

export const metadata = { title: 'Tax-CMS – Einrichtung' };

type Entwurf = NonNullable<EinrichtungView['entwurf']>;

const eins = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function Kopf({ children }: { children?: ReactNode }) {
  return (
    <div className="mb-4">
      <h2 id="tcms-einrichtung" className="text-lg font-semibold text-primary">
        Einrichtungsassistent
      </h2>
      {children}
    </div>
  );
}

function NichtImTcms({ seite }: { seite: TcmsMandantSeite }) {
  return (
    <section aria-labelledby="tcms-einrichtung">
      <Kopf />
      <div className="card">
        <TcmsLeer
          icon={ShieldCheck}
          text="Dieser Mandant ist im Tax-CMS noch nicht angelegt. Legen Sie ihn zuerst im Cockpit an; danach geht es hier weiter."
        >
          <Link className="btn-primary" href={seite.basis}>
            Zum Cockpit
          </Link>
        </TcmsLeer>
      </div>
    </section>
  );
}

function Eingerichtet({ seite, e }: { seite: TcmsMandantSeite; e: EinrichtungView }) {
  const v1 = e.programm?.version1Am;
  return (
    <section aria-labelledby="tcms-einrichtung">
      <Kopf />
      <div className="card">
        <TcmsLeer
          icon={CheckCircle2}
          text={`Das Tax-CMS ist eingerichtet${v1 ? ` – Version 1 vom ${isoZeitText(v1)}` : ''}. Änderungen erfolgen in den Bereichen Profil, Risiken und Kontrollen.`}
        >
          <Link className="btn-primary" href={seite.basis}>
            Zum Cockpit
          </Link>
          <Link className="btn-secondary" href={`${seite.basis}/profil`}>
            Geschäftsprofil
          </Link>
          <Link className="btn-secondary" href={`${seite.basis}/risiken`}>
            Risikoinventar
          </Link>
        </TcmsLeer>
      </div>
    </section>
  );
}

function kurzfassung(n: number, e: Entwurf, plan: PlanView, namen: TcmsNamen): ReactNode {
  const anzahl = (x: number, eins_: string, viele: string) => `${x} ${x === 1 ? eins_ : viele}`;
  switch (n) {
    case 1:
      return (
        <>
          <TcmsText>{e.teilbereich.name}</TcmsText>
          {` · Angemessenheit zum ${isoDatumText(plan.zeitraum?.stichtag)} · Wirksamkeit ${isoDatumText(plan.zeitraum?.ab)} – ${isoDatumText(plan.zeitraum?.bis)} · Erklärungsturnus ${TURNUS_LABEL[e.zeitraum.erklaerungsTurnus]}`}
        </>
      );
    case 2: {
      const kanaele = (e.profil.p1.eigenerShop ? 1 : 0) + e.profil.p1.marktplaetze.length;
      return `${anzahl(kanaele, 'Verkaufskanal', 'Verkaufskanäle')} · ${anzahl(e.profil.p3.laender.length, 'Zielland', 'Zielländer')} · ${anzahl(e.profil.p2.lager.length, 'Lagerort', 'Lagerorte')} · ${plan.risiken.length} Risiken vorgeschlagen`;
    }
    case 3: {
      const aktiv = e.ziele.filter((z) => z.aktiv).length;
      const freigabe = e.freigabe.anfordern
        ? `Freigabe bei ${namen.name(e.freigabe.empfaengerId)} anfordern`
        : 'ohne Freigabeanforderung';
      return `${aktiv} Ziele · höchster Risikoappetit ${KLASSE_LABEL[plan.appetit]} · ${freigabe}`;
    }
    case 4: {
      const ue = plan.risiken.filter((r) => r.uebernehmen);
      return `${ue.length} übernommen (davon ${ue.filter((r) => r.kern).length} Kernrisiken) · ${plan.risiken.length - ue.length} begründet abgelehnt`;
    }
    default:
      return `${plan.kontrollen.length} Kontrollen (${plan.kontrollen.filter((k) => k.schluessel).length} Schlüssel) · ${plan.durchfuehrungen} Durchführungen geplant`;
  }
}

/** Gruppen für Schritt 5: übernommene Risiken nach Bruttoklasse, dann Kontrollen ohne Risikobezug. */
function kontrollGruppen(plan: PlanView): KontrollGruppe[] {
  const uebernommen = plan.risiken
    .filter((r) => r.uebernehmen)
    .sort((a, b) => KLASSE_RANG[b.brutto] - KLASSE_RANG[a.brutto] || a.code.localeCompare(b.code));
  const gruppen: KontrollGruppe[] = uebernommen
    .map((r) => ({
      code: r.code,
      titel: r.titel,
      brutto: r.brutto,
      kontrollen: plan.kontrollen.filter((k) => k.risikoCodes.includes(r.code)),
    }))
    .filter((g) => g.kontrollen.length > 0);
  const ohne = plan.kontrollen.filter((k) => k.risikoCodes.length === 0);
  if (ohne.length) {
    gruppen.push({
      code: null,
      titel: 'Kultur und Kommunikation (ohne Risikobezug)',
      brutto: null,
      kontrollen: ohne,
    });
  }
  return gruppen;
}

interface EinrichtungModell {
  seite: TcmsMandantSeite;
  e: EinrichtungView;
  entwurf: Entwurf;
  plan: PlanView;
  rollen: ReturnType<typeof aktiveRollen>;
  namen: TcmsNamen;
  kanzlei: TcmsZustaendigkeit['kanzlei'];
  schritt: 1 | 2 | 3 | 4 | 5;
  /** Höchster erreichbarer Schritt. */
  max: number;
  href: (n: number) => string;
}

function schrittAus(roh: string | undefined, max: number): EinrichtungModell['schritt'] {
  const n = Number(roh);
  return (Number.isInteger(n) && n >= 1 ? Math.min(n, max) : max) as EinrichtungModell['schritt'];
}

function zusammenfassungDaten(m: EinrichtungModell): ZusammenfassungDaten {
  const { entwurf, plan } = m;
  const uebernommen = plan.risiken.filter((r) => r.uebernehmen);
  return {
    teilbereich: entwurf.teilbereich.name,
    zeitraum: plan.zeitraum,
    turnus: entwurf.zeitraum.erklaerungsTurnus,
    ziele: entwurf.ziele.filter((z) => z.aktiv).length,
    appetit: plan.appetit,
    freigabeAn: entwurf.freigabe.anfordern ? m.namen.name(entwurf.freigabe.empfaengerId) : null,
    risiken: uebernommen.length,
    kern: uebernommen.filter((r) => r.kern).length,
    abgelehnt: plan.risiken.length - uebernommen.length,
    kontrollen: plan.kontrollen.length,
    schluessel: plan.kontrollen.filter((k) => k.schluessel).length,
    durchfuehrungen: plan.durchfuehrungen,
    prueflast: plan.prueflast,
  };
}

function SchrittInhalt({ m }: { m: EinrichtungModell }) {
  const { entwurf, plan, rollen, namen } = m;
  const basis = {
    mandantId: m.seite.mandantId,
    darf: m.e.darfBearbeiten,
    gesperrtGrund: TCMS_KEIN_RECHT.BEARBEITEN,
  };
  switch (m.schritt) {
    case 1:
      return (
        <SchrittTeilbereich
          {...basis}
          start={{ teilbereich: entwurf.teilbereich, zeitraum: entwurf.zeitraum }}
          paket={{
            name: PAKET.name,
            version: PAKET.version,
            risiken: KATALOG_RISIKEN.length,
            kontrollen: KATALOG_KONTROLLEN.length,
            fragen: PROFIL_FRAGEN.length,
          }}
        />
      );
    case 2:
      return (
        <SchrittProfil
          {...basis}
          start={entwurf.profil as Geschaeftsprofil}
          personen={ansprechpersonen(rollen, namen)}
          // „Heute“ der Uhr des Dienstes (TCMS s7): dieselbe Uhr, mit der er beim
          // Speichern prüft – nicht die des Web-Servers.
          heuteIso={m.e.heute}
        />
      );
    case 3:
      return (
        <SchrittZiele
          {...basis}
          start={{ ziele: entwurf.ziele, freigabe: entwurf.freigabe }}
          gv={kontaktPersonen(rollen, namen, ['GESETZLICHER_VERTRETER']).filter((p) =>
            m.e.gesetzlicheVertreter.some((x) => x.toLowerCase() === p.id),
          )}
        />
      );
    case 4:
      return <SchrittRisiken {...basis} plan={plan} />;
    default:
      return (
        <SchrittKontrollen
          {...basis}
          gruppen={kontrollGruppen(plan)}
          start={Object.fromEntries(
            plan.kontrollen.map((k) => [
              k.code,
              {
                partei: k.zust.partei,
                durchfuehrendId: k.zust.durchfuehrendId,
                vertretungId: k.zust.vertretungId,
                gegenzeichnerId: k.zust.gegenzeichnerId,
              },
            ]),
          )}
          kanzlei={m.kanzlei}
          mandant={kontaktPersonen(rollen, namen)}
          zusammenfassung={<Zusammenfassung d={zusammenfassungDaten(m)} />}
        />
      );
  }
}

function EntwurfKopf({ m }: { m: EinrichtungModell }) {
  const { entwurf, namen } = m;
  const von = entwurf.gespeichertVon ? ` von ${namen.name(entwurf.gespeichertVon)}` : '';
  return (
    <>
      <Kopf>
        <p className="text-sm text-muted mt-1">
          Neues Tax-CMS in fünf Schritten –{' '}
          {m.e.programm && entwurf.gespeichertAm
            ? `Entwurf, zuletzt gespeichert am ${isoZeitText(entwurf.gespeichertAm)}${von}; noch keine Version angelegt.`
            : 'Entwurf, noch keine Version angelegt.'}
        </p>
      </Kopf>
      {!m.e.darfBearbeiten ? (
        <p className="alert-warning mb-4 flex items-start gap-2" role="note">
          <Lock className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
          <span>{TCMS_KEIN_RECHT.BEARBEITEN} Sie sehen den Entwurf nur lesend.</span>
        </p>
      ) : null}
    </>
  );
}

function MandantKarte({ m }: { m: EinrichtungModell }) {
  const ansprech = ansprechpersonen(m.rollen, m.namen);
  return (
    <div className="card px-6 py-4 mb-4 flex flex-wrap items-end justify-between gap-4">
      <div>
        <p className="label">Mandant</p>
        <p className="text-sm font-semibold">
          <TcmsText>{m.seite.mandant.name}</TcmsText>
        </p>
        <p className="hint">
          {m.e.programm
            ? 'Entwurf im Einrichtungsassistenten, noch keine Version'
            : 'noch kein Programm'}
        </p>
      </div>
      <div className="text-xs text-muted text-right space-y-0.5">
        {ansprech.length ? (
          <dl className="space-y-0.5">
            {ansprech.map((p) => (
              <div key={`${p.rolle}-${p.id}`}>
                <dt className="inline font-medium text-secondary">
                  <TcmsText>{p.rolle}</TcmsText>:
                </dt>{' '}
                <dd className="inline">
                  <TcmsText>{p.name}</TcmsText>
                  {p.funktion ? ` (${p.funktion})` : ''}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p>
            Keine Ansprechpersonen im Tax-CMS hinterlegt –{' '}
            <Link className="underline" href={`${m.seite.basis}/kontakte`}>
              Kontakte & Rollen
            </Link>
            .
          </p>
        )}
        {isStaffAdmin(m.seite.session) ? (
          <p>
            <Link className="underline" href="/staff/tcms/katalog">
              Katalog des Pakets ansehen
            </Link>
          </p>
        ) : null}
      </div>
    </div>
  );
}

function unterzeilen(m: EinrichtungModell): Record<number, string> {
  const { entwurf, plan } = m;
  const uebernommen = plan.risiken.filter((r) => r.uebernehmen).length;
  return {
    1: `${PAKET.name} v${PAKET.version}`,
    2: `${PROFIL_FRAGEN.length} Profilfragen`,
    3: `${entwurf.ziele.filter((z) => z.aktiv).length} Ziele`,
    4:
      entwurf.abgeschlossen >= 2
        ? `${uebernommen} von ${plan.risiken.length} übernommen`
        : 'aus dem Profil',
    5: entwurf.abgeschlossen >= 4 ? `${plan.kontrollen.length} Kontrollen` : 'Zuständigkeiten',
  };
}

function OffenePunkte({ m }: { m: EinrichtungModell }) {
  const offen = m.e.pruefung.find((p) => p.schritt === m.schritt)?.fehler ?? [];
  if (!offen.length) return null;
  return (
    <div className="alert-info-sm mx-6 mt-4" role="note">
      <p className="font-medium">
        Noch offen in diesem Schritt (Stand des gespeicherten Entwurfs):
      </p>
      <ul className="list-disc pl-5 mt-1">
        {offen.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>
    </div>
  );
}

const stufenTitel = (nr: number, t: string) => (nr === 2 ? 'Geschäftsprofil (P1–P12)' : t);

function stufenText(m: EinrichtungModell, nr: number): ReactNode {
  if (nr <= m.entwurf.abgeschlossen) return kurzfassung(nr, m.entwurf, m.plan, m.namen);
  return nr <= m.max ? 'bereit' : 'noch offen – erst nach den vorherigen Schritten';
}

function Stufen({ m }: { m: EinrichtungModell }) {
  return (
    <>
      {SCHRITTE.map((s) =>
        s.nr === m.schritt ? (
          <StufeOffen key={s.nr} nr={s.nr} titel={stufenTitel(s.nr, s.titel)}>
            <OffenePunkte m={m} />
            <SchrittInhalt m={m} />
          </StufeOffen>
        ) : (
          <StufeZu
            key={s.nr}
            nr={s.nr}
            titel={stufenTitel(s.nr, s.titel)}
            erledigt={s.nr <= m.entwurf.abgeschlossen}
            text={stufenText(m, s.nr)}
            href={s.nr <= m.max ? m.href(s.nr) : null}
          />
        ),
      )}
    </>
  );
}

export default async function TcmsEinrichtungPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ schritt?: string | string[] }>;
}) {
  const { id } = await params;
  const seite = await tcmsMandantSeite(id);
  if (!seite.ok) return <TcmsZustand zustand={seite.zustand} />;

  const bezug = { tenantId: seite.session.user.tenantId, mandantId: seite.mandantId };
  const zust = await tcmsTenantLesen(seite, (tx) => tcmsZustaendigkeitTx(tx, bezug));
  const lesen = await tcmsLesenOptional(seite, ENDPUNKTE.einrichtungLesen, {
    query: einrichtungLesenQuery(zust),
  });
  if (!lesen.ok) return <TcmsZustand zustand={lesen.zustand} />;
  if (lesen.daten === null) return <NichtImTcms seite={seite} />;
  const e = lesen.daten;
  if (e.eingerichtet) return <Eingerichtet seite={seite} e={e} />;
  if (!e.entwurf || !e.plan) {
    return <TcmsZustand zustand={{ art: 'ANFRAGE_UNGUELTIG', requestId: lesen.requestId }} />;
  }
  const entwurf = e.entwurf;

  const kontakte = await tcmsLesen(seite, ENDPUNKTE.kontakteLesen);
  if (!kontakte.ok) return <TcmsZustand zustand={kontakte.zustand} />;
  const rollen = aktiveRollen(kontakte.daten.kontakte);
  const namen = await tcmsNamenLesen(
    seite,
    personIdsAus(
      rollen.map((r) => r.kontaktId),
      e.gesetzlicheVertreter,
      entwurf.gespeichertVon,
      entwurf.freigabe.empfaengerId,
    ),
  );
  const max = Math.min(5, entwurf.abgeschlossen + 1);
  const m: EinrichtungModell = {
    seite,
    e,
    entwurf,
    plan: e.plan,
    rollen,
    namen,
    kanzlei: zust.kanzlei,
    schritt: schrittAus(eins((await searchParams).schritt), max),
    max,
    href: (n) => `${seite.basis}/einrichtung?schritt=${n}`,
  };

  return (
    <section aria-labelledby="tcms-einrichtung" className="max-w-6xl">
      <EntwurfKopf m={m} />
      <MandantKarte m={m} />
      <div className="card px-6 py-4 mb-4">
        <Schrittleiste
          aktiv={m.schritt}
          abgeschlossen={entwurf.abgeschlossen}
          href={m.href}
          unterzeilen={unterzeilen(m)}
        />
      </div>
      <Stufen m={m} />
    </section>
  );
}
