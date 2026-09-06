// =============================================================================
// Anonymisierungsschicht (§ 203 StGB) — bevor irgendetwas TaxTronik Richtung
// n8n verlässt.
//
// Zwei Stufen:
//  1. DETERMINISTISCH (Garantie): bekannte Mandanten-/Kontakt-Entitäten +
//     Kennnummern werden zuverlässig durch stabile Platzhalter ersetzt. Das ist
//     die belastbare Schicht — sie kommt aus den strukturierten Stammdaten.
//  2. HEURISTISCH (best-effort): Firmen-Suffixe, IBAN, Steuernummer, Beträge,
//     Datumsangaben. Imperfekt → die UI hebt diese Treffer in der Vorschau
//     hervor und der Berater prüft/schwärzt vor dem Senden.
//
// `mapping` (Platzhalter→Original) verlässt TaxTronik NIE — es dient nur der
// De-Anonymisierung der n8n-Antwort (`deanonymize`) und wird RLS-geschützt am
// RiskResearchRequest gespeichert.
// =============================================================================

export interface AnonymizeClient {
  name: string;
  datevNo?: string | null;
  addisonNo?: string | null;
  vatId?: string | null;
  street?: string | null;
  postalCode?: string | null;
  city?: string | null;
}

export interface AnonymizeContact {
  fullName: string;
  email?: string | null;
  phone?: string | null;
}

export interface AnonymizeResult {
  /** Anonymisierter Text. */
  text: string;
  /** Platzhalter→Original. NIE an n8n senden. */
  mapping: Record<string, string>;
  /** Platzhalter, die heuristisch (unsicher) eingefügt wurden — UI hebt sie hervor. */
  heuristicHits: string[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const FIRMA_SUFFIX = 'GmbH|gGmbH|AG|KGaA|KG|OHG|GbR|UG|mbH|SE';

// Heuristik-Muster: [Regex, Kategorie].
const HEURISTICS: Array<[RegExp, string]> = [
  // E-Mail-Adressen Dritter (Lieferanten, Gegenseite, Behörden). Kontakt-Mails
  // sind oben bereits deterministisch ersetzt — hier bleibt nur, was NICHT in den
  // Stammdaten steht. E-Mail ist eindeutige PII (§ 203): präzises Muster, kaum
  // Falsch-Positive. Teilt sich den [EMAIL_n]-Namensraum mit Stufe 1 (s. u.).
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, 'EMAIL'],
  // Bindestrich-Firmen wie „M-GmbH", „T-GmbH".
  [new RegExp(`\\b[A-ZÄÖÜ][\\wÄÖÜäöüß]*-(?:${FIRMA_SUFFIX})\\b`, 'g'), 'FIRMA'],
  // Mehrwort-Firmen wie „Mustermann GmbH", „Müller & Co. KG".
  [
    new RegExp(
      `\\b[A-ZÄÖÜ][\\wÄÖÜäöüß&.'-]*(?:\\s+[A-ZÄÖÜ&][\\wÄÖÜäöüß&.'-]*){0,4}\\s+(?:${FIRMA_SUFFIX}(?:\\s*&\\s*Co\\.?\\s*KG)?)\\b`,
      'g',
    ),
    'FIRMA',
  ],
  // IBAN (DE.. + 18–32 Stellen, ggf. mit Leerzeichen).
  [/\b[A-Z]{2}\d{2}(?:[ ]?\d){12,30}\b/g, 'IBAN'],
  // Steuernummer (12/345/67890).
  [/\b\d{2,3}\/\d{3}\/\d{4,5}\b/g, 'STNR'],
  // €-Beträge. Kein trailing \b nach „€" (€ ist kein Wortzeichen).
  [/\b\d{1,3}(?:[.\s]\d{3})*(?:,\d{2})?\s?(?:€|EUR\b|Euro\b)/g, 'BETRAG'],
  // Datum numerisch (1.4.2026) + mit Monatsname.
  [/\b\d{1,2}\.\s?\d{1,2}\.\s?\d{2,4}\b/g, 'DATUM'],
  [
    /\b\d{1,2}\.\s?(?:Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)\s?\d{2,4}\b/g,
    'DATUM',
  ],
];

export function anonymize(
  text: string,
  input: { client: AnonymizeClient; contacts: AnonymizeContact[] },
): AnonymizeResult {
  return createAnonymizer(input)(text);
}

/** RISK-EXTERNAL-ANONYMIZATION-001: One namespace for all fields of one request. */
export function createAnonymizer(input: {
  client: AnonymizeClient;
  contacts: AnonymizeContact[];
}): (text: string) => AnonymizeResult {
  const mapping: Record<string, string> = {};

  // --- Stufe 1: deterministisch -------------------------------------------
  // (original, placeholder, caseInsensitive). Längste Originale zuerst ersetzen,
  // damit Teilstücke (z. B. Mandantenname IN einem Kontaktnamen) nicht zuerst
  // greifen.
  const repl: Array<{ original: string; placeholder: string; ci: boolean }> = [];
  const seen = new Map<string, string>();
  let personN = 0;
  let emailN = 0;
  let telN = 0;

  const add = (
    original: string | null | undefined,
    make: () => string,
    opts: { ci?: boolean; minLen?: number } = {},
  ) => {
    const o = (original ?? '').trim();
    if (!o || o.length < (opts.minLen ?? 1)) return;
    const key = o.toLowerCase();
    if (seen.has(key)) return;
    const ph = make();
    seen.set(key, ph);
    mapping[ph] = o;
    repl.push({ original: o, placeholder: ph, ci: opts.ci ?? true });
  };

  add(input.client.name, () => '[MANDANT]');
  for (const c of input.contacts) {
    add(c.fullName, () => `[PERSON_${++personN}]`);
    add(c.email, () => `[EMAIL_${++emailN}]`);
    add(c.phone, () => `[TEL_${++telN}]`, { ci: false, minLen: 5 });
  }
  add(input.client.vatId, () => '[USTID]');
  // Kurze Zahlen nicht blind ersetzen (würden harmlose Zahlen im Text treffen).
  add(input.client.datevNo, () => '[DATEV_NR]', { ci: false, minLen: 4 });
  add(input.client.addisonNo, () => '[ADDISON_NR]', { ci: false, minLen: 4 });
  add(input.client.street, () => '[STRASSE]');
  add(input.client.city, () => '[ORT]');
  add(input.client.postalCode, () => '[PLZ]', { ci: false, minLen: 4 });

  repl.sort((a, b) => b.original.length - a.original.length);
  // Unicode-bewusste Wortgrenzen (\p{L}\p{N}, u-Flag): ein Original wird nur als
  // GANZES Token ersetzt, nicht als Teilstück. Sonst würde z. B. eine kurze Stadt
  // („Au", „Hof") jedes Vorkommen in „auch"/„Hofladen" zerschießen.
  const TOKEN = '[\\p{L}\\p{N}]';

  // --- Stufe 2: heuristisch ------------------------------------------------
  const heurCount: Record<string, number> = {};
  // Heuristische E-Mails setzen die deterministische [EMAIL_n]-Nummerierung fort,
  // sonst kollidierten die Platzhalter (zwei verschiedene Originale unter einem
  // Schlüssel → kaputter De-Anonymisierungs-Round-Trip).
  heurCount['EMAIL'] = emailN;
  const heurUsed = new Map<string, string>();
  return (text) => {
    let out = text;
    const heuristicHits: string[] = [];
    for (const r of repl) {
      const pattern = `(?<!${TOKEN})(?:${escapeRegExp(r.original)})(?!${TOKEN})`;
      out = out.replace(new RegExp(pattern, r.ci ? 'giu' : 'gu'), r.placeholder);
    }
    for (const [re, cat] of HEURISTICS) {
      out = out.replace(re, (m) => {
        const token = m.trim();
        const key = cat + '::' + token;
        let ph = heurUsed.get(key);
        if (!ph) {
          heurCount[cat] = (heurCount[cat] ?? 0) + 1;
          ph = `[${cat}_${heurCount[cat]}]`;
          heurUsed.set(key, ph);
          mapping[ph] = token;
        }
        heuristicHits.push(ph);
        return ph;
      });
    }
    return { text: out, mapping: { ...mapping }, heuristicHits: [...new Set(heuristicHits)] };
  };
}

/** Macht die Anonymisierung rückgängig (für die n8n-Antwort). */
export function deanonymize(text: string, mapping: Record<string, string>): string {
  const placeholders = Object.keys(mapping)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (placeholders.length === 0) return text;
  // Replace only tokens in the response, never token-shaped text in originals.
  return text.replace(
    new RegExp(placeholders.map(escapeRegExp).join('|'), 'g'),
    (ph) => mapping[ph]!,
  );
}
