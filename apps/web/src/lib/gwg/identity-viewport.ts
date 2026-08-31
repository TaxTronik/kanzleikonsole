import { z } from 'zod';

/** GWG-IDENTIFICATION-EVIDENCE-001: coordinates refer to the untouched source page. */
export const IdentityViewportSchema = z
  .object({
    side: z.enum(['front', 'back']),
    versionId: z.string().uuid(),
    page: z.number().int().min(1).max(100),
    x: z.number().finite().min(0).max(1),
    y: z.number().finite().min(0).max(1),
    width: z.number().finite().positive().max(1),
    height: z.number().finite().positive().max(1),
    rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
  })
  .superRefine((view, ctx) => {
    if (view.x + view.width > 1.000001 || view.y + view.height > 1.000001) {
      ctx.addIssue({
        code: 'custom',
        message: 'Der Ausschnitt liegt außerhalb der Originalseite.',
      });
    }
  });
export type IdentityViewport = z.infer<typeof IdentityViewportSchema>;
export const IdentityViewportsSchema = z.array(IdentityViewportSchema).max(2);
export type IdentitySourceView = IdentityViewport & { documentId: string };
export const IdentitySourceViewsSchema = z
  .array(IdentityViewportSchema.safeExtend({ documentId: z.string().uuid() }))
  .max(2)
  .superRefine((views, ctx) => {
    if (new Set(views.map((view) => view.side)).size !== views.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'Jede Ausweisseite darf nur einmal gewählt werden.',
      });
    }
  });

export function fullIdentityViewport(versionId: string, side: 'front' | 'back'): IdentityViewport {
  return { versionId, side, page: 1, x: 0, y: 0, width: 1, height: 1, rotation: 0 };
}

export function identityViewports(value: unknown): IdentityViewport[] {
  const parsed = IdentityViewportsSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

/** Sharing a source between the two sides needs two deliberately distinct areas. */
export function distinctIdentityViews(front?: IdentityViewport, back?: IdentityViewport): boolean {
  return (
    !!front &&
    !!back &&
    front.side === 'front' &&
    back.side === 'back' &&
    front.versionId === back.versionId &&
    (front.page !== back.page ||
      front.x !== back.x ||
      front.y !== back.y ||
      front.width !== back.width ||
      front.height !== back.height)
  );
}
