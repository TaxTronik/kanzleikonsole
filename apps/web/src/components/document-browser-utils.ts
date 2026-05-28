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

export interface Crumb { label: string; href: string }

export type Entry =
  | { kind: 'nav'; id: string; name: string; href: string; icon: 'kind' | 'internal' | 'client' }
  | { kind: 'folder'; id: string; name: string; href: string; icon: 'folder' }
  | {
      kind: 'file'; id: string; name: string; mimeType: string; typeName: string;
      typeId: string | null; tier: 'NONE' | 'GWG' | 'GOBD';
      sizeBytes: number; createdAt: string; deletedAt: string | null;
      shared: boolean;
    };

export interface FolderNode { id: string; name: string; parentId: string | null }

export const TIER_BADGE = { GWG: 'GwG·5J', GOBD: 'GoBD·10J' } as const;

export function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(2)} GB`;
}

export const fmtDate = (iso: string): string =>
  new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' }).format(new Date(iso));

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

/** Nachfahren (inkl. self) — Cycle-Schutz beim Ordner-Verschieben. */
export function descendants(all: FolderNode[], root: string): Set<string> {
  const byParent = new Map<string | null, FolderNode[]>();
  for (const folder of all) byParent.set(folder.parentId, [...(byParent.get(folder.parentId) ?? []), folder]);
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
