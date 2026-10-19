// =============================================================================
// /staff/clients/:id/tcms/profil — Geschäftsprofil des Tax-CMS (TCMS Stufe 3,
// Bereich A; portiert aus der Demo staff/clients/[id]/tcms/profil/page.tsx).
//
// Daten: `kontextLesen` (Kopf, Teilbereich, Ziele, aktive Risiken, Rechte)
// und `profilLesen` (Profilstände, Risikoentscheidungen und die Vorschläge des
// Dienstes mit Entscheidung zum Stichtag). Die Demo rechnete den Vorschlag
// selbst (`schlageRisikenVor`); hier zeigt die Seite die Vorschläge des
// Dienstes und wählt nur aus, in welchem Abschnitt sie stehen. Namen kommen
// aus der kanzleikonsole.
// =============================================================================

import Link from 'next/link';
import { FileText, Pencil } from 'lucide-react';
import {
  ENDPUNKTE,
  StandSchema,
  type KontextAntwort,
  type ProfilDaten,
} from '@taxtronik/tcms-contract';
import type { Geschaeftsprofil } from '@taxtronik/tcms-domain';
import { TcmsPflichthinweis } from '@/components/tcms/disclaimer';
import { isoDatumText } from '@/components/tcms/format';
import { TcmsKopf, type TcmsKopfDaten } from '@/components/tcms/kopf';
import { TcmsLeer } from '@/components/tcms/leer';
import { ansprechpersonen, rollenAusKontext } from '@/components/tcms/programm/kontakte';
import { TcmsZustand } from '@/components/tcms/zustand';
import { personIdsAus, type TcmsNamen } from '@/server/tcms/namen';
import {
  aufnahmeHindernis,
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
import { ProfilAendernFormular } from './profil-aendern';
import {
  gueltigAm,
  Historie,
  StandKarte,
  TeilbereichZiele,
  Vorschlaege,
  type AufnahmeMeldung,
  type ProfilModell,
} from './teile';

export const metadata = { title: 'Tax-CMS – Geschäftsprofil' };

type SP = Record<string, string | string[] | undefined>;

const eins = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
const UEBERSCHRIFT = <h2 className="text-lg font-semibold text-primary mr-2">Geschäftsprofil</h2>;
const ZAHL = /^\d{1,5}$/;
const KONTROLLE = /^K-EC-\d{2}$/;

function zahl(sp: SP, k: string): number {
  return ZAHL.test(eins(sp[k])) ? Number(eins(sp[k])) : 0;
}

function codes(sp: SP, k: string): string[] {
  return eins(sp[k])
    .split(',')
    .filter((x) => KONTROLLE.test(x))
    .slice(0, 50);
}

/** Erfolgsmeldung „Risiko aufgenommen“ aus der Weiterleitung (streng geprüft). */
function aufnahmeMeldung(sp: SP): AufnahmeMeldung | null {
  const code = eins(sp['aufgenommen']);
  if (!/^EC-[A-Z]{3}-\d{2}$/.test(code)) return null;
  return { code, kn: codes(sp, 'kn'), vk: codes(sp, 'vk'), ng: codes(sp, 'ng'), d: zahl(sp, 'd') };
}

function kopfDaten(ctx: KontextAntwort): TcmsKopfDaten {
  return {
    teilbereich: ctx.teilbereich,
    aktivePhase: ctx.programm?.version1Am ? ctx.aktivePhase : null,
    historisch: ctx.historisch,
    stand: ctx.stand,
    heute: ctx.heute,
    ausgeblendet: ctx.ausgeblendet,
  };
}

function OhneVersion({ seite, ctx }: { seite: TcmsMandantSeite; ctx: KontextAntwort }) {
  const laeuft = ctx.programm !== null;
  return (
    <>
      <TcmsKopf daten={kopfDaten(ctx)} titel={UEBERSCHRIFT} />
      <div className="card">
        <TcmsLeer
          icon={laeuft ? Pencil : FileText}
          text={
            laeuft
              ? 'Die Einrichtung läuft. Teilbereich, Geschäftsprofil und Ziele werden bis zur Anlage von Version 1 im Einrichtungsassistenten gepflegt.'
              : 'Für diesen Mandanten ist noch kein Tax-CMS eingerichtet; das Geschäftsprofil entsteht im Einrichtungsassistenten.'
          }
        >
          {ctx.rechte.bearbeiten ? (
            <Link className="btn-primary" href={`${seite.basis}/einrichtung`}>
              {laeuft ? 'Einrichtung fortsetzen' : 'Tax-CMS einrichten'}
            </Link>
          ) : (
            <span className="text-sm text-muted">{TCMS_KEIN_RECHT.BEARBEITEN}</span>
          )}
        </TcmsLeer>
      </div>
    </>
  );
}

function GeaendertMeldung({ m, sp }: { m: ProfilModell; sp: SP }) {
  if (eins(sp['geaendert']) !== '1' || m.ctx.historisch) return null;
  return (
    <p className="alert-success mb-3 text-sm" role="status">
      Neuer Profilstand angelegt
      {m.juengster ? ` (gültig ab ${isoDatumText(m.juengster.gueltigAb)})` : ''}. {zahl(sp, 'nb')}{' '}
      Risiko/Risiken zur Neubewertung markiert · {zahl(sp, 'ev')} Ereignis(se) im Ereigniseingang
      angelegt · {zahl(sp, 'nv')} Vorschlag/Vorschläge noch nicht im Inventar.
    </p>
  );
}

function Aendern({ m }: { m: ProfilModell }) {
  const basis = m.juengster!;
  return (
    <section className="card mb-4" id="aendern" aria-labelledby="profil-aendern">
      <div className="card-header">
        <h3 id="profil-aendern" className="text-sm font-semibold text-primary">
          Profil ändern
        </h3>
        <span className="text-xs text-muted">
          Basis: Stand gültig ab {isoDatumText(basis.gueltigAb)} · {m.namen.name(basis.erstelltVon)}
        </span>
      </div>
      <ProfilAendernFormular
        mandantId={m.mandantId}
        profilStandId={basis.id}
        start={basis.antworten as Geschaeftsprofil}
        personen={ansprechpersonen(rollenAusKontext(m.ctx.kontaktRollen), m.namen)}
        heuteIso={m.p.heute}
        abbrechenHref={`${m.basis}/profil`}
      />
    </section>
  );
}

function NichtAngelegt({ seite }: { seite: TcmsMandantSeite }) {
  return (
    <div className="card">
      <TcmsLeer
        icon={FileText}
        text="Dieser Mandant ist im Tax-CMS noch nicht angelegt; das Geschäftsprofil entsteht im Einrichtungsassistenten."
      >
        <Link className="btn-primary" href={seite.basis}>
          Zum Cockpit
        </Link>
      </TcmsLeer>
    </div>
  );
}

function sperrgrund(ctx: KontextAntwort, zust: TcmsZustaendigkeit | null): string | null {
  if (ctx.historisch) return 'Nur im aktuellen Stand möglich.';
  if (!ctx.rechte.bearbeiten) return TCMS_KEIN_RECHT.BEARBEITEN;
  return zust ? aufnahmeHindernis(zust) : null;
}

function modell(
  seite: TcmsMandantSeite,
  ctx: KontextAntwort,
  p: ProfilDaten,
  namen: TcmsNamen,
  zust: TcmsZustaendigkeit | null,
): ProfilModell {
  const rueckwaerts = [...p.staende].reverse();
  return {
    mandantId: seite.mandantId,
    basis: seite.basis,
    ctx,
    p,
    namen,
    angezeigt: rueckwaerts.find((s) => gueltigAm(s, ctx.stand)) ?? null,
    juengster: rueckwaerts.find((s) => s.gueltigBis === null) ?? p.staende.at(-1) ?? null,
    aufnehmenGesperrt: sperrgrund(ctx, zust),
  };
}

function AendernLink({ m }: { m: ProfilModell }) {
  if (!m.ctx.rechte.bearbeiten || m.ctx.historisch || !m.juengster) return null;
  return (
    <Link className="btn-primary text-xs py-1" href={`${m.basis}/profil?aendern=1#aendern`}>
      <Pencil className="h-3.5 w-3.5" aria-hidden="true" /> Profil ändern
    </Link>
  );
}

function ProfilInhalt({ m, sp }: { m: ProfilModell; sp: SP }) {
  const darf = m.ctx.rechte.bearbeiten && !m.ctx.historisch;
  const aendern = eins(sp['aendern']) === '1' && darf && m.juengster !== null;
  return (
    <>
      <TcmsKopf daten={kopfDaten(m.ctx)} titel={UEBERSCHRIFT} rechts={<AendernLink m={m} />} />
      {!m.ctx.rechte.bearbeiten && !m.ctx.historisch ? (
        <p className="text-xs text-muted mb-3">{TCMS_KEIN_RECHT.BEARBEITEN}</p>
      ) : null}
      <GeaendertMeldung m={m} sp={sp} />
      {aendern ? <Aendern m={m} /> : null}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <StandKarte m={m} />
        <div className="space-y-4">
          <TeilbereichZiele m={m} />
          <Historie m={m} />
        </div>
      </div>
      <Vorschlaege m={m} aufgenommen={aufnahmeMeldung(sp)} />
      <div className="mt-4">
        <TcmsPflichthinweis />
      </div>
      <p className="text-xs text-muted mt-4">
        Der Vorschlag folgt den Regeln des Pakets (Fachkonzept § 4) und ist ein ungeprüfter Entwurf;
        Kernrisiken sind immer aktiv. Profiländerungen erzeugen die zugehörigen Ereignisse (§ 7) im
        Ereigniseingang.
      </p>
    </>
  );
}

export default async function TcmsProfilPage({
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
  const query = standRoh.success ? { stand: standRoh.data } : {};
  const kontext = await tcmsLesenOptional(seite, ENDPUNKTE.kontextLesen, { query });
  if (!kontext.ok) return <TcmsZustand zustand={kontext.zustand} />;
  if (kontext.daten === null) return <NichtAngelegt seite={seite} />;
  const ctx = kontext.daten;
  if (!ctx.programm?.version1Am) return <OhneVersion seite={seite} ctx={ctx} />;

  const profil = await tcmsLesen(seite, ENDPUNKTE.profilLesen, { query });
  if (!profil.ok) return <TcmsZustand zustand={profil.zustand} />;
  const p = profil.daten;
  // Zuständigkeit nur, wenn „Risiko aufnehmen“ angeboten werden kann.
  const zust =
    ctx.rechte.bearbeiten && !ctx.historisch
      ? await tcmsTenantLesen(seite, (tx) =>
          tcmsZustaendigkeitTx(tx, {
            tenantId: seite.session.user.tenantId,
            mandantId: seite.mandantId,
          }),
        )
      : null;
  const namen = await tcmsNamenLesen(
    seite,
    personIdsAus(
      p.staende.map((s) => s.erstelltVon),
      ctx.kontaktRollen.map((r) => r.kontaktId),
      ctx.ziele.map((z) => z.freigegebenVon),
    ),
  );
  return <ProfilInhalt m={modell(seite, ctx, p, namen, zust)} sp={sp} />;
}
