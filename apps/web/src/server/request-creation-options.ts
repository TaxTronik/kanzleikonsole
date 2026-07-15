import type { TxClient } from '@taxtronik/db';

/**
 * Loads the bounded request-creation catalog without ever dropping a form
 * referenced by one of the visible request templates. The separate legacy
 * queries could otherwise leave the select without the hidden selected value.
 */
export async function readRequestCreationOptionsTx(tx: TxClient, cap = 100) {
  const [rawTemplates, rawFormTemplates] = await Promise.all([
    tx.requestTemplate.findMany({
      where: {
        active: true,
        OR: [{ formTemplateId: null }, { formTemplate: { active: true } }],
      },
      orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
      take: cap + 1,
      select: {
        id: true,
        name: true,
        category: true,
        title: true,
        description: true,
        priority: true,
        dueAfterDays: true,
        formTemplateId: true,
      },
    }),
    tx.formTemplate.findMany({
      where: { active: true },
      orderBy: { name: 'asc' },
      take: cap + 1,
      select: { id: true, name: true },
    }),
  ]);

  const templates = rawTemplates.slice(0, cap);
  const baseFormTemplates = rawFormTemplates.slice(0, cap);
  const baseIds = new Set(baseFormTemplates.map((template) => template.id));
  const missingReferencedIds = [
    ...new Set(
      templates
        .map((template) => template.formTemplateId)
        .filter((id): id is string => id !== null && !baseIds.has(id)),
    ),
  ];
  const referencedFormTemplates =
    missingReferencedIds.length === 0
      ? []
      : await tx.formTemplate.findMany({
          where: { id: { in: missingReferencedIds }, active: true },
          select: { id: true, name: true },
        });

  return {
    requestTemplates: templates,
    templatesLimited: rawTemplates.length > cap,
    requestFormTemplates: [...baseFormTemplates, ...referencedFormTemplates].sort((a, b) =>
      a.name.localeCompare(b.name, 'de'),
    ),
    formTemplatesLimited: rawFormTemplates.length > cap,
  };
}
