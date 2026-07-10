// =============================================================================
// Parser für Addison-BWA-CSV (Format wie DEMODATEN/Addison/BWA/a*.csv)
//
// Aufbau:
//   Zeile 1: Spaltenüberschriften — "Nummer;Bezeichnung;Geschäftsjahr;Ant. 1;
//            Vorjahr;Ant. 1;Abw.;Abw.;Quartal;Ant. 1;Quartal;Ant. 1;Abw.;Abw.;"
//   Zeile 2: Periodenangaben — ";;01.25-12.25;in %;01.24-12.24;in %;in Tsd;in %;
//            10.25-12.25;in %;10.24-12.24;in %;in Tsd;in %;"
//   Zeile 3+: Datenzeilen — "1000;Umsatzerlöse;174869,59;99,70;…"
//
// Decimal: Komma. Header-Spaltentitel werden zur Periodenidentifikation genutzt.
// =============================================================================

export interface ParsedBwaPeriod {
  type: 'YEAR' | 'QUARTER' | 'MONTH';
  periodKey: string; // sortierbar: "2025", "2025-Q4", "2025-12"
  fromDate: Date;
  toDate: Date;
  label: string; // Anzeige: "Geschäftsjahr 2025"
  positions: ParsedBwaPosition[];
}

export interface ParsedBwaPosition {
  number: number;
  label: string;
  amount: number;
  sharePct: number | null;
}

export interface ParsedBwa {
  periods: ParsedBwaPeriod[];
  warnings: string[];
}

function parseGermanDecimal(s: string): number | null {
  const t = s.trim().replace(/\./g, '').replace(',', '.');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parst Headerzelle wie "01.25-12.25" oder "10.25-12.25".
 * Liefert Periodentyp, sortierbaren Schlüssel und Datumsbereich.
 */
function parsePeriodHeader(s: string): {
  type: 'YEAR' | 'QUARTER' | 'MONTH';
  periodKey: string;
  fromDate: Date;
  toDate: Date;
  label: string;
} | null {
  const m = s.match(/^(\d{2})\.(\d{2})-(\d{2})\.(\d{2})$/);
  if (!m) return null;
  const fromMonth = Number(m[1]);
  const fromYy = Number(m[2]);
  const toMonth = Number(m[3]);
  const toYy = Number(m[4]);
  // 2-stellige Jahre: < 70 → 20XX, sonst 19XX
  const fromYear = fromYy < 70 ? 2000 + fromYy : 1900 + fromYy;
  const toYear = toYy < 70 ? 2000 + toYy : 1900 + toYy;

  const fromDate = new Date(Date.UTC(fromYear, fromMonth - 1, 1));
  const lastDay = new Date(Date.UTC(toYear, toMonth, 0)).getUTCDate();
  const toDate = new Date(Date.UTC(toYear, toMonth - 1, lastDay));

  if (fromMonth === 1 && toMonth === 12 && fromYear === toYear) {
    return {
      type: 'YEAR',
      periodKey: String(fromYear),
      fromDate,
      toDate,
      label: `Geschäftsjahr ${fromYear}`,
    };
  }
  // Quartal-Erkennung: Spanne von 3 Monaten
  if (toMonth - fromMonth === 2 && fromYear === toYear) {
    const q = Math.ceil(toMonth / 3);
    return {
      type: 'QUARTER',
      periodKey: `${fromYear}-Q${q}`,
      fromDate,
      toDate,
      label: `Q${q} ${fromYear}`,
    };
  }
  if (fromMonth === toMonth && fromYear === toYear) {
    return {
      type: 'MONTH',
      periodKey: `${fromYear}-${String(fromMonth).padStart(2, '0')}`,
      fromDate,
      toDate,
      label: `${String(fromMonth).padStart(2, '0')}/${fromYear}`,
    };
  }
  return {
    type: 'YEAR',
    periodKey: `${fromYear}-${String(fromMonth).padStart(2, '0')}-${toYear}-${String(toMonth).padStart(2, '0')}`,
    fromDate,
    toDate,
    label: `${String(fromMonth).padStart(2, '0')}/${fromYear} – ${String(toMonth).padStart(2, '0')}/${toYear}`,
  };
}

export function parseAddisonBwaCsv(csv: string): ParsedBwa {
  const lines = csv.split(/\r?\n/);
  const warnings: string[] = [];

  if (lines.length < 3) {
    return { periods: [], warnings: ['Zu wenige Zeilen — keine BWA-Daten erkannt.'] };
  }

  const periodCols = (lines[1] ?? '').split(';');

  // Spalten-Indices der Periodenwerte: jede „Periode" ist eine Datenspalte (€)
  // gefolgt von einer Anteils-Spalte (% — meist „in %"). Wir suchen Spalten,
  // deren periodCols-Eintrag zu parsePeriodHeader passt.
  const periodSpec: Array<{ valueCol: number; shareCol: number | null; meta: ReturnType<typeof parsePeriodHeader>; }> = [];
  for (let i = 0; i < periodCols.length; i++) {
    const m = parsePeriodHeader(periodCols[i] ?? '');
    if (m) {
      const shareCol = (periodCols[i + 1] ?? '').trim().toLowerCase().includes('%') ? i + 1 : null;
      periodSpec.push({ valueCol: i, shareCol, meta: m });
    }
  }

  if (periodSpec.length === 0) {
    return { periods: [], warnings: ['Keine Perioden-Spalten erkannt (z.B. „01.25-12.25").'] };
  }

  // Sammeln: pro Period einen Container
  const periods: ParsedBwaPeriod[] = periodSpec
    .filter((p) => p.meta)
    .map((p) => ({
      type: p.meta!.type,
      periodKey: p.meta!.periodKey,
      fromDate: p.meta!.fromDate,
      toDate: p.meta!.toDate,
      label: p.meta!.label,
      positions: [],
    }));

  // Datenzeilen ab Zeile 3
  for (let li = 2; li < lines.length; li++) {
    const line = lines[li] ?? '';
    if (!line.trim()) continue;
    const cols = line.split(';');
    const numStr = (cols[0] ?? '').trim();
    if (!numStr || !/^\d+$/.test(numStr)) continue;
    const number = Number(numStr);
    const label = (cols[1] ?? '').trim();
    if (!label) continue;

    periodSpec.forEach((spec, pi) => {
      const valueRaw = cols[spec.valueCol] ?? '';
      const amount = parseGermanDecimal(valueRaw);
      if (amount === null) return;
      const shareRaw = spec.shareCol !== null ? cols[spec.shareCol] ?? '' : '';
      const sharePct = spec.shareCol !== null ? parseGermanDecimal(shareRaw) : null;
      periods[pi]!.positions.push({ number, label, amount, sharePct });
    });
  }

  // Perioden ohne Positionen aussortieren
  const filtered = periods.filter((p) => p.positions.length > 0);
  if (filtered.length === 0) {
    warnings.push('Datenzeilen erkannt, aber keine numerischen Werte extrahiert.');
  }

  return { periods: filtered, warnings };
}

/**
 * Liefert KPIs aus den Standardpositionen einer BWA.
 * Versteht sowohl Addison- (1990, 3030, 3150, 3250) als auch DATEV-Nummern
 * (1051 Gesamtleistung, 1100 Personalkosten, 1300 Betriebsergebnis,
 *  1380 Vorläufiges Ergebnis).
 */
export interface BwaKpis {
  revenue: number | null;
  costs: number | null;
  result: number | null;
  /** Ergebnis VOR Ertragsteuern (DATEV 1345 bzw. Betriebsergebnis 1300) —
   *  richtige Bemessungsbasis für die Steuerschätzung (kein Zirkelbezug). */
  resultBeforeTax: number | null;
  resultMargin: number | null;
  personnelCost: number | null;
  personnelRatio: number | null;
}

const ADDISON_REVENUE = 1990;
const ADDISON_COSTS = 3150;
const ADDISON_RESULT = 3250;
const ADDISON_PERSONNEL = 3030;

const DATEV_REVENUE = 1051;       // Gesamtleistung
const DATEV_RESULT = 1380;        // Vorläufiges Ergebnis (nach Steuern)
const DATEV_RESULT_BEFORE_TAX = 1345; // Ergebnis vor Steuern
const DATEV_PERSONNEL = 1100;
const DATEV_OPERATING_RESULT = 1300; // Betriebsergebnis (vor Ertragsteuern)

/**
 * Parst die Addison-Kompakt-CSV (`s*.csv`). Beispiel:
 *
 *   10218 - Kurzfristige Erfolgsrechnung Quartalswerte mit VJ-Vergleich
 *   per Dezember 2025
 *
 *   ;Summe Erlöse;Betriebseinnahmen;Summe Personalkosten;Summe der Kosten;Vorläufiges Ergebnis
 *   Geschäftsjahr 01.25-12.25;175369,59;188115,80;28230,27;105755,96;69004,42
 *   Vorjahr 01.24-12.24;180642,05;187555,84;19842,94;107849,78;66624,91
 *
 * Liefert die gleichen ParsedBwaPeriod-Records wie die Langform — nur mit
 * exakt 5 Standardpositionen pro Periode (1990, 2995, 3030, 3150, 3250).
 */
export function parseAddisonBwaCompactCsv(csv: string): ParsedBwa {
  const warnings: string[] = [];
  // Normalisieren: kann Latin-1-Umlaute enthalten (siehe Demo-Datei)
  const lines = csv.split(/\r?\n/);

  // Header-Zeile mit Spaltennamen suchen (beginnt mit Semikolon)
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.startsWith(';')) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    return { periods: [], warnings: ['Keine Spaltenüberschriften gefunden.'] };
  }

  const headerCols = (lines[headerIdx] ?? '').split(';');
  // Spalten-Mapping per Bezeichnung → BWA-Nummer (analog Lang-CSV)
  const colToNumber: Array<{ col: number; number: number; label: string }> = [];
  for (let i = 0; i < headerCols.length; i++) {
    const raw = (headerCols[i] ?? '').toLowerCase();
    const norm = raw
      .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
      .replace(/[^a-z]/g, '');
    if (norm.includes('summeerl')) colToNumber.push({ col: i, number: ADDISON_REVENUE, label: 'Summe Erlöse' });
    else if (norm.includes('betriebseinnahmen')) colToNumber.push({ col: i, number: 2995, label: 'Betriebseinnahmen' });
    else if (norm.includes('summepersonalkosten')) colToNumber.push({ col: i, number: ADDISON_PERSONNEL, label: 'Personalkosten' });
    else if (norm.includes('summederkosten')) colToNumber.push({ col: i, number: ADDISON_COSTS, label: 'Summe der Kosten' });
    else if (norm.includes('vorlaeufigesergebnis') || norm.includes('vorlergebnis')) {
      colToNumber.push({ col: i, number: ADDISON_RESULT, label: 'Vorläufiges Ergebnis' });
    }
  }
  if (colToNumber.length === 0) {
    return { periods: [], warnings: ['Keine bekannten Spalten erkannt (Summe Erlöse, Personalkosten, …).'] };
  }

  // Periodenzeilen ab headerIdx+1: erste Spalte enthält Label + Periode
  // (z. B. "Geschäftsjahr 01.25-12.25").
  const periods: ParsedBwaPeriod[] = [];
  const PERIOD_RE = /(\d{2}\.\d{2}-\d{2}\.\d{2})/;
  for (let li = headerIdx + 1; li < lines.length; li++) {
    const line = lines[li] ?? '';
    if (!line.trim()) continue;
    const cols = line.split(';');
    const head = (cols[0] ?? '').trim();
    const m = head.match(PERIOD_RE);
    if (!m) continue;
    const meta = parsePeriodHeader(m[1]!);
    if (!meta) continue;
    const positions: ParsedBwaPosition[] = [];
    for (const mapping of colToNumber) {
      const v = parseGermanDecimal(cols[mapping.col] ?? '');
      if (v === null) continue;
      positions.push({ number: mapping.number, label: mapping.label, amount: v, sharePct: null });
    }
    if (positions.length > 0) {
      periods.push({
        type: meta.type,
        periodKey: meta.periodKey,
        fromDate: meta.fromDate,
        toDate: meta.toDate,
        label: meta.label,
        positions,
      });
    }
  }

  if (periods.length === 0) {
    warnings.push('Spalten erkannt, aber keine Periodenzeilen extrahiert.');
  }

  return { periods, warnings };
}

export function computeBwaKpis(positions: Array<{ number: number; amount: number | { toString(): string } }>): BwaKpis {
  const map = new Map<number, number>();
  for (const p of positions) {
    map.set(p.number, typeof p.amount === 'number' ? p.amount : Number(p.amount.toString()));
  }

  const revenue = map.get(ADDISON_REVENUE) ?? map.get(DATEV_REVENUE) ?? null;
  const personnelCost = map.get(ADDISON_PERSONNEL) ?? map.get(DATEV_PERSONNEL) ?? null;
  const result = map.get(ADDISON_RESULT) ?? map.get(DATEV_RESULT) ?? null;
  // Vor-Steuer-Ergebnis: DATEV 1345, sonst Betriebsergebnis 1300 (beide vor
  // Ertragsteuern). Die Addison-Kompaktform ("Kurzfristige Erfolgsrechnung")
  // hat KEINE Ertragsteuerzeile — dort ist das "Vorläufige Ergebnis" (3250)
  // bereits ein Vor-Steuer-Wert und dient als Fallback. Wichtig: DATEV 1380
  // (map(DATEV_RESULT)) ist dagegen NACH Steuern und darf hier NICHT einfließen,
  // sonst würde die Steuerschätzung doppelt abziehen. Nur so vermeidet die
  // Steuerschätzung den Zirkelbezug.
  const resultBeforeTax =
    map.get(DATEV_RESULT_BEFORE_TAX) ??
    map.get(DATEV_OPERATING_RESULT) ??
    map.get(ADDISON_RESULT) ??
    null;

  // Kosten: Addison hat eigene Summenzeile; DATEV nur impliziert über
  // Erlöse - Betriebsergebnis (vereinfachte Annahme).
  let costs: number | null = map.get(ADDISON_COSTS) ?? null;
  if (costs === null && revenue !== null) {
    const opResult = map.get(DATEV_OPERATING_RESULT);
    if (opResult !== undefined) costs = revenue - opResult;
  }

  return {
    revenue,
    costs,
    result,
    resultBeforeTax,
    resultMargin: revenue && result !== null ? result / revenue : null,
    personnelCost,
    personnelRatio: revenue && personnelCost !== null ? personnelCost / revenue : null,
  };
}
