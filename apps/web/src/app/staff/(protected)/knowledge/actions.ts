'use server';

import { z } from 'zod';
import { slugify as slugifyLib } from '@/lib/slugify';
import { randomBytes } from 'node:crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { Prisma } from '@taxtronik/db/prisma-client';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import {
  staffActionGuard,
  withStaffModule,
  ActionError,
  parseFormData,
  type ActionResult as BaseActionResult,
} from '@/server/actions/staff-action';

const withKnowledgeStaff = withStaffModule('knowledge');

export type ActionResult = BaseActionResult;

function slugify(s: string): string {
  return slugifyLib(s, { separator: '-', maxLength: 80 }) || 'eintrag';
}

const CategorySchema = z.object({
  name: z.string().min(1).max(200),
  parentId: z.string().uuid().optional().or(z.literal('')),
});

export async function createCategoryAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = parseFormData(CategorySchema, formData);
  if (!parsed.ok) return parsed;
  const slug = slugify(parsed.data.name);

  // Kategorien sind Wissensstruktur — Pflege via ADMIN/PARTNER, Artikel können
  // alle Mitarbeiter schreiben.
  return withKnowledgeStaff(
    async (tx, { tenantId, staffId }) => {
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
        if (!parent) throw new ActionError('Übergeordnete Kategorie nicht in diesem Tenant.');
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
    { requireAdmin: true, revalidate: '/staff/knowledge' },
  );
}

const AttachmentIdsSchema = z
  .string()
  .max(20_000)
  .optional()
  .default('[]')
  .transform((raw, ctx) => {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Anhangsliste ist ungültig.' });
      return z.NEVER;
    }
  })
  .pipe(z.array(z.string().uuid()).max(50))
  .transform((ids) => [...new Set(ids)]);

const ArticleSchema = z
  .object({
    title: z.string().min(1).max(300),
    body: z.string().min(1).max(100000),
    categoryId: z.string().uuid().optional().or(z.literal('')),
    published: z.enum(['1', 'on', 'true']).optional(),
    attachmentIds: AttachmentIdsSchema,
    attachmentDraftToken: z.string().uuid().optional().or(z.literal('')),
  })
  .superRefine((article, ctx) => {
    if (article.attachmentIds.length > 0 && !article.attachmentDraftToken) {
      ctx.addIssue({
        code: 'custom',
        path: ['attachmentDraftToken'],
        message: 'Anhangszuordnung fehlt.',
      });
    }
  });

export async function createArticleAction(formData: FormData): Promise<void> {
  const g = await staffActionGuard({ module: 'knowledge' });
  if (!g.ok) return;
  const { tenantId, staffId, ctx } = g;

  const parsed = parseFormData(ArticleSchema, formData);
  if (!parsed.ok) throw new ActionError(parsed.error);
  const attachmentDraftToken = parsed.data.attachmentDraftToken;
  if (parsed.data.attachmentIds.length > 0 && !attachmentDraftToken) {
    throw new ActionError('Anhangszuordnung fehlt. Bitte Seite neu laden.');
  }

  const baseSlug = slugify(parsed.data.title);
  let slug = baseSlug;

  // Q-6: Optimistischer Insert mit Suffix-Retry bei P2002. Vorher: bis zu 50
  // sequenzielle findUnique-Roundtrips + Race-Lücke zwischen findUnique und
  // create (zwei parallele Creates für denselben Title konnten denselben
  // Suffix picken und einer crashte ungefangen).
  const id = await withTenantContext(ctx, async (tx) => {
    // categoryId Tenant-Sanity, falls gesetzt (symmetrisch zu Q-4).
    if (parsed.data.categoryId) {
      const cat = await tx.kbCategory.findFirst({
        where: { id: parsed.data.categoryId },
        select: { id: true },
      });
      if (!cat) throw new ActionError('Kategorie nicht in diesem Tenant.');
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
        if (parsed.data.attachmentIds.length > 0) {
          const claimed = await tx.kbAttachment.updateMany({
            where: {
              id: { in: parsed.data.attachmentIds },
              tenantId,
              articleId: null,
              draftToken: attachmentDraftToken,
              uploadedBy: staffId,
            },
            data: { articleId: article.id },
          });
          if (claimed.count !== parsed.data.attachmentIds.length) {
            throw new ActionError(
              'Mindestens ein Anhang gehört nicht zu diesem Artikelentwurf. Bitte Seite neu laden.',
            );
          }
        }
        await evidenceService.record(tx, {
          tenantId,
          actorType: 'STAFF',
          actorId: staffId,
          action: 'kb.article.create',
          resourceType: 'kb_article',
          resourceId: article.id,
          after: {
            title: parsed.data.title,
            slug,
            published: !!parsed.data.published,
            attachmentCount: parsed.data.attachmentIds.length,
          },
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
    throw new ActionError('Slug konnte nach mehreren Versuchen nicht eindeutig gemacht werden.');
  });

  revalidatePath('/staff/knowledge');
  redirect(`/staff/knowledge/${id}`); // wirft (never) — NACH der Tx
}

const UpdateArticleSchema = ArticleSchema.extend({ id: z.string().uuid() });

export async function updateArticleAction(formData: FormData): Promise<void> {
  const g = await staffActionGuard({ module: 'knowledge' });
  if (!g.ok) return;
  const { tenantId, staffId, ctx } = g;

  const parsed = parseFormData(UpdateArticleSchema, formData);
  if (!parsed.ok) throw new ActionError(parsed.error);
  const data = parsed.data;
  const attachmentDraftToken = data.attachmentDraftToken;
  if (data.attachmentIds.length > 0 && !attachmentDraftToken) {
    throw new ActionError('Anhangszuordnung fehlt. Bitte Seite neu laden.');
  }

  await withTenantContext(ctx, async (tx) => {
    const before = await tx.kbArticle.findUnique({ where: { id: data.id } });
    if (!before) return;
    if (data.attachmentIds.length > 0) {
      const attachments = await tx.kbAttachment.findMany({
        where: { id: { in: data.attachmentIds }, tenantId },
        select: { id: true, articleId: true, draftToken: true, uploadedBy: true },
      });
      const valid = attachments.every(
        (attachment) =>
          attachment.articleId === data.id ||
          (attachment.articleId === null &&
            attachment.uploadedBy === staffId &&
            attachment.draftToken === attachmentDraftToken),
      );
      if (attachments.length !== data.attachmentIds.length || !valid) {
        throw new ActionError(
          'Mindestens ein Anhang gehört nicht zu diesem Artikel. Bitte Seite neu laden.',
        );
      }
      await tx.kbAttachment.updateMany({
        where: {
          id: { in: data.attachmentIds },
          tenantId,
          articleId: null,
          draftToken: attachmentDraftToken,
          uploadedBy: staffId,
        },
        data: { articleId: data.id },
      });
    }
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
      after: {
        title: updated.title,
        published: updated.published,
        attachmentCount: data.attachmentIds.length,
      },
    });
  });

  revalidatePath('/staff/knowledge');
  revalidatePath(`/staff/knowledge/${data.id}`);
  redirect(`/staff/knowledge/${data.id}`); // wirft (never) — NACH der Tx
}

export async function deleteArticleAction(formData: FormData): Promise<void> {
  const g = await staffActionGuard({ requireAdmin: true, module: 'knowledge' });
  if (!g.ok) return;
  const { tenantId, staffId, ctx } = g;
  // S2: UUID-Validation.
  const parsed = parseFormData(z.object({ id: z.string().uuid() }), formData);
  if (!parsed.ok) return;
  const { id } = parsed.data;

  await withTenantContext(ctx, async (tx) => {
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
  });

  revalidatePath('/staff/knowledge');
  redirect('/staff/knowledge'); // wirft (never) — NACH der Tx
}

export interface SearchHit {
  id: string;
  title: string;
  slug: string;
  snippet: string;
  rank: number;
  categoryName: string | null;
  authorName: string;
  createdAt: Date;
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
  return escaped.replace(/&lt;mark&gt;/g, '<mark>').replace(/&lt;\/mark&gt;/g, '</mark>');
}

/**
 * Volltextsuche mit ts_rank + ts_headline für Snippet.
 * Query wird per `plainto_tsquery` aus User-Input erzeugt (sicher gegen TS-Syntax-Injection).
 */
export async function searchArticles(query: string): Promise<SearchHit[]> {
  const g = await staffActionGuard({ module: 'knowledge' });
  if (!g.ok) return [];
  const q = query.trim();
  if (!q) return [];

  return withTenantContext(g.ctx, async (tx) => {
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        title: string;
        slug: string;
        snippet: string;
        rank: number;
        category_name: string | null;
        author_name: string;
        created_at: Date;
      }>
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
        c.name AS category_name,
        COALESCE(s.full_name, 'Unbekannter Verfasser') AS author_name,
        a.created_at
      FROM kb_article a
      LEFT JOIN kb_category c ON c.id = a.category_id
      LEFT JOIN staff_user s ON s.id = a.author_id AND s.tenant_id = a.tenant_id
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
      authorName: r.author_name,
      createdAt: r.created_at,
    }));
  });
}
