// =============================================================================
// Norm-Auflösung: Gesetzestext zu einer Norm-ID laden (für das Norm-Expandable).
//
// Ruft `GET /v1/normgraph/aufloesen?id=norm:KStG:8` und liefert den Gesetzestext
// + Titel/Gesetz/Gültigkeit/Querverweise. Reiner Lese-Zugriff auf öffentliches
// Recht — keine Mandantendaten, daher tenant-unabhängig zwischengespeichert
// (Prozess-lokaler Cache: identische Norm wird nur einmal aus der Engine geholt).
// =============================================================================

import { RiskLayerClient } from '@taxtronik/risk-layer';

/** Minimaler Client-Vertrag für DI/Tests. */
export type NormResolveClient = Pick<RiskLayerClient, 'normgraphAufloesen'>;

export interface ResolvedNorm {
  id: string;
  /** Tatsächlich aufgelöste ID (Engine kann auf eine gröbere Ebene fallen). */
  verwendet: string | null;
  gefunden: boolean;
  titel: string | null;
  law: string | null;
  text: string;
  gueltigAb: string | null;
  /** Norm-IDs, auf die diese Norm verweist (im Korpus vorhanden). */
  verweistAuf: string[];
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function normalize(id: string, raw: Record<string, unknown>): ResolvedNorm {
  const verweise = Array.isArray(raw.verweist_auf)
    ? (raw.verweist_auf as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  return {
    id,
    verwendet: str(raw.verwendet),
    gefunden: raw.gefunden === true,
    titel: str(raw.titel),
    law: str(raw.law),
    text: str(raw.text) ?? '',
    gueltigAb: str(raw.gueltig_ab),
    verweistAuf: verweise,
  };
}

// Gesetzestext ist statisch + öffentlich → Prozess-Cache über alle Tenants. Kappe
// die Größe simpel (Norm-Korpus ist endlich; harte Obergrenze gegen Memory-Leak).
const cache = new Map<string, ResolvedNorm>();
const CACHE_MAX = 1000;

/** Löst eine Norm-ID zu ihrem Gesetzestext auf (gecacht). */
export async function resolveNorm(
  normId: string,
  client?: NormResolveClient,
): Promise<ResolvedNorm> {
  const hit = cache.get(normId);
  if (hit) return hit;

  const c = client ?? new RiskLayerClient();
  const raw = await c.normgraphAufloesen(normId);
  const resolved = normalize(normId, raw);

  // Nur gefundene Normen cachen (Tippfehler/dangling nicht dauerhaft festhalten).
  if (resolved.gefunden) {
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(normId, resolved);
  }
  return resolved;
}

/** Minimaler Client-Vertrag für die Normsuche (DI/Tests). */
export type NormSearchClient = Pick<RiskLayerClient, 'normgraphSuche'>;

/** Ein Normgraph-Suchtreffer: stabile ID + Zitat + Titel. */
export interface NormHit {
  id: string;
  zitat: string;
  titel: string | null;
}

/**
 * Sucht Normen im Normgraph (`GET /v1/normgraph/suche?q=`) — für „eigene Norm
 * ergänzen": der Berater kann ein Freitext-Zitat über die Engine zu einer
 * stabilen Norm-ID + Titel auflösen, damit der Gesetzestext aufklappbar wird.
 * Öffentliches Recht, keine Mandantendaten. Permissiv: kaputte Treffer fallen raus.
 */
export async function searchNorm(query: string, client?: NormSearchClient): Promise<NormHit[]> {
  const c = client ?? new RiskLayerClient();
  const raw = (await c.normgraphSuche(query)) as { treffer?: unknown };
  if (!Array.isArray(raw.treffer)) return [];
  return raw.treffer
    .map((t) => t as Record<string, unknown>)
    .filter((t) => typeof t.id === 'string' && typeof t.zitat === 'string')
    .map((t) => ({
      id: t.id as string,
      zitat: t.zitat as string,
      titel: typeof t.titel === 'string' && t.titel.length > 0 ? (t.titel as string) : null,
    }))
    .slice(0, 12);
}
