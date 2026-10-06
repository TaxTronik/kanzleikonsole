import { requireStaffPage } from '@/server/auth/staff-page';
import { withTenantContext } from '@taxtronik/db';
import { redirect } from 'next/navigation';
import type { ClientKind } from '@prisma/client';
import { accessibleClientsWhereFor, canAccessClientTx } from '@/server/auth/rbac';
import { MANAGED_DOC_SELECT, toManagedDoc } from '@/server/documents/managed-docs';
import { DocumentExplorer, type Entry, type Crumb } from '@/components/document-explorer';

const KIND_LABEL: Record<string, string> = {
  NATPERS: 'Natürliche Personen',
  JURPERS: 'Juristische Personen',
  PERSGES: 'Personengesellschaften',
  INTERNAL: 'Kanzlei-intern',
};

interface Search {
  type?: string;
  client?: string;
  folder?: string;
  q?: string;
  deleted?: string;
}

const isKind = (s: string | undefined): s is ClientKind =>
  s === 'NATPERS' || s === 'JURPERS' || s === 'PERSGES';

// P-3: Lade-Cap pro Ordner-/Such-Ansicht — vorher wurden ALLE Treffer geladen
// und als Client-Props serialisiert; bei Erreichen zeigt der Explorer einen
// Truncation-Hinweis (truncated/totalCount).
const DOCS_CAP = 1000;

export default async function DocumentsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const session = await requireStaffPage();
  const { tenantId, staffId } = session.user;
  const sp = await searchParams;

  const deleted = sp.deleted === '1';
  const q = (sp.q ?? '').trim();
  const typeParam = sp.type;
  const clientId = sp.client && /^[0-9a-f-]{36}$/i.test(sp.client) ? sp.client : undefined;
  const folderId = sp.folder && /^[0-9a-f-]{36}$/i.test(sp.folder) ? sp.folder : undefined;

  const base = (params: Record<string, string | undefined>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) u.set(k, v);
    const s = u.toString();
    return s ? `/staff/documents?${s}` : '/staff/documents';
  };

  // ---- Root: Mandantentypen + Kanzlei-intern ----
  if (!typeParam) {
    const entries: Entry[] = [
      ...(['NATPERS', 'JURPERS', 'PERSGES'] as const).map((k) => ({
        kind: 'nav' as const,
        id: k,
        name: KIND_LABEL[k] ?? k,
        href: base({ type: k }),
        icon: 'kind' as const,
      })),
      {
        kind: 'nav',
        id: 'INTERNAL',
        name: KIND_LABEL.INTERNAL ?? 'Kanzlei-intern',
        href: base({ type: 'INTERNAL' }),
        icon: 'internal',
      },
    ];
    return (
      <DocumentExplorer
        variant="browser"
        crumbs={[{ label: 'Dokumente', href: '/staff/documents' }]}
        entries={entries}
        scope={null}
        folders={[]}
        currentFolderId={null}
        deleted={false}
        q=""
      />
    );
  }

  // ---- Mandantentyp-Ebene: Mandanten dieses Typs auflisten ----
  if (isKind(typeParam) && !clientId) {
    const clients = await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      async (tx) => {
        // Gesperrte/vertrauliche Mandanten (bzw. im RESTRICTED-Modus alle nicht
        // zugeordneten) aus der globalen Liste ausblenden — der Layout-Guard
        // unter clients/[id] greift hier nicht.
        return tx.client.findMany({
          where: { AND: [{ kind: typeParam }, await accessibleClientsWhereFor(tx, session)] },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        });
      },
    );
    const entries: Entry[] = clients.map((c) => ({
      kind: 'nav',
      id: c.id,
      name: c.name,
      href: base({ type: typeParam, client: c.id }),
      icon: 'client',
    }));
    return (
      <DocumentExplorer
        variant="browser"
        crumbs={[
          { label: 'Dokumente', href: '/staff/documents' },
          { label: KIND_LABEL[typeParam] ?? typeParam, href: base({ type: typeParam }) },
        ]}
        entries={entries}
        scope={null}
        folders={[]}
        currentFolderId={null}
        deleted={false}
        q=""
      />
    );
  }

  // ---- Scope-Ebene: ein Mandant oder Kanzlei-intern ----
  const scopeClientId = typeParam === 'INTERNAL' ? null : (clientId ?? null);

  const data = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      // Diese Ansicht liegt nicht unter clients/[id]/layout. Den Scope-Guard
      // deshalb im selben Tenant-Kontext wie den Dokumentabruf auswerten.
      if (scopeClientId && !(await canAccessClientTx(tx, session, scopeClientId))) {
        return null;
      }

      const docWhere = {
        tenantId,
        clientId: scopeClientId,
        folderId: folderId ?? null,
        deletedAt: deleted ? { not: null } : null,
        ...(q ? { title: { contains: q, mode: 'insensitive' as const } } : {}),
      };
      const [clientRow, folders, docs] = await Promise.all([
        scopeClientId
          ? tx.client.findFirst({
              where: { id: scopeClientId },
              select: { name: true, kind: true },
            })
          : Promise.resolve(null),
        tx.documentFolder.findMany({
          where: { tenantId, clientId: scopeClientId },
          select: { id: true, name: true, parentId: true },
          orderBy: { name: 'asc' },
        }),
        tx.document.findMany({
          where: docWhere,
          orderBy: { createdAt: 'desc' },
          take: DOCS_CAP,
          // Dasselbe DTO wie Mandanten-Tab und Aktenregal (server/documents).
          select: MANAGED_DOC_SELECT,
        }),
      ]);
      // Nur wenn der Cap erreicht wurde: Gesamtzahl für den Truncation-Hinweis.
      const docsTotal =
        docs.length === DOCS_CAP ? await tx.document.count({ where: docWhere }) : docs.length;
      return { clientRow, folders, docs, docsTotal };
    },
  );

  if (!data) redirect('/staff/documents');
  const { clientRow, folders, docs, docsTotal } = data;
  const childFolders = folders.filter((f) => (f.parentId ?? null) === (folderId ?? null));

  const entries: Entry[] = [
    ...childFolders.map<Entry>((f) => ({
      kind: 'folder',
      id: f.id,
      name: f.name,
      href: base({
        type: typeParam,
        client: scopeClientId ?? undefined,
        folder: f.id,
      }),
      icon: 'folder',
    })),
    ...docs.map<Entry>((d) => ({ kind: 'file', ...toManagedDoc(d) })),
  ];

  // Breadcrumb inkl. Ordner-Vorfahren
  const crumbs: Crumb[] = [{ label: 'Dokumente', href: '/staff/documents' }];
  if (typeParam === 'INTERNAL') {
    crumbs.push({
      label: KIND_LABEL.INTERNAL ?? 'Kanzlei-intern',
      href: base({ type: 'INTERNAL' }),
    });
  } else {
    const kindKey = clientRow?.kind ?? (isKind(typeParam) ? typeParam : 'NATPERS');
    crumbs.push({ label: KIND_LABEL[kindKey] ?? kindKey, href: base({ type: kindKey }) });
    crumbs.push({
      label: clientRow?.name ?? 'Mandant',
      href: base({ type: kindKey, client: scopeClientId ?? undefined }),
    });
  }
  if (folderId) {
    const chain: { id: string; name: string }[] = [];
    let cur: string | null = folderId;
    let guard = 0;
    while (cur && guard++ < 100) {
      const f = folders.find((x) => x.id === cur);
      if (!f) break;
      chain.unshift({ id: f.id, name: f.name });
      cur = f.parentId;
    }
    for (const c of chain) {
      crumbs.push({
        label: c.name,
        href: base({
          type: typeParam,
          client: scopeClientId ?? undefined,
          folder: c.id,
        }),
      });
    }
  }

  return (
    <DocumentExplorer
      variant="browser"
      crumbs={crumbs}
      entries={entries}
      scope={{ clientId: scopeClientId, typeParam }}
      folders={folders}
      currentFolderId={folderId ?? null}
      deleted={deleted}
      q={q}
      truncated={docsTotal > docs.length}
      totalCount={docsTotal}
      toggleDeletedHref={base({
        type: typeParam,
        client: scopeClientId ?? undefined,
        folder: folderId,
        deleted: deleted ? undefined : '1',
      })}
    />
  );
}
