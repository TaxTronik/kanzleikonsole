import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { CustomFieldsEditor } from './editor';

export default async function CustomFieldsAdminPage() {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  if (!isStaffAdmin(session)) {
    redirect('/staff/dashboard');
  }
  const { tenantId, staffId } = session.user;

  const fields = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    (tx) =>
      tx.clientCustomFieldDef.findMany({
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      }),
  );

  // Normalize options JSON (Prisma JsonValue) into our typed shape for the editor.
  const initial = fields.map((f) => ({
    id: f.id,
    key: f.key,
    label: f.label,
    type: f.type as
      | 'TEXT' | 'TEXTAREA' | 'NUMBER' | 'MONEY' | 'DATE' | 'SELECT' | 'CHECKBOX' | 'URL',
    helpText: f.helpText,
    appliesTo: f.appliesTo as Array<'NATPERS' | 'JURPERS' | 'PERSGES'>,
    options:
      Array.isArray(f.options)
        ? (f.options as Array<{ value: string; label: string }>)
        : null,
    active: f.active,
  }));

  return (
    <div className="p-8 max-w-4xl">
      <Link
        href="/staff/admin"
        className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 mb-3"
      >
        <ArrowLeft className="h-3 w-3" />
        Administration
      </Link>
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Mandanten-Custom-Felder</h1>
      <p className="text-gray-500 text-sm mb-6">
        Definieren Sie eigene Felder (z. B. „Branche", „Mitarbeiteranzahl"),
        die zusätzlich zu den Standard-Stammdaten am Mandanten erscheinen.
        Pro Mandantentyp einschränkbar.
      </p>

      <CustomFieldsEditor initial={initial} />
    </div>
  );
}
