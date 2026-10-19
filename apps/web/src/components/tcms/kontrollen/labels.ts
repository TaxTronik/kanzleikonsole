// =============================================================================
// Labels und reine Anzeigehelfer der Kontrollmatrix (TCMS Stufe 3, portiert
// aus der Demo components/kontrollen/labels.ts). Ohne I/O.
// =============================================================================

import type { KontrolleEintrag } from '@taxtronik/tcms-contract';
import type { BadgeKlasse } from '../ton';

export type BetriebsStand = KontrolleEintrag['betrieb'];

export const BETRIEB_LABEL: Readonly<Record<BetriebsStand, string>> = {
  OK: 'letzte fällige Durchführung ohne Befund, gegengezeichnet',
  MIT_BEFUND: 'letzte fällige Durchführung mit Befund',
  UEBERFAELLIG: 'Durchführung überfällig',
  KEINE: 'noch keine fällige Durchführung',
};

export const BETRIEB_KURZ: Readonly<Record<BetriebsStand, string>> = {
  OK: 'ohne Befund',
  MIT_BEFUND: 'mit Befund',
  UEBERFAELLIG: 'überfällig',
  KEINE: 'keine Durchführung',
};

export const BETRIEB_BADGE: Readonly<Record<BetriebsStand, BadgeKlasse>> = {
  OK: 'badge-green',
  MIT_BEFUND: 'badge-yellow',
  UEBERFAELLIG: 'badge-red',
  KEINE: 'badge-gray',
};

/** Audit-Aktionen zu Kontrollen (Historie im Detailbereich). */
export const KONTROLL_AUDIT_LABEL: Readonly<Record<string, string>> = {
  'tcms.kontrolle.design': 'Designbeurteilung erfasst',
  'tcms.kontrolle.abweichung_beantragt': 'Frequenzabweichung beantragt',
  'tcms.kontrolle.abweichung_freigegeben': 'Frequenzabweichung freigegeben (Vier-Augen)',
  'tcms.kontrolle.abweichung_abgelehnt': 'Frequenzabweichung abgelehnt',
  'tcms.kontrolle.abweichung_aufgehoben': 'Frequenzabweichung aufgehoben',
  'tcms.kontrolle.frequenz_geaendert': 'Frequenz geändert (Ableitung)',
  'tcms.kontrolle.neu_geplant': 'Künftige Durchführungen neu geplant',
  'tcms.kontrolle.zustaendigkeit': 'Zuständigkeiten geändert',
};

const text = (x: unknown) => (typeof x === 'string' && x !== '' ? x : null);

/**
 * Kurztext einer Audit-Zeile aus bekannten Feldern des Details (Struktur des
 * Dienstes, deshalb mit Typprüfung). Personen-IDs (Zuständigkeiten,
 * Antragsteller) werden über `name` aus der kanzleikonsole aufgelöst.
 */
export function kontrolleAuditText(
  detail: Readonly<Record<string, unknown>>,
  name: (id: string | null) => string,
): string {
  const teile: string[] = [];
  const v = detail['vorher'];
  const n = detail['nachher'];
  if (typeof v === 'string' && typeof n === 'string') teile.push(`${v} → ${n}`);
  if (v && n && typeof v === 'object' && typeof n === 'object' && 'durchfuehrend' in n) {
    const p = (x: Record<string, unknown>) =>
      `${name(text(x['durchfuehrend']))} / ${name(text(x['vertretung']))}${
        x['gegenzeichnungMandant'] === true
          ? ' · GZ beim Mandanten'
          : text(x['gegenzeichnung'])
            ? ` · GZ ${name(text(x['gegenzeichnung']))}`
            : ''
      }`;
    teile.push(`${p(v as Record<string, unknown>)} → ${p(n as Record<string, unknown>)}`);
  }
  if (Array.isArray(detail['angelegt']) || Array.isArray(detail['entfernt'])) {
    const a = Array.isArray(detail['angelegt']) ? detail['angelegt'].length : 0;
    const e = Array.isArray(detail['entfernt']) ? detail['entfernt'].length : 0;
    teile.push(`${a} angelegt, ${e} entfernt`);
  }
  const beantragt = text(detail['beantragt']);
  if (beantragt) teile.push(`beantragt: ${beantragt}`);
  const von = text(detail['beantragtVon']);
  if (von) teile.push(`Antrag von ${name(von)}`);
  const begruendung = text(detail['begruendung']);
  if (begruendung) teile.push(`„${begruendung}“`);
  const anlass = text(detail['anlass']);
  if (anlass) teile.push(anlass);
  return teile.join(' · ');
}

/** Personen-IDs, die `kontrolleAuditText` auflöst (für die Namensabfrage). */
export function kontrolleAuditPersonen(detail: Readonly<Record<string, unknown>>): string[] {
  const ids: string[] = [];
  const von = text(detail['beantragtVon']);
  if (von) ids.push(von);
  for (const seite of ['vorher', 'nachher']) {
    const x = detail[seite];
    if (x && typeof x === 'object') {
      for (const k of ['durchfuehrend', 'vertretung', 'gegenzeichnung']) {
        const id = text((x as Record<string, unknown>)[k]);
        if (id) ids.push(id);
      }
    }
  }
  return ids;
}
