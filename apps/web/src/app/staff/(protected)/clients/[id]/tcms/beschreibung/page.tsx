// =============================================================================
// /staff/clients/:id/tcms/beschreibung — CMS-Beschreibung mit Versionen,
// Kanzlei-Review und Freigabe beim Mandanten (TCMS Stufe 3, Bereich A;
// portiert aus der Demo staff/clients/[id]/tcms/beschreibung/page.tsx).
//
// `beschreibungLesen` liefert Versionen mit Status zum Stichtag, lebende
// Bausteine, eingefrorenen Inhalt und dessen Prüfung (SHA-256), Freigaben und
// Zurückweisungen. Eingefrorene Versionen (beim Mandanten, freigegeben,
// abgelöst) zeigen genau den eingefrorenen Inhalt mit Hash und bieten keine
// Bearbeitung an; ändern lässt sich nur ein Entwurf – Sperren und Vier-Augen-
// Prinzip entscheidet der Dienst. Personennamen kommen aus der kanzleikonsole,
// im eingefrorenen Inhalt die eingefrorenen Namen.
// =============================================================================

import Link from 'next/link';
import type { ReactNode } from 'react';
import { FileText } from 'lucide-react';
import { ENDPUNKTE, StandSchema, type BeschreibungView } from '@taxtronik/tcms-contract';
import { ABSCHNITTE, type AbschnittVorlage } from '@taxtronik/tcms-domain';
import { TcmsPflichthinweis } from '@/components/tcms/disclaimer';
import { TcmsKopf, type TcmsKopfDaten } from '@/components/tcms/kopf';
import { TcmsLeer } from '@/components/tcms/leer';
import {
  bausteinPersonIds,
  BESCHREIBUNG_STATUS_LABEL,
  type BausteinQuelle,
} from '@/components/tcms/programm/beschreibung';
import { kontaktPersonen, rollenAusKontext } from '@/components/tcms/programm/kontakte';
import { TcmsZustand } from '@/components/tcms/zustand';
import { personIdsAus, type TcmsNamen } from '@/server/tcms/namen';
import { tcmsZustaendigkeitTx } from '@/server/tcms/programm/zustaendigkeit';
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
  AbschnittKarte,
  abschnittFuer,
  Gliederung,
  Hinweise,
  NeueVersion,
  NUR_AKTUELL,
  SnapshotKarte,
  Statusaktionen,
  VerlaufKarte,
  VersionenKarte,
  type BeschreibungModell,
  type HrefOptionen,
  type Version,
} from './teile';

export const metadata = { title: 'Tax-CMS – CMS-Beschreibung' };

type SP = Record<string, string | string[] | undefined>;

const eins = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
const EINGEFROREN = new Set<Version['anzeige']>(['BEIM_MANDANTEN', 'FREIGEGEBEN', 'ABGELOEST']);

const UEBERSCHRIFT = <h2 className="text-lg font-semibold text-primary mr-2">CMS-Beschreibung</h2>;

function Leer({
  seite,
  kopf,
  text,
  children,
}: {
  seite: TcmsMandantSeite;
  kopf: TcmsKopfDaten | null;
  text: string;
  children?: ReactNode;
}) {
  return (
    <>
      {kopf ? <TcmsKopf daten={kopf} titel={UEBERSCHRIFT} /> : null}
      <div className="card">
        <TcmsLeer icon={FileText} text={text}>
          {children ?? (
            <Link className="btn-primary" href={seite.basis}>
              Zum Cockpit
            </Link>
          )}
        </TcmsLeer>
      </div>
    </>
  );
}

/** Personen-IDs der Antwort für eine Namensabfrage. */
function personenDerAntwort(b: BeschreibungView): string[] {
  return personIdsAus(
    b.versionen.flatMap((v) => [
      v.erstelltVon,
      v.reviewAngefordertVon,
      v.reviewVon,
      v.freigegebenVon,
      v.letzteBearbeitung,
    ]),
    b.freigaben.flatMap((f) => [f.angefordertVon, f.empfaengerId]),
    b.zurueckweisungen.map((z) => z.actorId),
    b.gesetzlicheVertreter,
    bausteinPersonIds(b.bausteine),
  );
}

/** Bausteinquelle: eingefroren aus dem Snapshot, sonst lebend mit Namen der kanzleikonsole. */
function quelleFuer(b: BeschreibungView, v: Version, namen: TcmsNamen): BausteinQuelle {
  if (v.snapshot !== null && EINGEFROREN.has(v.anzeige)) {
    return {
      modus: 'snapshot',
      stand: v.snapshot.stand ?? null,
      satz: v.snapshot.bausteine ?? null,
    };
  }
  return {
    modus: 'live',
    stand: b.stand,
    satz: b.bausteine,
    namen: Object.fromEntries(
      bausteinPersonIds(b.bausteine).map((x) => [x.toLowerCase(), namen.name(x)]),
    ),
  };
}

function bearbeitenGrund(b: BeschreibungView, v: Version): string | null {
  if (b.historisch) return NUR_AKTUELL;
  if (!b.darfBearbeiten) return TCMS_KEIN_RECHT.BEARBEITEN;
  if (v.status !== 'ENTWURF')
    return 'Nur Entwürfe sind bearbeitbar – Änderungen entstehen als neue Version.';
  return null;
}

function modell(
  seite: TcmsMandantSeite,
  b: BeschreibungView,
  aktuell: Version,
  sp: SP,
  namen: TcmsNamen,
  gv: BeschreibungModell['gv'],
): BeschreibungModell {
  const v = b.versionen.find((x) => x.id === eins(sp['version'])) ?? aktuell;
  const abschnittKey = eins(sp['abschnitt']) || 'teilbereich';
  const gesamt = abschnittKey === 'alle';
  const vorlage: AbschnittVorlage =
    ABSCHNITTE.find((a) => a.key === abschnittKey) ?? ABSCHNITTE[0]!;
  const quelle = quelleFuer(b, v, namen);
  const eingefroren = quelle.modus === 'snapshot';
  const abschnitte = eingefroren && v.snapshot ? v.snapshot.abschnitte : v.abschnitte;
  const grund = bearbeitenGrund(b, v);
  const href = (o: HrefOptionen) => {
    const q = new URLSearchParams();
    const ver = o.version ?? v.id;
    if (ver !== aktuell.id) q.set('version', ver);
    const ab = o.abschnitt ?? abschnittKey;
    if (ab !== 'teilbereich') q.set('abschnitt', ab);
    if (o.bearbeiten) q.set('bearbeiten', '1');
    if (b.historisch) q.set('stand', b.stand);
    const s = q.toString();
    return `${seite.basis}/beschreibung${s ? `?${s}` : ''}`;
  };
  return {
    mandantId: seite.mandantId,
    basis: seite.basis,
    b,
    v,
    aktuell,
    gesamt,
    vorlage,
    eingefroren,
    abschnitte,
    abschnitt: abschnittFuer(abschnitte, vorlage.key),
    quelle,
    bearbeitbar: grund === null,
    bearbeitenGrund: grund,
    bearbeiten: grund === null && eins(sp['bearbeiten']) === '1' && !gesamt,
    offeneFreigabe:
      b.freigaben.filter((f) => f.refId === v.id && f.status === 'OFFEN').at(-1) ?? null,
    gv,
    me: seite.session.user.staffId.toLowerCase(),
    name: (id) => namen.name(id),
    href,
  };
}

export default async function TcmsBeschreibungPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SP>;
}) {
  const { id } = await params;
  const seite = await tcmsMandantSeite(id);
  if (!seite.ok) return <TcmsZustand zustand={seite.zustand} />;

  const sp = await searchParams;
  const standRoh = StandSchema.safeParse(eins(sp['stand']));
  const stand = standRoh.success ? { stand: standRoh.data } : {};
  const kontext = await tcmsLesenOptional(seite, ENDPUNKTE.kontextLesen, { query: stand });
  if (!kontext.ok) return <TcmsZustand zustand={kontext.zustand} />;
  if (kontext.daten === null) {
    return (
      <Leer seite={seite} kopf={null} text="Dieser Mandant ist im Tax-CMS noch nicht angelegt." />
    );
  }
  const ctx = kontext.daten;
  const kopf: TcmsKopfDaten = {
    teilbereich: ctx.teilbereich,
    aktivePhase: ctx.programm?.version1Am ? ctx.aktivePhase : null,
    historisch: ctx.historisch,
    stand: ctx.stand,
    heute: ctx.heute,
    ausgeblendet: ctx.ausgeblendet,
  };
  if (!ctx.programm) {
    return (
      <Leer
        seite={seite}
        kopf={kopf}
        text="Für diesen Mandanten ist noch kein Tax-CMS eingerichtet."
      />
    );
  }

  const zust = await tcmsTenantLesen(seite, (tx) =>
    tcmsZustaendigkeitTx(tx, { tenantId: seite.session.user.tenantId, mandantId: seite.mandantId }),
  );
  const lesen = await tcmsLesen(seite, ENDPUNKTE.beschreibungLesen, {
    query: {
      ...stand,
      ...(zust.berufstraeger ? { berufstraegerId: zust.berufstraeger.id } : {}),
      ...(zust.bearbeitung ? { bearbeitungId: zust.bearbeitung.id } : {}),
    },
  });
  if (!lesen.ok) return <TcmsZustand zustand={lesen.zustand} />;
  const b = lesen.daten;
  const rollen = rollenAusKontext(ctx.kontaktRollen);
  const namen = await tcmsNamenLesen(
    seite,
    personIdsAus(
      personenDerAntwort(b),
      rollen.map((r) => r.kontaktId),
    ),
  );

  const aktuell = b.versionen.at(-1) ?? null;
  if (!aktuell) {
    return (
      <Leer
        seite={seite}
        kopf={kopf}
        text="Es gibt noch keine CMS-Beschreibung. Die erste Version entsteht aus der Gliederung mit allen lebenden Bausteinen."
      >
        <NeueVersion
          mandantId={seite.mandantId}
          b={b}
          text="Erste Version anlegen"
          klasse="btn-primary"
        />
      </Leer>
    );
  }
  const gv = kontaktPersonen(rollen, namen, ['GESETZLICHER_VERTRETER']).filter((p) =>
    b.gesetzlicheVertreter.some((x) => x.toLowerCase() === p.id),
  );
  const m = modell(seite, b, aktuell, sp, namen, gv);

  return (
    <>
      <TcmsKopf daten={kopf} titel={UEBERSCHRIFT} />
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="badge-brand">
            Version {m.v.nummer} · {BESCHREIBUNG_STATUS_LABEL[m.v.anzeige]}
          </span>
          {m.v.id !== aktuell.id ? <span className="badge-gray">ältere Version</span> : null}
        </div>
        <div className="flex flex-wrap items-start gap-3">
          <Statusaktionen m={m} />
        </div>
      </div>
      <TcmsPflichthinweis />
      <Hinweise m={m} />
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 mt-4 items-start">
        <Gliederung m={m} />
        <AbschnittKarte m={m} />
        <div className="xl:col-span-3 space-y-4">
          <VersionenKarte m={m} />
          <SnapshotKarte m={m} />
          <VerlaufKarte m={m} />
          <p className="text-xs text-muted">
            Export als PDF oder DOCX folgt mit dem Nachweispaket der Prüfungsvorbereitung.
          </p>
        </div>
      </div>
    </>
  );
}
