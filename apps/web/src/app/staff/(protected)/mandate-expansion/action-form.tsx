'use client';
import { useActionState, useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { ActionResult } from '@/server/actions/types';
export function ActionForm({
  action,
  children,
  className,
}: {
  action: (state: ActionResult | null, form: FormData) => Promise<ActionResult>;
  children: ReactNode;
  className?: string;
}) {
  const [state, submit, pending] = useActionState(action, null);
  const router = useRouter();
  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);
  return (
    <form action={submit} className={className}>
      <fieldset disabled={pending} className="space-y-4">
        {children}
      </fieldset>
      <p role="status" className={state?.ok ? 'text-green-700' : 'text-red-700'}>
        {pending ? 'Wird gespeichert …' : state?.ok ? 'Gespeichert.' : state?.error}
      </p>
    </form>
  );
}
