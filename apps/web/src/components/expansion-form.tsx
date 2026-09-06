'use client';
import { useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
export function ExpansionForm({
  action,
  children,
  label,
}: {
  action: (data: FormData) => Promise<{ ok: boolean; error?: string }>;
  children: ReactNode;
  label: string;
}) {
  const [message, setMessage] = useState('');
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        start(async () => {
          try {
            const r = await action(data);
            setMessage(r.ok ? 'Gespeichert.' : (r.error ?? 'Aktion fehlgeschlagen.'));
            if (r.ok) router.refresh();
          } catch {
            setMessage('Aktion fehlgeschlagen. Bitte erneut laden.');
          }
        });
      }}
    >
      {children}
      <button className="btn-primary" disabled={pending}>
        {pending ? 'Wird gespeichert…' : label}
      </button>
      <p role="status" className="text-sm">
        {message}
      </p>
    </form>
  );
}
