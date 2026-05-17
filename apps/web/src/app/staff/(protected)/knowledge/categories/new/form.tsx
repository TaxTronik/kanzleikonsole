'use client';

import { useActionState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createCategoryAction, type ActionResult } from '../../actions';

export function CategoryForm({ categories }: { categories: Array<{ id: string; name: string }> }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    createCategoryAction,
    null,
  );

  useEffect(() => {
    if (state?.ok) {
      formRef.current?.reset();
      router.push('/staff/knowledge');
    }
  }, [state, router]);

  return (
    <form ref={formRef} action={formAction} className="space-y-3">
      <div>
        <label className="label" htmlFor="name">Name</label>
        <input id="name" name="name" type="text" className="input" required maxLength={200} />
      </div>

      <div>
        <label className="label" htmlFor="parentId">Übergeordnete Kategorie (optional)</label>
        <select id="parentId" name="parentId" className="input" defaultValue="">
          <option value="">— keine —</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>

      {state?.error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{state.error}</div>
      )}

      <button type="submit" className="btn-primary" disabled={isPending}>
        {isPending ? 'Speichert…' : 'Anlegen'}
      </button>
    </form>
  );
}
