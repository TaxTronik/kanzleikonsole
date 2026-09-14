'use client';

// =============================================================================
// Zuletzt besuchte Mandanten — IDs pro Kanzlei und Mitarbeiter im Browser.
//
// `RecordClientVisit` (auf der Mandanten-Detailseite gemountet) schreibt den
// Besuch; `RecentClients` (auf der Mandantenliste) zeigt die letzten als Chips.
// Namen und Sichtbarkeit stammen ausschließlich aus der aktuellen Serverliste.
// Ein früherer Besuch ist keine Zugriffsberechtigung.
// =============================================================================

import { useEffect } from 'react';
import { readBrowserStorage, useBrowserStorage, writeBrowserStorage } from './use-browser-storage';
import Link from 'next/link';
import { Clock } from 'lucide-react';

const LEGACY_STORAGE_KEY = 'taxtronik:recent-clients';
const MAX_RECENT = 8;

interface ClientVisitScope {
  tenantId: string;
  staffId: string;
}

interface RecentClient {
  id: string;
  name: string;
}

function storageKey({ tenantId, staffId }: ClientVisitScope): string {
  return `${LEGACY_STORAGE_KEY}:v2:${JSON.stringify([tenantId, staffId])}`;
}

function readRecent(raw: string | null): string[] {
  try {
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return [
      ...new Set(parsed.filter((id): id is string => typeof id === 'string' && id !== '')),
    ].slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

function useDiscardLegacyVisits(): void {
  useEffect(() => {
    // Der alte Speicher enthält Namen ohne verlässliche Kontozuordnung.
    // Nicht übernehmen; auch noch offene Tabs über den leeren Stand informieren.
    if (readBrowserStorage(LEGACY_STORAGE_KEY) !== null) {
      writeBrowserStorage(LEGACY_STORAGE_KEY, '[]');
    }
  }, []);
}

/** Unsichtbar — protokolliert den Besuch eines Mandanten beim Mounten. */
export function RecordClientVisit({
  id,
  tenantId,
  staffId,
}: ClientVisitScope & { id: string }): null {
  const key = storageKey({ tenantId, staffId });
  useDiscardLegacyVisits();
  useEffect(() => {
    const current = readRecent(readBrowserStorage(key)).filter((recentId) => recentId !== id);
    writeBrowserStorage(key, JSON.stringify([id, ...current].slice(0, MAX_RECENT)));
  }, [id, key]);
  return null;
}

/** Chip-Leiste der zuletzt besuchten Mandanten (ohne den aktuell offenen). */
export function RecentClients({
  tenantId,
  staffId,
  clients,
  excludeId,
}: ClientVisitScope & { clients: readonly RecentClient[]; excludeId?: string }) {
  const recent = readRecent(useBrowserStorage(storageKey({ tenantId, staffId })));
  useDiscardLegacyVisits();

  const visible = new Map(clients.map((client) => [client.id, client]));
  const shown = recent.flatMap((id) => {
    const client = visible.get(id);
    return client && id !== excludeId ? [client] : [];
  });
  if (shown.length === 0) return null;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="inline-flex items-center gap-1 text-xs text-disabled">
        <Clock className="h-3.5 w-3.5" /> Zuletzt:
      </span>
      {shown.map((c) => (
        <Link
          key={c.id}
          href={`/staff/clients/${c.id}`}
          className="text-xs px-2 py-1 rounded-md border border-default bg-surface hover:bg-gray-50 text-secondary hover:text-primary truncate max-w-[12rem]"
        >
          {c.name}
        </Link>
      ))}
    </div>
  );
}
