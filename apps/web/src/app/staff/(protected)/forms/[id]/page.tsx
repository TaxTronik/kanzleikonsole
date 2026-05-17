// =============================================================================
// /staff/forms/[id] — Formular-Editor
// =============================================================================

import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { FormEditor } from './editor';

export default async function FormEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  const { id } = await params;
  const { tenantId, staffId } = session.user;

  const tpl = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    (tx) =>
      tx.formTemplate.findUnique({
        where: { id },
        include: { fields: { orderBy: { position: 'asc' } } },
      }),
  );
  if (!tpl) notFound();

  return (
    <div className="p-8 max-w-4xl">
      <Link href="/staff/forms" className="text-sm text-gray-500 hover:text-gray-900 inline-flex items-center gap-1 mb-4">
        <ArrowLeft className="h-4 w-4" /> Zurück zu Vorlagen
      </Link>
      <h1 className="text-2xl font-bold text-gray-900 mb-1">{tpl.name}</h1>
      <p className="text-gray-500 text-sm mb-6">
        Felder definieren und speichern. Bei Versand pro Mandant wird das Formular
        im Portal mit den hier definierten Feldern angezeigt.
      </p>

      <FormEditor
        templateId={tpl.id}
        initialDescription={tpl.description ?? ''}
        initialIntroMd={tpl.introMd ?? ''}
        initialFields={tpl.fields.map((f) => ({
          key: f.key,
          label: f.label,
          type: f.type,
          required: f.required,
          helpText: f.helpText ?? '',
          defaultValue: f.defaultValue ?? '',
          minValue: f.minValue ?? '',
          maxValue: f.maxValue ?? '',
          options: optionsToText(f.options),
        }))}
      />
    </div>
  );
}

function optionsToText(opts: unknown): string {
  if (!Array.isArray(opts)) return '';
  return opts
    .map((o) => {
      if (typeof o !== 'object' || o === null) return '';
      const r = o as { value?: unknown; label?: unknown };
      const v = String(r.value ?? '');
      const l = String(r.label ?? r.value ?? '');
      return v === l ? v : `${v}=${l}`;
    })
    .filter(Boolean)
    .join('\n');
}
