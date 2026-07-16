import { fmtDateMedium } from '@/lib/fmt';
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

export type Entry =
  | { kind: 'nav'; id: string; name: string; href: string; icon: 'kind' | 'internal' | 'client' }
  | { kind: 'folder'; id: string; name: string; href: string; icon: 'folder' }
  | {
      kind: 'file';
      id: string;
      name: string;
      mimeType: string;
      typeName: string;
      typeId: string | null;
      tier: 'NONE' | 'GWG' | 'GOBD';
      sizeBytes: number;
      createdAt: string;
      deletedAt: string | null;
      shared: boolean;
    };

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
 * Bulk-Operationen begrenzt parallel ausführen (Chunks à `size`), Fehler
 * einsammeln statt abzubrechen. `fn` liefert eine Fehlermeldung oder null.
 */
export async function runChunked<T>(
  items: T[],
  fn: (item: T) => Promise<string | null>,
  size = 4,
): Promise<string[]> {
  const errs: string[] = [];
  for (let i = 0; i < items.length; i += size) {
    const settled = await Promise.allSettled(items.slice(i, i + size).map(fn));
    for (const r of settled) {
      if (r.status === 'rejected') errs.push('Netzwerkfehler.');
      else if (r.value) errs.push(r.value);
    }
  }
  return errs;
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
