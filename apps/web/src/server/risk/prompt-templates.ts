// =============================================================================
// Prompt-Vorlagen für Recherche-Aufträge (kanzleiweit, tenant-scoped, RLS).
//
// Der Berater wählt im Composer eine Vorlage (füllt das Prompt-Feld) und kann
// eigene anlegen — geteilt über die ganze Kanzlei. createdById = der anlegende
// Mitarbeiter (reine ID, kein FK).
// =============================================================================

import { withTenantContext, type TenantContext } from '@taxtronik/db';

export interface PromptTemplateDTO {
  id: string;
  title: string;
  body: string;
}

export async function listPromptTemplates(ctx: TenantContext): Promise<PromptTemplateDTO[]> {
  return withTenantContext(ctx, (tx) =>
    tx.riskPromptTemplate.findMany({
      orderBy: { title: 'asc' },
      select: { id: true, title: true, body: true },
    }),
  );
}

export async function createPromptTemplate(
  ctx: TenantContext,
  input: { title: string; body: string },
): Promise<PromptTemplateDTO> {
  return withTenantContext(ctx, (tx) =>
    tx.riskPromptTemplate.create({
      data: {
        tenantId: ctx.tenantId,
        title: input.title,
        body: input.body,
        createdById: ctx.actorId ?? null,
      },
      select: { id: true, title: true, body: true },
    }),
  );
}

/** Löscht eine Vorlage (idempotent, tenant-scoped — RLS + expliziter Filter). */
export async function deletePromptTemplate(ctx: TenantContext, id: string): Promise<void> {
  await withTenantContext(ctx, (tx) =>
    tx.riskPromptTemplate.deleteMany({ where: { id, tenantId: ctx.tenantId } }),
  );
}
