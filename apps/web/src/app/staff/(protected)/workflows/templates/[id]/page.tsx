// =============================================================================
// /staff/workflows/[id] — Vorlagen-Editor
//
// Lädt die Vorlage mit Schritten und reicht sie an die Client-Component
// `TemplateEditor`, die das Drag/Drop und Inline-Editing kapselt.
// =============================================================================

import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { TemplateEditor } from './editor';

export default async function TemplateEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  const { id } = await params;
  const { tenantId, staffId } = session.user;

  const data = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) =>
      Promise.all([
        tx.workflowTemplate.findUnique({
          where: { id },
          include: { steps: { orderBy: { position: 'asc' } } },
        }),
        tx.staffSkill.findMany({
          orderBy: [{ isSystem: 'desc' }, { sortOrder: 'asc' }, { label: 'asc' }],
          select: { id: true, label: true },
        }),
        tx.formTemplate.findMany({
          where: { active: true },
          orderBy: { name: 'asc' },
          select: { id: true, name: true },
        }),
        tx.requestTemplate.findMany({
          where: { active: true },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          select: { id: true, name: true, category: true },
        }),
        tx.emailTemplate.findMany({
          where: { active: true },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          select: { id: true, name: true, category: true },
        }),
      ]),
  );
  const [template, skills, formTemplates, requestTemplates, emailTemplates] = data;
  if (!template) notFound();

  return (
    <div className="p-8 max-w-4xl">
      <Link
        href="/staff/workflows/templates"
        className="text-sm text-gray-500 hover:text-gray-900 inline-flex items-center gap-1 mb-4"
      >
        <ArrowLeft className="h-4 w-4" /> Zurück zu Vorlagen
      </Link>

      <h1 className="text-2xl font-bold text-gray-900 mb-1">{template.name}</h1>
      <p className="text-gray-500 text-sm mb-6">
        Schritte definieren und speichern. Beim Start einer Instanz pro Mandant
        werden die Schritte als ToDo-Liste erzeugt.
      </p>

      <TemplateEditor
        templateId={template.id}
        initialDescription={template.description ?? ''}
        initialDefaultSkillId={template.defaultSkillId ?? ''}
        initialSteps={template.steps.map((s) => ({
          title: s.title,
          description: s.description ?? '',
          dueAfterDays: s.dueAfterDays,
          skillId: s.skillId ?? '',
          kind: s.kind,
          config: (s.config ?? {}) as Record<string, unknown>,
          n8nEvent: s.n8nEvent ?? '',
        }))}
        skills={skills}
        formTemplates={formTemplates}
        requestTemplates={requestTemplates}
        emailTemplates={emailTemplates}
      />
    </div>
  );
}
