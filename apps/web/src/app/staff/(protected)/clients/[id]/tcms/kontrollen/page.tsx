// =============================================================================
// /staff/clients/:id/tcms/kontrollen — Kontrollmatrix (TCMS Stufe 3,
// portiert aus der Demo staff/clients/[id]/tcms/kontrollen/page.tsx).
//
//   1. tcmsMandantSeite(id) als erster Aufruf
//   2. parallel: Kontext (Rechte, Programm, Risiken für die Matrix) und
//      `GET …/kontrollen` (mit Antragsteller einer Abweichung); bei geöffneter
//      Kontrolle `GET …/kontrollen/:id`
//   3. Namen und – nur bei geöffneter Kontrolle ohne Sperre – Auswahllisten
//      der Zuständigkeiten aus der kanzleikonsole
//
// Frequenzen, Design, Betrieb und Fälligkeiten berechnet der Dienst; die
// Seite zeigt sie an (TCMS-DIENST-001).
// =============================================================================

import { KeyRound, SquareCheckBig } from 'lucide-react';
import {
  ENDPUNKTE,
  type KontextAntwort,
  type KontrolleDetail,
  type KontrolleEintrag,
  type KontrollenListe,
} from '@taxtronik/tcms-contract';
import { MANDANT_ROLLE_LABEL } from '@taxtronik/tcms-domain';
import { SperrHinweis } from '@/components/tcms/bereich-b/detail';
import { auswerten, detailAus, kopfDaten, standQuery } from '@/components/tcms/bereich-b/laden';
import {
  mitStand,
  objektIdParam,
  param,
  seitenLink,
  sperreAus,
  standFuerLinks,
  type SuchParameter,
} from '@/components/tcms/bereich-b/seite';
import { TcmsPflichthinweis } from '@/components/tcms/disclaimer';
import { KontrolleDetailBereich } from '@/components/tcms/kontrollen/detail';
import { kontrolleAuditPersonen } from '@/components/tcms/kontrollen/labels';
import { KontrollMatrix, KontrollTabelle } from '@/components/tcms/kontrollen/liste';
import type { PersonOption } from '@/components/tcms/kontrollen/zustaendigkeit';
import { TcmsKopf } from '@/components/tcms/kopf';
import { TcmsLeer } from '@/components/tcms/leer';
import { AnsichtUmschalter } from '@/components/tcms/risiken/uebersicht';
import { TcmsZustand } from '@/components/tcms/zustand';
import {
  kanzleiPersonenAuswahlTx,
  mandantPersonenAuswahlTx,
} from '@/server/tcms/bereich-b/personen-auswahl';
import { personIdsAus } from '@/server/tcms/namen';
import {
  tcmsLesenOptional,
  tcmsMandantSeite,
  tcmsNamenLesen,
  tcmsTenantLesen,
  type TcmsMandantSeite,
} from '@/server/tcms/seite';
import {
  frequenzAbweichungAufhebenAction,
  frequenzAbweichungBeantragenAction,
  frequenzAbweichungEntscheidenAction,
  kontrolleDesignBeurteilenAction,
  verantwortlicheAendernAction,
} from './actions';

export const metadata = { title: 'Tax-CMS – Kontrollmatrix' };

function personenDerSeite(liste: KontrollenListe, detail: KontrolleDetail | null): string[] {
  return personIdsAus(
    liste.kontrollen.flatMap((k) => [
      k.durchfuehrendId,
      k.vertretungId,
      k.gegenzeichnerId,
      k.designVon,
      k.abweichung?.beantragtVon,
      k.abweichung?.freigegebenVon,
    ]),
    detail?.staende.map((s) => s.erstelltVon) ?? [],
    detail?.durchfuehrungen.map((d) => d.durchgefuehrtVon) ?? [],
    detail?.audit.flatMap((a) => [a.actorId, ...kontrolleAuditPersonen(a.detail)]) ?? [],
  );
}

/**
 * Auswahllisten der Zuständigkeiten: Kanzlei = aktive Mitarbeitende mit
 * Zugriff auf den Mandanten; Mandantenseite = aktive Kontakte dieses
 * Mandanten mit aktiver Rolle laut Dienst (Funktion bzw. Rolle als Zusatz).
 */
async function personenAuswahl(
  seite: TcmsMandantSeite,
  ctx: KontextAntwort,
  partei: KontrolleEintrag['partei'],
): Promise<{ seite: PersonOption[]; kanzlei: PersonOption[] }> {
  return tcmsTenantLesen(seite, async (tx) => {
    const bezug = { tenantId: seite.session.user.tenantId, mandantId: seite.mandantId };
    const kanzlei = await kanzleiPersonenAuswahlTx(tx, bezug);
    if (partei === 'KANZLEI') return { seite: kanzlei, kanzlei };
    const rollen = new Map<string, string | null>();
    for (const r of ctx.kontaktRollen) {
      const schluessel = r.kontaktId.toLowerCase();
      if (!rollen.has(schluessel)) {
        rollen.set(schluessel, r.funktion ?? MANDANT_ROLLE_LABEL[r.rolle]);
      }
    }
    return { seite: await mandantPersonenAuswahlTx(tx, bezug, rollen), kanzlei };
  });
}

function Kennzahlen({ kontrollen }: { kontrollen: readonly KontrolleEintrag[] }) {
  const zaehle = (f: (k: KontrolleEintrag) => boolean) => kontrollen.filter(f).length;
  const ohneDesign = zaehle((k) => k.design === 'NICHT_BEURTEILT');
  const mangel = zaehle((k) => k.design === 'MANGEL');
  const beantragt = zaehle((k) => !!k.abweichung && !k.abweichung.freigegebenVon);
  const ueberfaellig = zaehle((k) => k.naechste?.anzeige === 'UEBERFAELLIG');
  return (
    <ul
      className="flex flex-wrap items-center gap-2 my-3"
      aria-label="Kennzahlen der Kontrollmatrix"
    >
      <li className="badge-gray">{kontrollen.length} aktiv</li>
      <li className="badge-brand gap-1">
        <KeyRound className="h-3 w-3" aria-hidden="true" /> {zaehle((k) => k.schluessel)}{' '}
        Schlüsselkontrollen
      </li>
      {ohneDesign > 0 ? (
        <li className="badge-gray">Design nicht beurteilt ({ohneDesign})</li>
      ) : null}
      {mangel > 0 ? <li className="badge-red">Designmangel ({mangel})</li> : null}
      {beantragt > 0 ? (
        <li className="badge-purple">
          {beantragt} Abweichung{beantragt === 1 ? '' : 'en'} beantragt
        </li>
      ) : null}
      {ueberfaellig > 0 ? <li className="badge-red">{ueberfaellig} überfällig</li> : null}
    </ul>
  );
}

export default async function TcmsKontrollenPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SuchParameter>;
}) {
  const { id } = await params;
  const seite = await tcmsMandantSeite(id);
  if (!seite.ok) return <TcmsZustand zustand={seite.zustand} />;

  const sp = await searchParams;
  const query = standQuery(sp);
  const [kontext, matrix] = await Promise.all([
    tcmsLesenOptional(seite, ENDPUNKTE.kontextLesen, { query }),
    tcmsLesenOptional(seite, ENDPUNKTE.kontrollenLesen, { query }),
  ]);
  const geladen = auswerten(seite.basis, kontext, matrix, SquareCheckBig);
  if (!geladen.ok) return geladen.anzeige;
  const { ctx, daten: liste } = geladen;

  const pfad = `${seite.basis}/kontrollen`;
  const stand = standFuerLinks(liste);
  const ansicht = param(sp, 'ansicht') === 'matrix' ? 'matrix' : 'liste';
  const behalten = { stand, ansicht: ansicht === 'matrix' ? 'matrix' : null };
  const auswahlId = objektIdParam(sp, 'kontrolle');
  const auswahl = liste.kontrollen.find((k) => k.id === auswahlId) ?? null;
  const detail = detailAus(
    auswahl
      ? await tcmsLesenOptional(seite, ENDPUNKTE.kontrolleLesen, {
          params: { kontrolleId: auswahl.id },
          query,
        })
      : null,
  );
  // Recht des Bereichs aus der Kontrollmatrix (TCMS s7), wie die Schreiboperationen.
  const sperre = sperreAus(liste);
  const namen = await tcmsNamenLesen(
    seite,
    personenDerSeite(liste, detail?.ok ? detail.daten : null),
  );
  const personen = auswahl && !sperre ? await personenAuswahl(seite, ctx, auswahl.partei) : null;
  const detailHref = (kontrolleId: string) =>
    seitenLink(pfad, behalten, { kontrolle: kontrolleId });
  const risikoHref = (risikoId: string) =>
    mitStand(`${seite.basis}/risiken?risiko=${encodeURIComponent(risikoId)}`, stand);

  return (
    <>
      <TcmsKopf
        daten={kopfDaten(ctx)}
        titel={<h2 className="text-lg font-semibold text-primary mr-2">Kontrollmatrix</h2>}
        rechts={
          <AnsichtUmschalter
            aktiv={ansicht}
            optionen={[
              ['liste', 'Liste'],
              ['matrix', 'Matrix'],
            ]}
            href={(a) => seitenLink(pfad, { stand }, { ansicht: a === 'matrix' ? a : null })}
          />
        }
      />
      <TcmsPflichthinweis />
      <Kennzahlen kontrollen={liste.kontrollen} />
      <p className="text-xs text-muted mb-3">
        Kontrollen entstehen aus Katalogvorlagen mit der Übernahme der Risiken (Profil →
        Vorschläge).
      </p>
      <SperrHinweis grund={sperre} />

      <div
        className={
          auswahl ? 'grid grid-cols-1 2xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-4' : ''
        }
      >
        <section aria-labelledby="tcms-kontrollen-liste" className="card min-w-0">
          <h3 id="tcms-kontrollen-liste" className="sr-only">
            {ansicht === 'matrix' ? 'Matrix Risiken und Kontrollen' : 'Liste der Kontrollen'}
          </h3>
          {liste.kontrollen.length === 0 ? (
            <TcmsLeer
              icon={SquareCheckBig}
              text="Noch keine Kontrollen – sie entstehen mit der Übernahme der Risiken aus dem Katalog."
            />
          ) : ansicht === 'matrix' ? (
            <KontrollMatrix
              risiken={ctx.risiken}
              kontrollen={liste.kontrollen}
              kontrolleHref={detailHref}
              risikoHref={risikoHref}
            />
          ) : (
            <>
              <KontrollTabelle
                kontrollen={liste.kontrollen}
                risikoCode={new Map(ctx.risiken.map((r) => [r.id, r.code]))}
                namen={namen}
                wirksamAb={liste.wirksamAb}
                detailHref={detailHref}
                risikoHref={risikoHref}
                feststellungHref={(fid) =>
                  mitStand(`${seite.basis}/feststellungen/${encodeURIComponent(fid)}`, stand)
                }
                ausgewaehlt={auswahl?.id ?? null}
              />
              <div className="card-footer flex-wrap gap-2">
                <span>{liste.kontrollen.length} aktive Kontrollen</span>
                <span>
                  Frequenz = strengere aus Vorlage und Häufigkeitsmatrix (GT × Bruttoklasse);
                  Abweichungen nur mit Begründung und zweiter Person
                </span>
              </div>
            </>
          )}
        </section>

        {auswahl ? (
          <KontrolleDetailBereich
            eintrag={auswahl}
            detail={detail}
            ctx={ctx}
            namen={namen}
            ich={seite.session.user.staffId}
            sperre={sperre}
            basis={seite.basis}
            stand={stand}
            schliessenHref={seitenLink(pfad, behalten)}
            risikoHref={risikoHref}
            personen={personen}
            aktionen={{
              design: kontrolleDesignBeurteilenAction.bind(null, seite.mandantId),
              abweichungBeantragen: frequenzAbweichungBeantragenAction.bind(null, seite.mandantId),
              abweichungEntscheiden: frequenzAbweichungEntscheidenAction.bind(
                null,
                seite.mandantId,
              ),
              abweichungAufheben: frequenzAbweichungAufhebenAction.bind(null, seite.mandantId),
              zustaendigkeit: verantwortlicheAendernAction.bind(null, seite.mandantId),
            }}
          />
        ) : null}
      </div>

      <p className="text-xs text-muted mt-4">
        Matrix-Startwerte und Governance-Typen sind ungeprüfte Entwürfe und vom Berufsträger zu
        kalibrieren. Statusangaben sind Betriebsinformationen, keine Aussage über Angemessenheit
        oder Wirksamkeit.
      </p>
    </>
  );
}
