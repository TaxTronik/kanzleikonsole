// =============================================================================
// /staff/clients/:id/tcms/ereignisse — Ereigniseingang und Triage (TCMS
// Stufe 3, Bereich D; portiert aus der Demo staff/clients/[id]/tcms/ereignisse).
//
//   1. tcmsMandantSeite(id) zuerst (Zugriff, Modul, Dienst, Akteur)
//   2. Kontext (Rechte-Kennzeichen, Risiken, Kontrollen, Feststellungen,
//      Kontaktrollen, Kopf) und Ereignisliste zum Stichtag, dann das Detail
//      des gewählten Ereignisses (`?e=<id>`, nur IDs aus der Liste)
//   3. Namen und Personen der Zuständigkeit aus der kanzleikonsole
//
// Status, Folgen, Vier-Augen und Rechte entscheidet das Tax-CMS; die Seite
// zeigt und sperrt nur nach der Antwort (Stichtag, `rechte.bearbeiten`).
// =============================================================================

import Link from 'next/link';
import { Inbox, Plus, ShieldCheck } from 'lucide-react';
import {
  ENDPUNKTE,
  StandSchema,
  type EreignisListeSchema,
  type KontextAntwort,
} from '@taxtronik/tcms-contract';
import { EREIGNISTYPEN, EREIGNIS_QUELLE_LABEL } from '@taxtronik/tcms-domain';
import type { z } from 'zod';
import { TcmsPflichthinweis } from '@/components/tcms/disclaimer';
import { TcmsFormDialog } from '@/components/tcms/ereignisse/aktionen';
import { EreignisListe } from '@/components/tcms/ereignisse/liste';
import { KANZLEI_QUELLEN } from '@/components/tcms/ereignisse/texte';
import { TcmsKopf } from '@/components/tcms/kopf';
import { TcmsLeer } from '@/components/tcms/leer';
import { TcmsZustand } from '@/components/tcms/zustand';
import { kanzleiPersonenAuswahlTx, zustaendigkeitTx } from '@/server/tcms/ereignisse/personen';
import { personIdsAus } from '@/server/tcms/namen';
import { kontakteDesMandantenTx } from '@/server/tcms/personen';
import {
  tcmsLesen,
  tcmsLesenOptional,
  tcmsMandantSeite,
  tcmsNamenLesen,
  tcmsTenantLesen,
  type TcmsMandantSeite,
} from '@/server/tcms/seite';
import { TCMS_KEIN_RECHT, type TcmsSeitenZustand } from '@/server/tcms/zustand';
import { ereignisErfassenAction } from './actions';
import { TriagePanel, type EreignisDetail, type TriagePersonen } from './triage';
import { TCMS_TEXT_ISOLIERT } from '@/components/tcms/text';

export const metadata = { title: 'Tax-CMS – Ereignisse' };

type SP = Record<string, string | string[] | undefined>;
type Eintrag = z.infer<typeof EreignisListeSchema>['ereignisse'][number];

const NUR_LESEN = 'Historischer Stand – nur Lesen. Änderungen wirken auf den aktuellen Stand.';

/** Feste Hinweise nach einem Anlagen-Abruf (route.ts leitet mit `?anlage=` zurück). */
const ANLAGE_HINWEIS: Readonly<Record<string, string>> = {
  abweichend:
    'Die Anlage wurde nicht ausgeliefert: Der Inhalt in der Dokumentenablage stimmt nicht mit dem im Tax-CMS gespeicherten Stand (SHA-256) überein.',
  'nicht-verfuegbar':
    'Die Anlage ist in der Dokumentenablage nicht (mehr) verfügbar oder noch nicht geprüft.',
};

const KEINE_PERSONEN: TriagePersonen = {
  optionen: [],
  berufstraeger: null,
  hauptbearbeitung: null,
};

function eins(wert: string | string[] | undefined): string | undefined {
  return Array.isArray(wert) ? wert[0] : wert;
}

/** Tag + n Tage (UTC) als `YYYY-MM-DD`; nur Vorbelegung einer Frist im Formular. */
function plusTage(tag: string, tage: number): string {
  const ms = Date.parse(`${tag}T00:00:00.000Z`);
  return Number.isFinite(ms) ? new Date(ms + tage * 86_400_000).toISOString().slice(0, 10) : tag;
}

/** Gewähltes Ereignis: aus der URL (nur IDs der Liste), sonst das erste offene. */
function auswahl(ereignisse: readonly Eintrag[], eParam: string | undefined): Eintrag | null {
  return (
    ereignisse.find((e) => e.id === eParam) ??
    ereignisse.find((e) => e.status === 'NEU' || e.status === 'IN_TRIAGE') ??
    ereignisse[0] ??
    null
  );
}

/** Warum nichts geändert werden kann (Anzeige nach Stichtag und Rechte-Kennzeichen). */
function sperreAus(ctx: KontextAntwort): string | null {
  if (ctx.historisch) return NUR_LESEN;
  return ctx.rechte.bearbeiten ? null : TCMS_KEIN_RECHT.BEARBEITEN;
}

function personenIds(ereignisse: readonly Eintrag[], e: EreignisDetail | null) {
  return personIdsAus(
    ereignisse.map((x) => x.gemeldetVon),
    e
      ? [
          e.gemeldetVon,
          e.triagiertVon,
          e.verwerfenAntrag?.vonId,
          e.verwerfen?.vonId,
          ...e.folgen.flatMap((f) => [f.zustaendig, f.angelegt?.vonId, f.verwerfen?.vonId]),
          ...e.verlauf.map((v) => v.actorId),
        ]
      : [],
  );
}

/**
 * Auswahl der Zuständigkeit: Kanzleipersonen mit Zugriff auf den Mandanten und
 * aktive Kontakte dieses Mandanten mit Rolle im Tax-CMS (Kontext); Vorbelegung
 * aus der Zuständigkeit der kanzleikonsole. Die Aktion prüft jede Person erneut.
 */
async function triagePersonen(
  seite: TcmsMandantSeite,
  ctx: KontextAntwort,
): Promise<TriagePersonen> {
  return tcmsTenantLesen(seite, async (tx) => {
    const bezug = { tenantId: seite.session.user.tenantId, mandantId: seite.mandantId };
    const [kanzlei, kontakte, zustaendig] = await Promise.all([
      kanzleiPersonenAuswahlTx(tx, bezug),
      kontakteDesMandantenTx(tx, bezug),
      zustaendigkeitTx(tx, bezug),
    ]);
    const mitRolle = new Set(ctx.kontaktRollen.map((r) => r.kontaktId.toLowerCase()));
    const mandant = kontakte
      .filter((k) => k.aktiv && mitRolle.has(k.id.toLowerCase()))
      .map((k) => ({ wert: `M:${k.id.toLowerCase()}`, label: `${k.name} (Mandant)` }));
    return {
      optionen: [...kanzlei, ...mandant],
      berufstraeger: zustaendig.berufstraeger,
      hauptbearbeitung: zustaendig.hauptbearbeitung,
    };
  });
}

/** Fester Hinweis zu `?anlage=` (nur bekannte Schlüssel). */
function hinweisAus(code: string | undefined): string | null {
  return code && Object.hasOwn(ANLAGE_HINWEIS, code) ? ANLAGE_HINWEIS[code]! : null;
}

type Geladen =
  | { art: 'ZUSTAND'; zustand: TcmsSeitenZustand }
  | { art: 'OHNE_PROGRAMM' }
  | {
      art: 'OK';
      ctx: KontextAntwort;
      ereignisse: Eintrag[];
      gewaehlt: Eintrag | null;
      e: EreignisDetail | null;
      stand: string | null;
    };

/**
 * Kontext und Liste zum Stichtag (parallel), danach das Detail des gewählten
 * Ereignisses. 404 des Kontexts bzw. der Liste: Mandant noch nicht im Tax-CMS.
 */
async function ladeEreignisse(seite: TcmsMandantSeite, sp: SP): Promise<Geladen> {
  const standRoh = StandSchema.safeParse(eins(sp['stand']));
  const stand = standRoh.success ? standRoh.data : null;
  const query = stand ? { stand } : {};
  const [kontext, liste] = await Promise.all([
    tcmsLesenOptional(seite, ENDPUNKTE.kontextLesen, { query }),
    tcmsLesenOptional(seite, ENDPUNKTE.ereignisseLesen, { query }),
  ]);
  if (!kontext.ok) return { art: 'ZUSTAND', zustand: kontext.zustand };
  if (!liste.ok) return { art: 'ZUSTAND', zustand: liste.zustand };
  if (kontext.daten === null || liste.daten === null || !liste.daten.programmId) {
    return { art: 'OHNE_PROGRAMM' };
  }
  const ereignisse = liste.daten.ereignisse;
  const gewaehlt = auswahl(ereignisse, eins(sp['e']));
  if (!gewaehlt) return { art: 'OK', ctx: kontext.daten, ereignisse, gewaehlt, e: null, stand };
  const detail = await tcmsLesen(seite, ENDPUNKTE.ereignisLesen, {
    params: { ereignisId: gewaehlt.id },
    query,
  });
  if (!detail.ok) return { art: 'ZUSTAND', zustand: detail.zustand };
  return { art: 'OK', ctx: kontext.daten, ereignisse, gewaehlt, e: detail.daten, stand };
}

/** Zuständigkeiten nur laden, wenn Vorschläge angelegt werden können. */
function brauchtPersonen(e: EreignisDetail | null, sperre: string | null): boolean {
  return e !== null && sperre === null && e.folgen.some((f) => f.status === 'VORGESCHLAGEN');
}

function NichtEingerichtet({ seite }: { seite: TcmsMandantSeite }) {
  return (
    <div className="card">
      <TcmsLeer
        icon={ShieldCheck}
        text="Für diesen Mandanten ist noch kein Tax-CMS eingerichtet. Ereignisse gibt es erst mit einem Programm."
      >
        <Link href={seite.basis} className="btn-secondary">
          Zum Cockpit
        </Link>
      </TcmsLeer>
    </div>
  );
}

function ErfassenDialog({
  mandantId,
  heute,
  sperre,
}: {
  mandantId: string;
  heute: string;
  sperre: string | null;
}) {
  return (
    <TcmsFormDialog
      aktion={ereignisErfassenAction.bind(null, mandantId)}
      ausloeser={
        <>
          <Plus className="h-4 w-4" aria-hidden="true" /> Ereignis erfassen
        </>
      }
      titel="Ereignis erfassen (Kanzlei)"
      hinweis="Die Vorgangsnummer vergibt das Tax-CMS. Die Folgen des Ereignistyps werden als Vorschläge angelegt."
      bestaetigen="Erfassen"
      breit
      gesperrt={sperre}
    >
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="sm:col-span-2">
          <label htmlFor="e-typ" className="label-sm">
            Ereignistyp
          </label>
          <select id="e-typ" name="typ" className="input" defaultValue="" required>
            <option value="" disabled>
              bitte wählen
            </option>
            {EREIGNISTYPEN.map((t) => (
              <option {...TCMS_TEXT_ISOLIERT} key={t.code} value={t.code}>
                {t.code} · {t.titel}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="e-quelle" className="label-sm">
            Quelle
          </label>
          <select id="e-quelle" name="quelle" className="input" defaultValue="MANUELL">
            {KANZLEI_QUELLEN.map((q) => (
              <option key={q} value={q}>
                {EREIGNIS_QUELLE_LABEL[q]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label htmlFor="e-titel" className="label-sm">
          Bezeichnung
        </label>
        <input
          id="e-titel"
          name="titel"
          className="input"
          required
          minLength={5}
          maxLength={200}
          placeholder="z. B. USt-Sonderprüfung für Q2 2026 angekündigt"
        />
      </div>
      <div>
        <label htmlFor="e-beschreibung" className="label-sm">
          Beschreibung
        </label>
        <textarea
          {...TCMS_TEXT_ISOLIERT}
          id="e-beschreibung"
          name="beschreibung"
          className="input min-h-[6rem]"
          required
          minLength={10}
          maxLength={4000}
        />
      </div>
      <div>
        <label htmlFor="e-datum" className="label-sm">
          Datum des Ereignisses
        </label>
        <input
          id="e-datum"
          name="datum"
          type="date"
          className="input w-auto"
          required
          defaultValue={heute}
        />
      </div>
    </TcmsFormDialog>
  );
}

export default async function TcmsEreignissePage({
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
  const daten = await ladeEreignisse(seite, sp);
  if (daten.art === 'ZUSTAND') return <TcmsZustand zustand={daten.zustand} />;
  if (daten.art === 'OHNE_PROGRAMM') return <NichtEingerichtet seite={seite} />;
  const { ctx, ereignisse, gewaehlt, e, stand } = daten;
  const link = (pfad: string) => {
    const url = `${seite.basis}${pfad}`;
    return stand ? `${url}${url.includes('?') ? '&' : '?'}stand=${stand}` : url;
  };

  const sperre = sperreAus(ctx);
  const namen = await tcmsNamenLesen(seite, personenIds(ereignisse, e));
  // Zuständigkeiten nur, wenn Vorschläge angelegt werden können.
  const personen = brauchtPersonen(e, sperre) ? await triagePersonen(seite, ctx) : KEINE_PERSONEN;
  const nummern = new Map(ctx.feststellungen.map((f) => [f.id, f.nummer] as const));
  const offen = ereignisse.filter((x) => x.status === 'NEU').length;
  const anlageHinweis = hinweisAus(eins(sp['anlage']));

  return (
    <>
      <TcmsKopf
        daten={{
          teilbereich: ctx.teilbereich,
          aktivePhase: ctx.aktivePhase,
          historisch: ctx.historisch,
          stand: ctx.stand,
          heute: ctx.heute,
          ausgeblendet: ctx.ausgeblendet,
        }}
        titel={
          <>
            <h2 className="text-lg font-semibold text-primary mr-2">Ereigniseingang</h2>
            <span className={offen ? 'badge-yellow' : 'badge-gray'}>{offen} nicht triagiert</span>
          </>
        }
      />
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <p className="text-sm text-muted max-w-3xl">
          Jede Meldung wird triagiert; verworfen wird nur begründet und mit Bestätigung durch eine
          zweite Person – alle Schritte werden im Tax-CMS protokolliert.
        </p>
        <ErfassenDialog mandantId={seite.mandantId} heute={ctx.heute} sperre={sperre} />
      </div>
      {anlageHinweis ? (
        <p className="alert-warning mb-4" role="alert">
          {anlageHinweis}
        </p>
      ) : null}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 mb-4">
        <div className="xl:col-span-7">
          <EreignisListe
            ereignisse={ereignisse}
            gewaehltId={gewaehlt?.id ?? null}
            href={(ereignisId) => link(`/ereignisse?e=${encodeURIComponent(ereignisId)}`)}
            namen={namen}
            feststellungNummer={(fid) => {
              const nummer = nummern.get(fid);
              return nummer
                ? { nummer, href: link(`/feststellungen/${encodeURIComponent(fid)}`) }
                : null;
            }}
          />
        </div>
        <div className="xl:col-span-5">
          {e ? (
            <TriagePanel
              mandantId={seite.mandantId}
              basis={seite.basis}
              link={link}
              e={e}
              ctx={ctx}
              namen={namen}
              personen={personen}
              sperre={sperre}
              eigeneId={seite.session.user.staffId}
              standardFrist={plusTage(ctx.heute, 14)}
            />
          ) : (
            <div className="card">
              <TcmsLeer icon={Inbox} text="Ereignis auswählen, um es zu triagieren." />
            </div>
          )}
        </div>
      </div>
      <TcmsPflichthinweis />
    </>
  );
}
