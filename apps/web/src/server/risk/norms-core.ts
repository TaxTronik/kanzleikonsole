// =============================================================================
// Reine Norm-Kuratierungs-Logik (KEIN DB-/Container-Import → direkt unit-testbar).
//
// Die von der Engine vorgeschlagenen Rechtsnormen sind NICHT verbindlich. Der
// Berufsträger kuratiert sie: eigene Normen ergänzen (quelle BERATER) und
// Engine-Vorschläge VERWERFEN (soft — bleiben zur Provenienz erhalten, zählen
// aber nicht zur effektiven Normliste). Die Persistenz/Audit-Hülle liegt in
// `norms.ts` (zieht den DB-Barrel); hier nur die testbare Transformation.
// =============================================================================

export type NormQuelle = 'ENGINE' | 'BERATER';

/** Kuratierte Norm-Referenz — die persistierte (volle) Form je normRefs-Eintrag. */
export interface CuratedNormRef {
  zitat: string;
  id: string | null;
  titel: string | null;
  quelle: NormQuelle;
  verworfen: boolean;
}

/** Optimistischer Ziel-Verweis: Index + Zitat-Abgleich gegen die Server-Liste
 *  (verhindert das Mutieren des falschen Eintrags bei zwischenzeitlicher Änderung). */
export interface NormTarget {
  index: number;
  zitat: string;
}

export class NormListChangedError extends Error {
  constructor() {
    super('Die Normliste hat sich geändert — bitte die Markierung neu laden.');
    this.name = 'NormListChangedError';
  }
}

export class InvalidNormError extends Error {
  constructor(message = 'Ungültige Norm.') {
    super(message);
    this.name = 'InvalidNormError';
  }
}

function s(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

/**
 * Normalisiert die gespeicherten `normRefs` (Json) + `normAnker`-Fallback auf
 * `CuratedNormRef[]`. Altdaten/Engine-Einträge ohne `quelle` gelten als ENGINE,
 * ohne `verworfen` als aktiv. Markierungen ohne strukturierte Refs (nur flacher
 * `normAnker`, z. B. manuelle Alt-Markierungen) werden aus den Zitaten erzeugt.
 */
export function readNormRefs(raw: unknown, normAnker: string[]): CuratedNormRef[] {
  if (Array.isArray(raw)) {
    return raw
      .map((e) => e as Record<string, unknown>)
      .map((e) => ({
        zitat: s(e.zitat),
        id: s(e.id),
        titel: s(e.titel),
        quelle: e.quelle === 'BERATER' ? ('BERATER' as const) : ('ENGINE' as const),
        verworfen: e.verworfen === true,
      }))
      .filter((e): e is CuratedNormRef => e.zitat != null);
  }
  // Kein strukturiertes normRefs: aus den flachen Zitaten (Engine/aktiv) ableiten.
  return normAnker
    .map((z) => s(z))
    .filter((z): z is string => z != null)
    .map((zitat) => ({ zitat, id: null, titel: null, quelle: 'ENGINE' as const, verworfen: false }));
}

/** Effektive (nicht verworfene) Zitatliste — dedupliziert, Reihenfolge erhalten. */
export function effectiveAnker(refs: CuratedNormRef[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of refs) {
    if (r.verworfen) continue;
    if (seen.has(r.zitat)) continue;
    seen.add(r.zitat);
    out.push(r.zitat);
  }
  return out;
}

/** Hängt eine Berater-Norm an. Doppelte (gleiches Zitat, nicht verworfen) werden
 *  abgewiesen — sonst sammelt die Liste Duplikate. */
export function applyAddBerater(
  refs: CuratedNormRef[],
  input: { zitat: string; id?: string | null; titel?: string | null },
): CuratedNormRef[] {
  const zitat = s(input.zitat);
  if (!zitat) throw new InvalidNormError('Das Zitat darf nicht leer sein.');
  if (zitat.length > 200) throw new InvalidNormError('Das Zitat ist zu lang (max. 200 Zeichen).');
  if (refs.some((r) => !r.verworfen && r.zitat === zitat)) {
    throw new InvalidNormError('Diese Norm ist bereits hinterlegt.');
  }
  return [...refs, { zitat, id: s(input.id), titel: s(input.titel), quelle: 'BERATER', verworfen: false }];
}

function assertTarget(refs: CuratedNormRef[], t: NormTarget): CuratedNormRef {
  const hit = refs[t.index];
  if (!hit || hit.zitat !== t.zitat) throw new NormListChangedError();
  return hit;
}

/** Setzt das Verwerfen-Flag eines Eintrags (Engine-Vorschlag verwerfen/zurückholen). */
export function applyVerworfen(refs: CuratedNormRef[], t: NormTarget, verworfen: boolean): CuratedNormRef[] {
  assertTarget(refs, t);
  return refs.map((r, i) => (i === t.index ? { ...r, verworfen } : r));
}

/** Entfernt eine Berater-Norm hart (nur eigene Einträge; Engine-Vorschläge werden
 *  stattdessen verworfen, damit die Provenienz erhalten bleibt). */
export function applyRemoveBerater(refs: CuratedNormRef[], t: NormTarget): CuratedNormRef[] {
  const hit = assertTarget(refs, t);
  if (hit.quelle !== 'BERATER') {
    throw new InvalidNormError('Engine-Vorschläge können nur verworfen, nicht gelöscht werden.');
  }
  return refs.filter((_, i) => i !== t.index);
}
