'use server';

import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { evidenceService } from '@/server/container';
import { assertClientAccessTx } from '@/server/auth/rbac';
import { withStaff, ActionError, type ActionResult } from '@/server/actions/staff-action';

const REVALIDATE = '/staff/admin/custom-fields';

const FIELD_TYPES = [
  'TEXT',
  'TEXTAREA',
  'NUMBER',
  'MONEY',
  'DATE',
  'SELECT',
  'CHECKBOX',
  'URL',
] as const;

const KIND_VALUES = ['NATPERS', 'JURPERS', 'PERSGES'] as const;

const KEY_RE = /^[a-z][a-z0-9_]{1,49}$/;

const SaveSchema = z.object({
  id: z.string().uuid().nullable(),
  key: z.string().regex(KEY_RE, 'Schlüssel: nur a-z, 0-9, _ (Start mit Buchstabe).'),
  label: z.string().min(1).max(120),
  type: z.enum(FIELD_TYPES),
  helpText: z.string().max(300).nullable(),
  appliesTo: z.array(z.enum(KIND_VALUES)),
  options: z.array(z.object({ value: z.string().min(1), label: z.string().min(1) })).nullable(),
  active: z.boolean(),
});

export async function saveFieldDefAction(input: z.infer<typeof SaveSchema>): Promise<ActionResult> {
  const parsed = SaveSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Validierungsfehler.' };
  const data = parsed.data;

  if (data.type === 'SELECT' && (!data.options || data.options.length === 0)) {
    return { ok: false, error: 'SELECT braucht mindestens eine Option.' };
  }

  return withStaff(
    async (tx, { tenantId, staffId }) => {
      if (data.id) {
        // UPDATE — Typ bleibt fest, key auch (vermeidet Daten-Drift)
        const before = await tx.clientCustomFieldDef.findUnique({
          where: { id: data.id },
          select: {
            label: true,
            type: true,
            helpText: true,
            appliesTo: true,
            options: true,
            active: true,
          },
        });
        if (!before) throw new ActionError('Feld nicht gefunden.');
        await tx.clientCustomFieldDef.update({
          where: { id: data.id },
          data: {
            label: data.label,
            helpText: data.helpText,
            appliesTo: data.appliesTo,
            options: (data.options ?? null) as
              | Prisma.NullableJsonNullValueInput
              | Prisma.InputJsonValue,
            active: data.active,
          },
        });
        await evidenceService.record(tx, {
          tenantId,
          actorType: 'STAFF',
          actorId: staffId,
          action: 'client_custom_field.update',
          resourceType: 'client_custom_field_def',
          resourceId: data.id,
          before,
          after: {
            label: data.label,
            helpText: data.helpText,
            appliesTo: data.appliesTo,
            options: data.options,
            active: data.active,
          },
        });
      } else {
        const dup = await tx.clientCustomFieldDef.findFirst({ where: { key: data.key } });
        if (dup) throw new ActionError('Schlüssel bereits vergeben.');
        const last = await tx.clientCustomFieldDef.findFirst({
          orderBy: { position: 'desc' },
          select: { position: true },
        });
        const created = await tx.clientCustomFieldDef.create({
          data: {
            tenantId,
            key: data.key,
            label: data.label,
            type: data.type,
            helpText: data.helpText,
            appliesTo: data.appliesTo,
            options: (data.options ?? null) as
              | Prisma.NullableJsonNullValueInput
              | Prisma.InputJsonValue,
            active: data.active,
            position: (last?.position ?? 0) + 10,
          },
        });
        await evidenceService.record(tx, {
          tenantId,
          actorType: 'STAFF',
          actorId: staffId,
          action: 'client_custom_field.create',
          resourceType: 'client_custom_field_def',
          resourceId: created.id,
          after: {
            key: data.key,
            label: data.label,
            type: data.type,
            appliesTo: data.appliesTo,
            options: data.options,
          },
        });
      }
    },
    { requireAdmin: true, revalidate: REVALIDATE },
  );
}

export async function deleteFieldDefAction(input: { id: string }): Promise<ActionResult> {
  const parsed = z.object({ id: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  return withStaff(
    async (tx, { tenantId, staffId }) => {
      const def = await tx.clientCustomFieldDef.findUnique({ where: { id: parsed.data.id } });
      if (!def) throw new ActionError('Feld nicht gefunden.');
      await tx.clientCustomFieldDef.delete({ where: { id: parsed.data.id } });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'client_custom_field.delete',
        resourceType: 'client_custom_field_def',
        resourceId: parsed.data.id,
        before: { key: def.key, label: def.label, type: def.type },
      });
    },
    { requireAdmin: true, revalidate: REVALIDATE },
  );
}

// ---------------------------------------------------------------------------
// Werte speichern (vom Mandanten-Detail aus aufgerufen) — kein Admin-Zwang.
// ---------------------------------------------------------------------------

const SaveValuesSchema = z.object({
  clientId: z.string().uuid(),
  values: z.record(z.string(), z.unknown()),
});

export async function saveCustomFieldValuesAction(
  input: z.infer<typeof SaveValuesSchema>,
): Promise<ActionResult> {
  const parsed = SaveValuesSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { clientId, values } = parsed.data;

  return withStaff(
    async (tx, { tenantId, staffId, session }) => {
      // Vertraulich-/RESTRICTED-Ventil: die Werte hängen am Mandanten-Detail,
      // die Action ist aber ohne Layout-Guard direkt aufrufbar.
      await assertClientAccessTx(tx, session, clientId);
      const client = await tx.client.findUnique({
        where: { id: clientId },
        select: { kind: true },
      });
      if (!client) throw new ActionError('Mandant nicht gefunden.');

      const defs = await tx.clientCustomFieldDef.findMany({ where: { active: true } });
      const before = await tx.clientCustomFieldValue.findMany({ where: { clientId } });
      const beforeMap = new Map(before.map((b) => [b.fieldId, b.value]));

      // Q-3: Audit-Vorher und -Nachher konsequent nach def.key indizieren.
      // Vorher: before kam aus beforeMap (fieldId-keyed), after war ein
      // direkter Spiegel von `values` — der Auditor konnte sich nicht darauf
      // verlassen, dass keys gleich sind, und Audit-Trails waren mit UUIDs
      // statt menschenlesbaren Field-Keys gespickt. Jetzt: beide Seiten
      // nutzen def.key, gefiltert auf die Felder, die zur Client-Kind
      // tatsächlich gehören und im aktuellen Request berührt werden.
      const auditBefore: Record<string, unknown> = {};
      const auditAfter: Record<string, unknown> = {};

      for (const def of defs) {
        const applies = def.appliesTo.length === 0 || def.appliesTo.includes(client.kind);
        if (!applies) continue;
        if (!(def.id in values)) continue;
        const raw = values[def.id];
        const normalized = normalizeValue(def.type, raw, { options: def.options });
        await tx.clientCustomFieldValue.upsert({
          where: { clientId_fieldId: { clientId, fieldId: def.id } },
          create: {
            tenantId,
            clientId,
            fieldId: def.id,
            value: normalized as Prisma.InputJsonValue,
            updatedBy: staffId,
          },
          update: {
            value: normalized as Prisma.InputJsonValue,
            updatedBy: staffId,
          },
        });
        auditBefore[def.key] = beforeMap.get(def.id) ?? null;
        auditAfter[def.key] = normalized;
      }

      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'client_custom_field.values.update',
        resourceType: 'client',
        resourceId: clientId,
        before: auditBefore,
        after: auditAfter,
      });
    },
    { revalidate: [`/staff/clients/${clientId}`, `/staff/clients/${clientId}/edit`] },
  );
}

// Q-7: typsicheres Normalisieren je Field-Typ. Vorher fiel alles außer
// NUMBER/MONEY/CHECKBOX in den default-Pfad und wurde unverändert als String
// gespeichert — DATE akzeptierte „not-a-date", SELECT akzeptierte Werte
// außerhalb der options-Liste, URL akzeptierte beliebige Strings.
//
// Drittes Argument `def` ist optional, damit das alte Audit/Test-Verhalten
// (nur type) erhalten bleibt; SELECT braucht die options-Liste.
function normalizeValue(
  type: string,
  raw: unknown,
  def?: { options?: Prisma.JsonValue | null },
): unknown {
  if (raw === undefined || raw === null || raw === '') return null;
  switch (type) {
    case 'NUMBER':
    case 'MONEY': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    }
    case 'CHECKBOX':
      return Boolean(raw);
    case 'DATE': {
      // Erwartet ISO-Date „YYYY-MM-DD" (von <input type="date">) oder ISO-DateTime.
      const s = String(raw).trim();
      const d = new Date(s);
      if (Number.isNaN(d.getTime())) return null;
      // Nur den Datumsteil persistieren (keine Zeitzonen-Verzerrung).
      return s.length === 10 && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : d.toISOString().slice(0, 10);
    }
    case 'SELECT': {
      const s = String(raw);
      // options ist JSON — entweder Array von Strings oder Array von
      // {value,label}-Objekten. Nur Werte aus der Liste akzeptieren.
      const opts = def?.options;
      let allowed: string[] = [];
      if (Array.isArray(opts)) {
        allowed = opts
          .map((o) => {
            if (typeof o === 'string') return o;
            if (
              o &&
              typeof o === 'object' &&
              'value' in o &&
              typeof (o as { value: unknown }).value === 'string'
            ) {
              return (o as { value: string }).value;
            }
            return null;
          })
          .filter((v): v is string => v !== null);
      }
      return allowed.includes(s) ? s : null;
    }
    case 'URL': {
      const s = String(raw).trim();
      try {
        const u = new URL(s);
        // Nur http(s) zulassen — javascript:/data: o. ä. würde aus dem UI
        // klickbar werden.
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        return u.toString();
      } catch {
        return null;
      }
    }
    default:
      return String(raw);
  }
}
