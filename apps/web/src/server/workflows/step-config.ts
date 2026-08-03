// =============================================================================
// Workflow-Schritt-Konfiguration
//
// Jeder Schritt-Typ hat seine eigene Konfig-Struktur, die als JSON in
// `workflow_step.config` (Vorlage) bzw. `workflow_item.config` (Instanz)
// liegt. Hier liegen die Zod-Schemata + ein typsicheres Discriminated-Union.
//
// Konstanten, Labels und Defaults liegen zod-frei in
// `lib/workflow-step-kinds.ts` (Client-Bundle!) und werden hier fuer
// bestehende Server-Importe re-exportiert.
// =============================================================================

import { z } from 'zod';
import { DOCUMENT_CLASSIFICATIONS, type WorkflowStepKind } from '@/lib/workflow-step-kinds';

export {
  DOCUMENT_CLASSIFICATIONS,
  WORKFLOW_STEP_KINDS,
  defaultConfigFor,
  KIND_LABELS,
  KIND_DESCRIPTIONS,
  type DocumentClassification,
  type WorkflowStepKind,
} from '@/lib/workflow-step-kinds';

// -----------------------------------------------------------------------------
// Per-Kind-Schemata
// -----------------------------------------------------------------------------

export const TaskConfig = z.object({}).strict();
export const DocumentUploadConfig = z
  .object({
    expectedClassification: z.enum(DOCUMENT_CLASSIFICATIONS),
  })
  .strict();
export const ClientRequestConfig = z
  .object({
    // Wenn requestTemplateId gesetzt ist, werden Titel/Beschreibung/Priorität
    // zur Laufzeit aus der Vorlage gelesen — die Inline-Felder sind dann nur
    // Fallback für den Fall, dass die Vorlage gelöscht wurde.
    requestTemplateId: z.string().uuid().optional(),
    requestTitle: z.string().max(200).default(''),
    requestDescription: z.string().max(5000).default(''),
    priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).default('NORMAL'),
    dueAfterDays: z.number().int().min(0).max(365).optional(),
  })
  .strict()
  .refine((v) => v.requestTemplateId || v.requestTitle.trim().length > 0, {
    message: 'Vorlage wählen oder Titel angeben.',
  });
export const ClientFormConfig = z
  .object({
    formTemplateId: z.string().uuid(),
    requestTitle: z.string().min(1).max(200).default('Bitte Formular ausfüllen'),
    requestDescription: z.string().max(2000).default(''),
  })
  .strict();
export const ClientEmailConfig = z
  .object({
    // Wenn emailTemplateId gesetzt ist, werden Subject/Body zur Laufzeit aus
    // der Vorlage gelesen. Die Inline-Felder sind dann Fallback.
    emailTemplateId: z.string().uuid().optional(),
    subject: z.string().max(200).default(''),
    bodyMd: z.string().max(10_000).default(''),
  })
  .strict()
  .refine((v) => v.emailTemplateId || (v.subject.trim().length > 0 && v.bodyMd.trim().length > 0), {
    message: 'Vorlage wählen oder Betreff + Text inline angeben.',
  });
export const N8nTriggerConfig = z
  .object({
    payload: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type WorkflowStepConfig =
  | { kind: 'TASK'; config: z.infer<typeof TaskConfig> }
  | { kind: 'DOCUMENT_UPLOAD'; config: z.infer<typeof DocumentUploadConfig> }
  | { kind: 'CLIENT_REQUEST'; config: z.infer<typeof ClientRequestConfig> }
  | { kind: 'CLIENT_FORM'; config: z.infer<typeof ClientFormConfig> }
  | { kind: 'CLIENT_EMAIL'; config: z.infer<typeof ClientEmailConfig> }
  | { kind: 'N8N_TRIGGER'; config: z.infer<typeof N8nTriggerConfig> };

// `satisfies Record<WorkflowStepKind, …>`: haelt die Schema-Tabelle in sync
// mit der Kind-Liste im lib-Modul — ein neuer Kind ohne Schema ist ein Typfehler.
const SCHEMA_BY_KIND = {
  TASK: TaskConfig,
  DOCUMENT_UPLOAD: DocumentUploadConfig,
  CLIENT_REQUEST: ClientRequestConfig,
  CLIENT_FORM: ClientFormConfig,
  CLIENT_EMAIL: ClientEmailConfig,
  N8N_TRIGGER: N8nTriggerConfig,
} as const satisfies Record<WorkflowStepKind, unknown>;

export function parseStepConfig(
  kind: keyof typeof SCHEMA_BY_KIND,
  raw: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const schema = SCHEMA_BY_KIND[kind];
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; '),
    };
  }
  return { ok: true, value: parsed.data };
}
