'use server';

import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { Prisma } from '@prisma/client';
import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'eintrag';
}

const CategorySchema = z.object({
  name: z.string().min(1).max(200),
  parentId: z.string().uuid().optional().or(z.literal('')),
});

export interface ActionResult { ok: boolean; error?: string; }

export async function createCategoryAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  // Kategorien sind Wissensstruktur — Pflege via ADMIN/PARTNER, Artikel können
  // alle Mitarbeiter schreiben.
  if (!isStaffAdmin(session)) return { ok: false, error: 'Nur ADMIN/PARTNER.' };

  const parsed = CategorySchema.safeParse({
    name: formData.get('name'),
    parentId: formData.get('parentId') ?? '',
  });
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const { tenantId, staffId } = session.user;
  const slug = slugify(parsed.data.name);

  await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      // Q-4: parentId muss zum Tenant gehören. RLS filtert Lesepfade, aber
      // der FK akzeptiert jede UUID, die im DB-Cluster existiert — sonst kann
      // ein UI-Bug (oder ein direkter API-Call mit fremder parentId) eine
      // Kategorie unter einer Cross-Tenant-Eltern-Kategorie verankern.
      // Symmetrisch zu M-1.
      if (parsed.data.parentId) {
        const parent = await tx.kbCategory.findFirst({
          where: { id: parsed.data.parentId },
          select: { id: true },
        });
        if (!parent) throw new Error('Übergeordnete Kategorie nicht in diesem Tenant.');
      }
      const cat = await tx.kbCategory.create({
        data: {
          tenantId,
          name: parsed.data.name,
          slug,
          parentId: parsed.data.parentId || null,
        },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'kb.category.create',
        resourceType: 'kb_category',
        resourceId: cat.id,
        after: { name: parsed.data.name, slug },
      });
    },
  );

  revalidatePath('/staff/knowledge');
  return { ok: true };
}

const ArticleSchema = z.object({
  title: z.string().min(1).max(300),
  body: z.string().min(1).max(100000),
  categoryId: z.string().uuid().optional().or(z.literal('')),
  published: z.enum(['1', 'on', 'true']).optional(),
});

export async function createArticleAction(formData: FormData): Promise<void> {
  const session = await staffAuth();
  if (!session?.user) return;

  const parsed = ArticleSchema.safeParse({
    title: formData.get('title'),
    body: formData.get('body'),
    categoryId: formData.get('categoryId') ?? '',
    published: formData.get('published') ?? undefined,
  });
  if (!parsed.success) throw new Error('Validierungsfehler.');

  const { tenantId, staffId } = session.user;
  const baseSlug = slugify(parsed.data.title);
  let slug = baseSlug;

  // Q-6: Optimistischer Insert mit Suffix-Retry bei P2002. Vorher: bis zu 50
  // sequenzielle findUnique-Roundtrips + Race-Lücke zwischen findUnique und
  // create (zwei parallele Creates für denselben Title konnten denselben
  // Suffix picken und einer crashte ungefangen).
  const id = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      // categoryId Tenant-Sanity, falls gesetzt (symmetrisch zu Q-4).
      if (parsed.data.categoryId) {
        const cat = await tx.kbCategory.findFirst({
          where: { id: parsed.data.categoryId },
          select: { id: true },
        });
        if (!cat) throw new Error('Kategorie nicht in diesem Tenant.');
      }
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const article = await tx.kbArticle.create({
            data: {
              tenantId,
              title: parsed.data.title,
              slug,
              body: parsed.data.body,
              categoryId: parsed.data.categoryId || null,
              published: !!parsed.data.published,
              authorId: staffId,
            },
          });
          await evidenceService.record(tx, {
            tenantId,
            actorType: 'STAFF',
            actorId: staffId,
            action: 'kb.article.create',
            resourceType: 'kb_article',
            resourceId: article.id,
            after: { title: parsed.data.title, slug, published: !!parsed.data.published },
          });
          return article.id;
        } catch (err) {
          // P2002 = unique-Constraint. Slug ist hier der einzige unique-Index
          // mit user-input, also kein Mehrdeutigkeits-Problem.
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            slug = `${baseSlug}-${randomBytes(2).toString('hex')}`;
            continue;
          }
          throw err;
        }
      }
      throw new Error('Slug konnte nach mehreren Versuchen nicht eindeutig gemacht werden.');
    },
  );

  revalidatePath('/staff/knowledge');
  redirect(`/staff/knowledge/${id}`);
}

const UpdateArticleSchema = ArticleSchema.extend({ id: z.string().uuid() });

export async function updateArticleAction(formData: FormData): Promise<void> {
  const session = await staffAuth();
  if (!session?.user) return;

  const parsed = UpdateArticleSchema.safeParse({
    id: formData.get('id'),
    title: formData.get('title'),
    body: formData.get('body'),
    categoryId: formData.get('categoryId') ?? '',
    published: formData.get('published') ?? undefined,
  });
  if (!parsed.success) throw new Error('Validierungsfehler.');

  const { tenantId, staffId } = session.user;
  const data = parsed.data;

  await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const before = await tx.kbArticle.findUnique({ where: { id: data.id } });
      if (!before) return;
      const updated = await tx.kbArticle.update({
        where: { id: data.id },
        data: {
          title: data.title,
          body: data.body,
          categoryId: data.categoryId || null,
          published: !!data.published,
        },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'kb.article.update',
        resourceType: 'kb_article',
        resourceId: updated.id,
        before: { title: before.title, published: before.published },
        after: { title: updated.title, published: updated.published },
      });
    },
  );

  revalidatePath('/staff/knowledge');
  revalidatePath(`/staff/knowledge/${data.id}`);
  redirect(`/staff/knowledge/${data.id}`);
}

export async function deleteArticleAction(formData: FormData): Promise<void> {
  const session = await staffAuth();
  if (!session?.user) return;
  if (!isStaffAdmin(session)) return;
  // S2: UUID-Validation.
  const parsed = z.object({ id: z.string().uuid() }).safeParse({ id: formData.get('id') });
  if (!parsed.success) return;
  const { id } = parsed.data;

  const { tenantId, staffId } = session.user;

  await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const before = await tx.kbArticle.findUnique({ where: { id } });
      if (!before) return;
      await tx.kbArticle.delete({ where: { id } });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'kb.article.delete',
        resourceType: 'kb_article',
        resourceId: id,
        before: { title: before.title },
      });
    },
  );

  revalidatePath('/staff/knowledge');
  redirect('/staff/knowledge');
}

export interface SearchHit {
  id: string;
  title: string;
  slug: string;
  snippet: string;
  rank: number;
  categoryName: string | null;
}

/**
 * Defense gegen Stored-XSS (C1): ts_headline escaped die Quelle nicht — es
 * wickelt nur `<mark>` um Treffer. Wenn der Artikel-Body HTML/JS enthält
 * (Markdown-Source darf vieles), würde ein dangerouslySetInnerHTML im
 * Such-Snippet das ausführen.
 *
 * Strategie: das gesamte Snippet HTML-escapen, anschließend nur die
 * literalen `<mark>`/`</mark>`-Marker zurück-konvertieren. Alle anderen
 * `<`/`>`/`&`/`"`/`'`-Vorkommen bleiben escaped.
 */
function sanitizeSearchSnippet(raw: string): string {
  const escaped = raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  return escaped
    .replace(/&lt;mark&gt;/g, '<mark>')
    .replace(/&lt;\/mark&gt;/g, '</mark>');
}

/**
 * Volltextsuche mit ts_rank + ts_headline für Snippet.
 * Query wird per `plainto_tsquery` aus User-Input erzeugt (sicher gegen TS-Syntax-Injection).
 */
export async function searchArticles(query: string): Promise<SearchHit[]> {
  const session = await staffAuth();
  if (!session?.user) return [];
  const q = query.trim();
  if (!q) return [];

  const { tenantId, staffId } = session.user;

  return withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{ id: string; title: string; slug: string; snippet: string; rank: number; category_name: string | null }>
      >`
        SELECT
          a.id,
          a.title,
          a.slug,
          ts_headline(
            'german',
            a.body,
            plainto_tsquery('german', ${q}),
            'StartSel=<mark>, StopSel=</mark>, MaxFragments=2, MaxWords=20, MinWords=8'
          ) AS snippet,
          ts_rank(a.search_vec, plainto_tsquery('german', ${q})) AS rank,
          c.name AS category_name
        FROM kb_article a
        LEFT JOIN kb_category c ON c.id = a.category_id
        WHERE a.published = TRUE
          AND a.search_vec @@ plainto_tsquery('german', ${q})
        ORDER BY rank DESC
        LIMIT 30
      `;
      return rows.map((r) => ({
        id: r.id,
        title: r.title,
        slug: r.slug,
        snippet: sanitizeSearchSnippet(r.snippet),
        rank: r.rank,
        categoryName: r.category_name,
      }));
    },
  );
}
