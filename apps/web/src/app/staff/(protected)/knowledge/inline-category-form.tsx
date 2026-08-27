'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Plus, X } from 'lucide-react';
import { createCategoryAction, type ActionResult } from './actions';

export function InlineCategoryForm({
  categories,
}: {
  categories: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [open, setOpen] = useState(false);
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    createCategoryAction,
    null,
  );

  useEffect(() => {
    if (!state?.ok) return;
    formRef.current?.reset();
    const closeTimer = window.setTimeout(() => setOpen(false), 0);
    router.refresh();
    return () => window.clearTimeout(closeTimer);
  }, [state, router]);

  if (!open) {
    return (
      <button
        type="button"
        className="mt-4 inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline"
        onClick={() => setOpen(true)}
      >
        <Plus className="h-3.5 w-3.5" /> Kategorie anlegen
      </button>
    );
  }

  return (
    <form ref={formRef} action={formAction} className="relative mt-3 flex items-center gap-1.5">
      <input
        id="inline-category-name"
        name="name"
        type="text"
        className="input min-w-0 flex-1 py-1.5 text-xs"
        required
        maxLength={200}
        autoFocus
        placeholder="Kategoriename"
        aria-label="Kategoriename"
      />
      {categories.length > 0 && (
        <select
          id="inline-category-parent"
          name="parentId"
          className="input w-28 shrink-0 py-1.5 text-xs"
          defaultValue=""
          aria-label="Übergeordnete Kategorie"
          title="Übergeordnete Kategorie (optional)"
        >
          <option value="">Hauptebene</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
      )}
      <button
        type="submit"
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
        disabled={isPending}
        aria-label={isPending ? 'Kategorie wird gespeichert' : 'Kategorie anlegen'}
        title="Kategorie anlegen"
      >
        <Check className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-gray-100 hover:text-primary"
        onClick={() => setOpen(false)}
        disabled={isPending}
        aria-label="Kategorieformular schließen"
        title="Abbrechen"
      >
        <X className="h-3.5 w-3.5" />
      </button>
      {state?.error && (
        <p className="absolute left-0 top-full mt-1 text-xs text-red-700">{state.error}</p>
      )}
    </form>
  );
}
