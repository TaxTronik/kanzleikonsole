// =============================================================================
// /staff/tcms/arbeitskorb — Arbeitskorb der angemeldeten Person über alle
// zugänglichen Mandanten (TCMS Stufe 3, Bereich C; portiert aus der Demo
// staff/arbeitskorb/page.tsx).
//
// tcmsKanzleiSeite() als erster Aufruf (bestätigte Mandantenliste mit
// bt/hb); `arbeitskorbLesen` mit dieser Liste; Mandantennamen und
// Berufsträger aus der kanzleikonsole (portfolioMandanten), Personennamen
// über tcmsNamenLesen. Rechte werden beim Ausführen im jeweiligen Bereich
// erneut geprüft.
// =============================================================================

import { ENDPUNKTE } from '@taxtronik/tcms-contract';
import { TcmsZustand } from '@/components/tcms/zustand';
import { personIdsAus } from '@/server/tcms/namen';
import { portfolioMandanten } from '@/server/tcms/portfolio';
import { tcmsKanzleiSeite, tcmsLesen, tcmsNamenLesen } from '@/server/tcms/seite';
import { ArbeitskorbAnsicht } from './ansicht';

export const metadata = { title: 'Tax-CMS – Arbeitskorb' };

export default async function TcmsArbeitskorbPage() {
  const seite = await tcmsKanzleiSeite();
  if (!seite.ok) return <TcmsZustand zustand={seite.zustand} />;
  const korb = await tcmsLesen(seite, ENDPUNKTE.arbeitskorbLesen);
  if (!korb.ok) return <TcmsZustand zustand={korb.zustand} />;
  const k = korb.daten;
  const [mandanten, namen] = await Promise.all([
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
  ]);
  return (
    <ArbeitskorbAnsicht
      korb={k}
      mandanten={mandanten}
      namen={namen}
      nutzerId={seite.session.user.staffId}
      berufstraeger={seite.liste.bt.length > 0}
    />
  );
}
