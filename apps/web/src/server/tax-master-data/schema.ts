import { z } from 'zod';
import { normalizeTaxNumber } from '@/lib/tax-registration';

export const TaxMasterDataSchema = z
  .object({
    vatId: z.string().trim().max(20),
    registrations: z
      .array(
        z
          .object({
            id: z.string().uuid().optional(),
            label: z.string().trim().min(1, 'Bitte eine Bezeichnung angeben.').max(100),
            stateCode: z.string().max(2),
            number: z.string().trim().min(1).max(30),
            taxOfficeName: z.string().trim().max(200),
            isPrimary: z.boolean(),
          })
          .strict(),
      )
      .max(50),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.vatId.startsWith('DE') && !/^DE\d{9}$/.test(data.vatId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['vatId'],
        message: 'Deutsche USt-ID: DE und neun Ziffern.',
      });
    }
    if (
      data.registrations.length > 0 &&
      data.registrations.filter((row) => row.isPrimary).length !== 1
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['registrations'],
        message: 'Genau eine Steuerverbindung muss Standard sein.',
      });
    }
    const numbers = new Set<string>();
    const ids = new Set<string>();
    data.registrations.forEach((row, index) => {
      if (row.id && ids.has(row.id))
        ctx.addIssue({
          code: 'custom',
          path: ['registrations', index],
          message: 'Steuerverbindung doppelt übermittelt.',
        });
      if (row.id) ids.add(row.id);
      try {
        const normalized = normalizeTaxNumber(row.number, row.stateCode);
        if (numbers.has(normalized)) throw new Error('Diese Steuernummer ist bereits enthalten.');
        numbers.add(normalized);
      } catch (error) {
        ctx.addIssue({
          code: 'custom',
          path: ['registrations', index, 'number'],
          message: error instanceof Error ? error.message : 'Ungültige Steuernummer.',
        });
      }
    });
  });

export const TaxChangeRequestSchema = z
  .object({
    version: z.literal(1),
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
    draft: TaxMasterDataSchema,
  })
  .strict();
