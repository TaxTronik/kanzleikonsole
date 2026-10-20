// =============================================================================
// /staff/tcms/arbeitskorb — Arbeitskorb der angemeldeten Person über alle
// zugänglichen Mandanten (TCMS Stufe 3, Bereich C; portiert aus der Demo
// staff/arbeitskorb/page.tsx).
//
// tcmsKanzleiSeite() als erster Aufruf (bestätigte Mandantenliste mit
// bt/hb); `arbeitskorbLesen` mit dieser Liste; Mandantennamen und
// Berufsträger aus der kanzleikonsole (portfolioMandanten), Personennamen
// über tcmsNamenLesen. Rechte werden beim Ausführen im jeweiligen Bereich
// erneut geprüft. Dazu ungeklärte Anlagen aus Portal-Meldungen der zugänglichen
// Mandanten aus der kanzleikonsole (kk-tcms-s10nach, TCMS-NACHWEIS-001).
// =============================================================================

import { ENDPUNKTE } from '@taxtronik/tcms-contract';
import { TcmsZustand } from '@/components/tcms/zustand';
import { personIdsAus } from '@/server/tcms/namen';
import { ungeklaerteMeldungsAnlagenTx } from '@/server/tcms/portal/meldevorgang';
import { portfolioMandanten } from '@/server/tcms/portfolio';
import { tcmsKanzleiSeite, tcmsLesen, tcmsNamenLesen, tcmsTenantLesen } from '@/server/tcms/seite';
import { ArbeitskorbAnsicht, type UngeklaerteJeMandant } from './ansicht';

export const metadata = { title: 'Tax-CMS – Arbeitskorb' };

export default async function TcmsArbeitskorbPage() {
  const seite = await tcmsKanzleiSeite();
  if (!seite.ok) return <TcmsZustand zustand={seite.zustand} />;
  const korb = await tcmsLesen(seite, ENDPUNKTE.arbeitskorbLesen);
  if (!korb.ok) return <TcmsZustand zustand={korb.zustand} />;
  const k = korb.daten;
  const [mandanten, namen, ungeklaert] = await Promise.all([
    portfolioMandanten(seite),
    tcmsNamenLesen(
      seite,
      personIdsAus(
        seite.session.user.staffId,
        k.gegenzeichnungen.map((g) => g.durchgefuehrtVon),
        k.vierAugen.flatMap((v) => v.beantragtVon),
        k.ereignisse.map((e) => e.gemeldetVon),
        k.beschreibungen.map((b) => b.angefordertVon),
      ),
    ),
    // Ungeklärte Anlagen aus Portal-Meldungen der zugänglichen Mandanten
    // (kk-tcms-s10nach): Daten der kanzleikonsole, je Mandant gezählt.
    tcmsTenantLesen(seite, (tx) =>
      ungeklaerteMeldungsAnlagenTx(tx, {
        tenantId: seite.session.user.tenantId,
        mandantIds: seite.liste.mandantIds,
      }),
    ),
  ]);
  const jeMandant = new Map<string, UngeklaerteJeMandant>();
  for (const a of ungeklaert) {
    const vorher = jeMandant.get(a.mandantId);
    jeMandant.set(a.mandantId, {
      mandantId: a.mandantId,
      anzahl: (vorher?.anzahl ?? 0) + 1,
      seit: vorher?.seit ?? a.seit.toISOString(),
    });
  }
  return (
    <ArbeitskorbAnsicht
      korb={k}
      mandanten={mandanten}
      namen={namen}
      nutzerId={seite.session.user.staffId}
      berufstraeger={seite.liste.bt.length > 0}
      ungeklaert={[...jeMandant.values()]}
    />
  );
}
