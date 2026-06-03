// =============================================================================
// GET /api/staff/search?q=...
//
// Globale Suche über Mandanten, Anforderungen, Dokumente, KB-Artikel und
// Rechnungsnummern. Liefert max. 5 Treffer pro Kategorie. Substring-Suche
// (ILIKE) — KB nutzt zusätzlich Postgres-FTS für präzisere Treffer.
// =============================================================================

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';

const QuerySchema = z.object({
  q: z.string().min(1).max(200),
});

export interface SearchResult {
  type: 'client' | 'request' | 'document' | 'kb_article' | 'invoice';
  id: string;
  title: string;
  subtitle?: string;
  href: string;
}

export async function GET(req: NextRequest) {
  const session = await staffAuth();
  if (!session?.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const parsed = QuerySchema.safeParse({ q: req.nextUrl.searchParams.get('q') });
  if (!parsed.success) {
    return NextResponse.json({ results: [] });
  }
  const q = parsed.data.q.trim();
  // %/_/\ sind LIKE-Metazeichen → escapen, damit Suchbegriffe wie „50%" oder
  // „kunde_1" WÖRTLICH matchen (Postgres-Default-Escape ist \). Gilt für die rohe
  // KB-ILIKE UND die Prisma-`contains`-Filter — sonst asymmetrisch (rohes „%"
  // würde im contains alles matchen, parametrisiert → kein SQLi, aber falsch).
  const likeTerm = q.replace(/[%_\\]/g, (m) => `\\${m}`);
  const ilike = `%${likeTerm}%`;
  const { tenantId, staffId } = session.user;

  const results = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const [clients, requests, documents, invoices, kbArticles] = await Promise.all([
        tx.client.findMany({
          where: {
            OR: [
              { name: { contains: likeTerm, mode: 'insensitive' } },
              { datevNo: { contains: likeTerm, mode: 'insensitive' } },
              { addisonNo: { contains: likeTerm, mode: 'insensitive' } },
              { vatId: { contains: likeTerm, mode: 'insensitive' } },
            ],
          },
          select: { id: true, name: true, datevNo: true, addisonNo: true },
          take: 5,
          orderBy: { name: 'asc' },
        }),
        tx.request.findMany({
          where: {
            OR: [
              { title: { contains: likeTerm, mode: 'insensitive' } },
              { description: { contains: likeTerm, mode: 'insensitive' } },
            ],
          },
          select: { id: true, title: true, status: true, client: { select: { name: true } } },
          take: 5,
          orderBy: { createdAt: 'desc' },
        }),
        tx.document.findMany({
          where: { title: { contains: likeTerm, mode: 'insensitive' }, deletedAt: null },
          select: { id: true, title: true, classification: true, client: { select: { name: true } } },
          take: 5,
          orderBy: { createdAt: 'desc' },
        }),
        tx.invoice.findMany({
          where: {
            OR: [
              { number: { contains: likeTerm, mode: 'insensitive' } },
              { subject: { contains: likeTerm, mode: 'insensitive' } },
            ],
          },
          select: {
            id: true,
            number: true,
            subject: true,
            status: true,
            client: { select: { name: true } },
          },
          take: 5,
          orderBy: { issueDate: 'desc' },
        }),
        // KB via FTS
        tx.$queryRaw<Array<{ id: string; title: string; category_name: string | null }>>`
          SELECT a.id, a.title, c.name AS category_name
          FROM kb_article a
          LEFT JOIN kb_category c ON c.id = a.category_id
          WHERE a.published = TRUE
            AND (
              a.search_vec @@ plainto_tsquery('german', ${q})
              OR a.title ILIKE ${ilike}
            )
          ORDER BY ts_rank(a.search_vec, plainto_tsquery('german', ${q})) DESC NULLS LAST,
                   a.updated_at DESC
          LIMIT 5
        `,
      ]);

      const out: SearchResult[] = [];
      for (const c of clients) {
        const idParts = [
          c.datevNo ? `DATEV ${c.datevNo}` : null,
          c.addisonNo ? `Addison ${c.addisonNo}` : null,
        ].filter(Boolean);
        out.push({
          type: 'client',
          id: c.id,
          title: c.name,
          subtitle: idParts.length > 0 ? idParts.join(' · ') : 'Mandant',
          href: `/staff/clients/${c.id}`,
        });
      }
      for (const r of requests) {
        out.push({
          type: 'request',
          id: r.id,
          title: r.title,
          subtitle: `Anforderung · ${r.client.name} · ${r.status}`,
          href: `/staff/requests/${r.id}`,
        });
      }
      for (const i of invoices) {
        out.push({
          type: 'invoice',
          id: i.id,
          title: `${i.number} — ${i.subject}`,
          subtitle: `Rechnung · ${i.client.name} · ${i.status}`,
          href: `/staff/invoices/${i.id}`,
        });
      }
      for (const d of documents) {
        out.push({
          type: 'document',
          id: d.id,
          title: d.title,
          subtitle: `Dokument · ${d.client?.name ?? 'kein Mandant'} · ${d.classification}`,
          href: `/staff/documents`,
        });
      }
      for (const a of kbArticles) {
        out.push({
          type: 'kb_article',
          id: a.id,
          title: a.title,
          subtitle: `Wissensartikel${a.category_name ? ` · ${a.category_name}` : ''}`,
          href: `/staff/knowledge/${a.id}`,
        });
      }
      return out;
    },
  );

  return NextResponse.json({ count: results.length, results });
}
