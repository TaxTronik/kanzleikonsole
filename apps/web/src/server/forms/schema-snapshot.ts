import { z } from 'zod';
import type { FormFieldType } from '@prisma/client';

// FORM-SCHEMA-SNAPSHOT-001: a legacy null is never represented as a historical snapshot.
const fieldSchema = z.object({
  id: z.string(),
  key: z.string(),
  label: z.string(),
  type: z.enum([
    'TEXT',
    'TEXTAREA',
    'EMAIL',
    'PHONE',
    'NUMBER',
    'MONEY',
    'DATE',
    'SELECT',
    'MULTISELECT',
    'CHECKBOX',
    'FILE',
    'INFO_TEXT',
  ]),
  required: z.boolean(),
  options: z.unknown().nullable(),
  helpText: z.string().nullable(),
  defaultValue: z.string().nullable(),
  minValue: z.string().nullable(),
  maxValue: z.string().nullable(),
});
const schema = z.object({
  version: z.literal(1),
  name: z.string(),
  description: z.string().nullable(),
  introMd: z.string().nullable(),
  fields: z.array(fieldSchema),
});
export type FrozenFormSchema = z.infer<typeof schema>;

export function readFormSchema<
  T extends {
    name: string;
    description: string | null;
    introMd: string | null;
    fields: Array<{
      id: string;
      key: string;
      label: string;
      type: FormFieldType;
      required: boolean;
      options: unknown;
      helpText: string | null;
      defaultValue: string | null;
      minValue: string | null;
      maxValue: string | null;
    }>;
  },
>(snapshot: unknown, legacyTemplate: T): FrozenFormSchema | T {
  if (snapshot === null || snapshot === undefined) return legacyTemplate;
  return schema.parse(snapshot);
}

export function freezeFormSchema(template: Parameters<typeof readFormSchema>[1]): FrozenFormSchema {
  return schema.parse({ version: 1, ...template });
}
