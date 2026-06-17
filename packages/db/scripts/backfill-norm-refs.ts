// =============================================================================
// Backfill: RiskMarking.normRefs aus dem gespeicherten RiskAnalysis.rawResult.
//
// Für Analysen, die VOR iter64 angelegt wurden, ist `normRefs` leer — das
// Norm-Expandable fällt dort auf die reine Zitat-Anzeige zurück. Die Engine hat
// die Norm-IDs aber damals schon geliefert; sie stecken im `rawResult`. Dieses
// Skript extrahiert sie und füllt `normRefs` nach — OHNE erneuten Engine-Lauf,
// ohne Berater-Entscheidungen anzufassen (nur die bisher leere Spalte).
//
// Die Extraktion spiegelt packages/risk-layer/src/mapping.ts (toNormRefs +
// karte/risiko-Begriffsableitung), damit der (start,end,begriff)-Abgleich exakt
// zu den gespeicherten Markierungen passt.
//
// Lauf:  pnpm --filter @taxtronik/db exec tsx scripts/backfill-norm-refs.ts [--dry]
//   --dry  zeigt nur, was geändert würde (kein Schreibzugriff).
//
// DATABASE_URL = Owner-Rolle (BYPASSRLS) → tenant-übergreifend, wie der Seed.
//
// HISTORISCH/erledigt: Seit iter65/66 liegt `rawResult` NICHT mehr in Postgres,
// sondern gzip in SeaweedFS (raw_result_bucket/raw_result_key). Dieses Skript
// hat seinen Zweck erfüllt; ein Re-Run müsste rawResult erst aus dem Object-
// Store holen (fetchRawResult, apps/web/src/server/risk/raw-store.ts).
// =============================================================================

import { Prisma } from '../src/prisma-client';
import { prismaOwner } from '../src/owner-client';

interface NormRef {
  zitat: string;
  id: string | null;
  titel: string | null;
}

/** Mirror von mapping.ts: id ?? ids[0]; titel optional; zitatlose raus. */
function toNormRefs(refs: unknown): NormRef[] {
  if (!Array.isArray(refs)) return [];
  const out: NormRef[] = [];
  for (const r of refs) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const zitat = typeof o['zitat'] === 'string' ? (o['zitat'] as string) : '';
    if (!zitat) continue;
    const id =
      (typeof o['id'] === 'string' ? (o['id'] as string) : null) ??
      (Array.isArray(o['ids']) && typeof o['ids'][0] === 'string' ? (o['ids'][0] as string) : null);
    const titel = typeof o['titel'] === 'string' ? (o['titel'] as string) : null;
    out.push({ zitat, id, titel });
  }
  return out;
}

interface RawEntry {
  start: number;
  end: number;
  begriff: string;
  normRefs: NormRef[];
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Karten + Risiken aus dem rawResult zu (start,end,begriff,normRefs)-Einträgen. */
function entriesFromRaw(raw: unknown): RawEntry[] {
  const root = (raw ?? {}) as Record<string, unknown>;
  const out: RawEntry[] = [];

  for (const k of Array.isArray(root['karten']) ? (root['karten'] as unknown[]) : []) {
    const o = k as Record<string, unknown>;
    const start = num(o['start']);
    const end = num(o['end']);
    if (start === null || end === null) continue;
    const begriff = str(o['begriff']) || str(o['matched_text']);
    out.push({ start, end, begriff, normRefs: toNormRefs(o['norm_anker']) });
  }

  for (const r of Array.isArray(root['risiken']) ? (root['risiken'] as unknown[]) : []) {
    const o = r as Record<string, unknown>;
    const start = num(o['start']);
    const end = num(o['end']);
    if (start === null || end === null) continue;
    const begriff = str(o['titel']) || str(o['matched_text']);
    const na = o['norm_anker'];
    const anker = Array.isArray(na) && na.length > 0 ? na : o['norm_vorschlag'];
    out.push({ start, end, begriff, normRefs: toNormRefs(anker) });
  }

  return out;
}

async function main() {
  const dry = process.argv.includes('--dry');
  // Geteilter Owner-Client (BYPASSRLS) — tenant-übergreifend wie der Seed.
  const prisma = prismaOwner;

  let analyses = 0;
  let scannedMarkings = 0;
  let updated = 0;
  let skippedNoMatch = 0;

  try {
    const all = await prisma.riskAnalysis.findMany({ select: { id: true, rawResult: true } });
    for (const a of all) {
      analyses++;
      const entries = entriesFromRaw(a.rawResult);
      if (entries.length === 0) continue;

      // Primär (start:end:begriff), Fallback (start:end) — jeweils erste mit Refs.
      const byKey = new Map<string, NormRef[]>();
      const byPos = new Map<string, NormRef[]>();
      for (const e of entries) {
        if (e.normRefs.length === 0) continue;
        const k = `${e.start}:${e.end}:${e.begriff}`;
        const p = `${e.start}:${e.end}`;
        if (!byKey.has(k)) byKey.set(k, e.normRefs);
        if (!byPos.has(p)) byPos.set(p, e.normRefs);
      }
      if (byKey.size === 0) continue;

      // Nur Engine-Markierungen ohne bereits gesetzte normRefs.
      const markings = await prisma.riskMarking.findMany({
        where: { analysisId: a.id, herkunft: { not: 'BERATER' }, normRefs: { equals: Prisma.DbNull } },
        select: { id: true, start: true, end: true, begriff: true },
      });
      for (const m of markings) {
        scannedMarkings++;
        const refs =
          byKey.get(`${m.start}:${m.end}:${m.begriff}`) ?? byPos.get(`${m.start}:${m.end}`);
        if (!refs || refs.length === 0) {
          skippedNoMatch++;
          continue;
        }
        updated++;
        if (!dry) {
          await prisma.riskMarking.update({
            where: { id: m.id },
            data: { normRefs: refs as object },
          });
        }
      }
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log('');
  console.log(`  Backfill normRefs ${dry ? '(DRY-RUN — kein Schreibzugriff)' : ''}`);
  console.log(`  Analysen gescannt:        ${analyses}`);
  console.log(`  Markierungen geprüft:     ${scannedMarkings}`);
  console.log(`  ${dry ? 'Würde aktualisieren:' : 'Aktualisiert:       '}      ${updated}`);
  console.log(`  Ohne Norm-Match (übersprungen): ${skippedNoMatch}`);
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
