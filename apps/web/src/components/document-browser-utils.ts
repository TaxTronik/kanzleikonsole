import { fmtDateMedium } from '@/lib/fmt';
import type { DocumentBulkResult } from '@/server/documents/document-bulk';
import type { ManagedDoc } from '@/server/documents/managed-docs';
export { fmtBytes } from '@/lib/fmt';
import {
  Building2,
  File as FileIcon,
  FileImage,
  FileSpreadsheet,
  FileText,
  Lock,
  Users,
  type LucideIcon,
} from 'lucide-react';

export interface Crumb {
  label: string;
  href: string;
}

/** Datei-Einträge tragen das gemeinsame Dokument-DTO (server/documents/managed-docs). */
export type Entry =
  | { kind: 'nav'; id: string; name: string; href: string; icon: 'kind' | 'internal' | 'client' }
  | { kind: 'folder'; id: string; name: string; href: string; icon: 'folder' }
  | ({ kind: 'file' } & ManagedDoc);

/** Anzeigename eines Eintrags (Dateien: Dokumenttitel). */
export function entryLabel(entry: Entry): string {
  return entry.kind === 'file' ? entry.title : entry.name;
}

export interface FolderNode {
  id: string;
  name: string;
  parentId: string | null;
}

export const TIER_BADGE = { GWG: 'GwG·5J+Prüfung', GOBD: 'GoBD·6/8/10J' } as const;

export const fmtDate = (iso: string): string => fmtDateMedium(new Date(iso));

export function fileIcon(mimeType: string): LucideIcon {
  if (mimeType.startsWith('image/')) return FileImage;
  if (mimeType.includes('spreadsheet') || mimeType.includes('excel') || mimeType.includes('csv')) {
    return FileSpreadsheet;
  }
  if (mimeType === 'application/pdf' || mimeType.startsWith('text/')) return FileText;
  return FileIcon;
}

export const navIcon = (icon: 'kind' | 'internal' | 'client'): LucideIcon =>
  icon === 'internal' ? Lock : icon === 'client' ? Building2 : Users;

/**
 * Meldung zum Ergebnis einer Bulk-Action (P-18: eine Action je Auswahl);
 * null, wenn alles erledigt ist. Bei einem Eintrag die Ablehnung selbst, sonst
 * „N <verb>, M abgelehnt" mit den unterschiedlichen Gründen.
 */
export function bulkResultMessage(
  result: Pick<DocumentBulkResult, 'done' | 'rejected' | 'error'>,
  total: number,
  verb: string,
): string | null {
  if (result.error) return result.error;
  if (result.rejected.length === 0) return null;
  const reasons = [...new Set(result.rejected.map((rejection) => rejection.error))];
  if (total === 1) return reasons[0]!;
  return `${result.done} ${verb}, ${result.rejected.length} abgelehnt:\n${reasons.join('\n')}`;
}

/** Nachfahren (inkl. self) — Cycle-Schutz beim Ordner-Verschieben. */
export function descendants(all: FolderNode[], root: string): Set<string> {
  const byParent = new Map<string | null, FolderNode[]>();
  for (const folder of all)
    byParent.set(folder.parentId, [...(byParent.get(folder.parentId) ?? []), folder]);
  const acc = new Set([root]);
  const stack = [root];
  while (stack.length) {
    const current = stack.pop()!;
    for (const child of byParent.get(current) ?? []) {
      if (!acc.has(child.id)) {
        acc.add(child.id);
        stack.push(child.id);
      }
    }
  }
  return acc;
}
