// =============================================================================
// Geschäftsprofil P1–P12: Bereinigung, Pflichtangaben, lesbare Zeilen, Diff
// zwischen zwei Ständen und die daraus folgenden Trigger (Fachkonzept §4, §7).
// Reine Funktionen ohne I/O und ohne zod: Der Service (Strukturprüfung mit dem
// Vertragsschema `ProfilAntwortenSchema`) und die Client-Komponenten der Demo
// nutzen dieselbe Quelle.
// =============================================================================

import { bewerteSchwelle } from './schwelle';
import { fmtEurGanz, fmtMonatJahr } from './format';
import { ereignistyp } from './katalog/ereignisse';
import {
  PROFIL_FRAGEN,
  schlageRisikenVor,
  type Geschaeftsprofil,
  type LagerArt,
} from './katalog/profil';

type FrageKey = keyof Geschaeftsprofil;

export const LAGER_ART_LABEL: Record<LagerArt, string> = {
  EIGEN: 'eigenes Lager',
  FBA: 'Amazon FBA',
  'PAN-EU': 'Amazon PAN-EU',
  CEE: 'Amazon CEE',
  '3PL': '3PL-Dienstleister',
};

function frageNr(key: string): string {
  return PROFIL_FRAGEN.find((f) => f.key === key)?.nr ?? key.toUpperCase();
}

/**
 * Lesbare Strukturfehler je Profilfrage aus den Pfaden einer Schemaprüfung
 * (ohne Eingabewerte, damit keine Inhalte in Fehlermeldungen gelangen).
 */
export function profilStrukturFehler(
  issues: readonly { path: readonly PropertyKey[] }[],
): string[] {
  const fragen = [...new Set(issues.map((i) => frageNr(String(i.path[0] ?? ''))))];
  return fragen.map((f) => `${f}: Angaben unvollständig oder im falschen Format.`);
}

/**
 * Bereinigt ein strukturell geprüftes Profil: leere Zeilen aus dem Formular
 * entfernen, Listen eindeutig machen. Arbeitet auf einer Kopie; die Eingabe
 * bleibt unverändert.
 */
export function bereinigeProfil(geprueft: Geschaeftsprofil): Geschaeftsprofil {
  const profil: Geschaeftsprofil = structuredClone(geprueft);
  profil.p1.marktplaetze = [...new Set(profil.p1.marktplaetze.filter(Boolean))];
  profil.p3.laender = [...new Set(profil.p3.laender)];
  profil.p4.warengruppen = profil.p4.warengruppen.filter((w) => w.name.length > 0);
  profil.p5.laender = profil.p5.drittlandImport ? [...new Set(profil.p5.laender)] : [];
  profil.p6.zahlungswege = [...new Set(profil.p6.zahlungswege.filter(Boolean))];
  profil.p8.systeme = profil.p8.systeme.filter((s) => s.name.length > 0);
  profil.p9.lokaleUstNr = [...new Set(profil.p9.lokaleUstNr)];
  profil.p11.anbieter = profil.p11.vorhanden ? profil.p11.anbieter.filter((a) => a.length > 0) : [];
  if (!profil.p1.eigenerShop) profil.p1.shopSystem = '';
  return profil;
}

/** Fachliche Pflichtangaben (Einrichtung und Profiländerung). */
export function pruefeProfil(p: Geschaeftsprofil): string[] {
  const f: string[] = [];
  if (!p.p1.eigenerShop && p.p1.marktplaetze.length === 0)
    f.push('P1: Mindestens einen Verkaufskanal angeben (eigener Shop oder Marktplatz).');
  if (p.p1.eigenerShop && !p.p1.shopSystem.trim())
    f.push('P1: Shopsystem des eigenen Shops angeben.');
  const lagerLaender = p.p2.lager.map((l) => l.land);
  if (new Set(lagerLaender).size !== lagerLaender.length)
    f.push('P2: Jedes Lagerland nur einmal angeben.');
  if (p.p3.laender.length === 0) f.push('P3: Mindestens ein Zielland angeben.');
  if (p.p4.warengruppen.length === 0) f.push('P4: Mindestens eine Warengruppe angeben.');
  if (p.p5.drittlandImport && p.p5.laender.length === 0)
    f.push('P5: Herkunftsländer des Drittlandimports angeben.');
  if (p.p6.zahlungswege.length === 0) f.push('P6: Mindestens einen Zahlungsweg angeben.');
  if (p.p11.vorhanden && p.p11.anbieter.length === 0)
    f.push('P11: Mindestens einen ausländischen Anbieter nennen.');
  return f;
}

const jn = (b: boolean) => (b ? 'ja' : 'nein');
const liste = (xs: readonly string[], leer = '—') => (xs.length ? xs.join(', ') : leer);

/** Lesbare Zeilen je Profilfrage (Anzeige, Diff, Ereignistexte). */
export function profilZeilen(p: Geschaeftsprofil): Record<FrageKey, string[]> {
  return {
    p1: [
      p.p1.eigenerShop ? `Eigener Shop: ${p.p1.shopSystem || 'System offen'}` : 'Kein eigener Shop',
      `Marktplätze: ${liste(p.p1.marktplaetze, 'keine')}`,
    ],
    p2: [
      `Eigenversand ab Deutschland: ${jn(p.p2.eigenversandDE)}`,
      ...(p.p2.lager.length
        ? p.p2.lager.map((l) => `Lager ${l.land} seit ${fmtMonatJahr(l.seit)} (${l.art})`)
        : ['Keine Lager- oder Fulfillmentstandorte erfasst']),
    ],
    p3: [
      `Zielländer: ${liste(p.p3.laender)}`,
      `B2B-Anteil: ${p.p3.b2bAnteilProzent} %`,
      `EU-B2B-Verkäufe: ${jn(p.p3.b2bEU)}`,
      `Inland-B2B-Verkäufe: ${jn(p.p3.b2bInland)}`,
    ],
    p4: [
      ...(p.p4.warengruppen.length
        ? p.p4.warengruppen.map(
            (w) =>
              `Warengruppe „${w.name}" (${w.abweichenderSatz ? 'abweichender Steuersatz' : 'Regelsatz'})`,
          )
        : ['Keine Warengruppen erfasst']),
      `Gebrauchtware: ${jn(p.p4.gebrauchtware)}`,
    ],
    p5: p.p5.drittlandImport
      ? [
          `Import aus Drittländern: ${liste(p.p5.laender)}`,
          `Zollabwicklung: ${p.p5.zollabwicklung || '—'}`,
        ]
      : ['Kein Import aus Drittländern'],
    p6: [`Zahlungswege: ${liste(p.p6.zahlungswege, 'keine')}`],
    p7: [
      `Gutscheine: ${jn(p.p7.gutscheine)}`,
      `Abos: ${jn(p.p7.abos)}`,
      `Bundles: ${jn(p.p7.bundles)}`,
    ],
    p8: p.p8.systeme.length
      ? p.p8.systeme.map(
          (s) =>
            `${s.art || 'System'}: ${s.name}${s.version && s.version !== '—' ? ` ${s.version}` : ''}`,
        )
      : ['Keine Systeme erfasst'],
    p9: [
      p.p9.ossSeit ? `OSS seit ${fmtMonatJahr(p.p9.ossSeit)}` : 'Keine OSS-Registrierung',
      `IOSS: ${jn(p.p9.ioss)}`,
      `Lokale USt-Registrierungen: ${liste(p.p9.lokaleUstNr, 'keine')}`,
      `Dauerfristverlängerung: ${jn(p.p9.dauerfrist)}`,
    ],
    p10: [
      `Vorjahresumsatz: ${fmtEurGanz(p.p10.vorjahresumsatzEur)}`,
      `EU-Fernverkäufe Vorjahr: ${fmtEurGanz(p.p10.euFernverkaeufeVorjahrEur)}`,
      `EU-Fernverkäufe laufendes Jahr: ${fmtEurGanz(p.p10.euFernverkaeufeLfdEur)}`,
    ],
    p11: p.p11.vorhanden
      ? [`Ausländische Leistende: ${liste(p.p11.anbieter)}`]
      : ['Keine ausländischen Plattform-, Werbe- oder SaaS-Leistungen'],
    p12: [
      `Buchhaltung: ${p.p12.buchhaltung === 'KANZLEI' ? 'über die Kanzlei' : 'intern beim Mandanten'}`,
    ],
  };
}

export interface FrageDiff {
  key: FrageKey;
  nr: string;
  titel: string;
  neu: string[];
  entfallen: string[];
}

/** Änderungen je Profilfrage (zeilenweise: neu bzw. entfallen). */
export function profilDiff(alt: Geschaeftsprofil, neu: Geschaeftsprofil): FrageDiff[] {
  const a = profilZeilen(alt);
  const b = profilZeilen(neu);
  const out: FrageDiff[] = [];
  for (const f of PROFIL_FRAGEN) {
    const vorher = a[f.key];
    const nachher = b[f.key];
    const neuZ = nachher.filter((z) => !vorher.includes(z));
    const weg = vorher.filter((z) => !nachher.includes(z));
    if (neuZ.length || weg.length)
      out.push({ key: f.key, nr: f.nr, titel: f.titel, neu: neuZ, entfallen: weg });
  }
  return out;
}

/** Stabile Serialisierung (Schlüssel sortiert): JSONB ordnet Schlüssel beim Speichern um. */
function stabil(wert: unknown): string {
  if (wert === null || typeof wert !== 'object') return JSON.stringify(wert ?? null);
  if (Array.isArray(wert)) return `[${wert.map(stabil).join(',')}]`;
  const e = Object.entries(wert as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${e.map(([k, v]) => `${JSON.stringify(k)}:${stabil(v)}`).join(',')}}`;
}

/** Inhaltsgleichheit unabhängig von der Schlüsselreihenfolge (JSONB-Werte, Entwürfe). */
export function inhaltGleich(x: unknown, y: unknown): boolean {
  return stabil(x) === stabil(y);
}

/** Ereignistypen, die eine Profiländerung auslöst (dedupliziert, Reihenfolge P1 → P12). */
export function ereignisseFuerAenderung(
  alt: Geschaeftsprofil,
  neu: Geschaeftsprofil,
): { typ: string; frage: FrageKey; stichwort?: string }[] {
  const out: { typ: string; frage: FrageKey; stichwort?: string }[] = [];
  const add = (typ: string, frage: FrageKey, stichwort?: string) => {
    if (!out.some((o) => o.typ === typ)) out.push({ typ, frage, stichwort });
  };
  const gleich = inhaltGleich;
  if (!gleich(alt.p1, neu.p1)) add('T-01', 'p1');
  if (!gleich(alt.p2, neu.p2)) add('T-02', 'p2');
  if (!gleich(alt.p3.laender, neu.p3.laender)) add('T-03', 'p3', 'Zielländer');
  if (
    alt.p3.b2bEU !== neu.p3.b2bEU ||
    alt.p3.b2bInland !== neu.p3.b2bInland ||
    alt.p3.b2bAnteilProzent !== neu.p3.b2bAnteilProzent
  )
    add('T-09', 'p3', 'B2B');
  if (!gleich(alt.p4, neu.p4)) add('T-05', 'p4');
  if (!gleich(alt.p5, neu.p5)) add('T-10', 'p5');
  if (!gleich(alt.p6, neu.p6)) add('T-06', 'p6');
  if (!gleich(alt.p7, neu.p7)) add('T-08', 'p7');
  if (!gleich(alt.p8, neu.p8)) add('T-07', 'p8');
  if (!gleich(alt.p9.lokaleUstNr, neu.p9.lokaleUstNr)) add('T-02', 'p9', 'Registrierungen');
  if (alt.p9.ossSeit !== neu.p9.ossSeit || alt.p9.ioss !== neu.p9.ioss) add('T-03', 'p9', 'OSS');
  const sAlt = bewerteSchwelle(
    alt.p10.euFernverkaeufeLfdEur,
    alt.p10.euFernverkaeufeVorjahrEur,
  ).status;
  const sNeu = bewerteSchwelle(
    neu.p10.euFernverkaeufeLfdEur,
    neu.p10.euFernverkaeufeVorjahrEur,
  ).status;
  if (sAlt !== sNeu) add('T-04', 'p10');
  // P11 löst kein Ereignis aus (Fachkonzept § 4: „–").
  if (!gleich(alt.p12, neu.p12)) add('T-12', 'p12');
  return out;
}

/**
 * Risiken, deren Grundlage sich durch die Profiländerung ändert:
 * (a) Neubewertungsfolgen der ausgelösten Ereignistypen (§ 7),
 * (b) aktive Risiken, deren Vorschlagsgrund sich ändert oder die nicht mehr vorgeschlagen werden.
 */
export function neuZuBewerten(
  alt: Geschaeftsprofil,
  neu: Geschaeftsprofil,
  aktiveCodes: readonly string[],
): Map<string, string> {
  const out = new Map<string, string>();
  const aktiv = new Set(aktiveCodes);
  for (const { typ } of ereignisseFuerAenderung(alt, neu)) {
    for (const f of ereignistyp(typ)?.folgen ?? []) {
      if (f.art === 'RISIKO_NEU_BEWERTEN' && f.ziel && aktiv.has(f.ziel) && !out.has(f.ziel))
        out.set(f.ziel, `${typ} sieht eine Neubewertung vor`);
    }
  }
  const vAlt = new Map(schlageRisikenVor(alt).map((v) => [v.code, v.grund]));
  const vNeu = new Map(schlageRisikenVor(neu).map((v) => [v.code, v.grund]));
  for (const code of aktiv) {
    if (out.has(code)) continue;
    const g1 = vAlt.get(code);
    const g2 = vNeu.get(code);
    if (g1 === g2) continue;
    out.set(code, g2 ? `Vorschlagsgrund geändert: ${g2}` : 'laut Profil nicht mehr vorgeschlagen');
  }
  return out;
}

export function gleichesProfil(a: Geschaeftsprofil, b: Geschaeftsprofil): boolean {
  return profilDiff(a, b).length === 0;
}
