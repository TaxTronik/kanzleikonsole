'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
export type PayrollActionResult = {
  ok: boolean;
  error?: string;
  message?: string;
  link?: string;
  pendingId?: string;
};
export function PayrollActionForm({
  action,
  label,
  children,
  resumeId,
}: {
  action: (data: FormData) => Promise<PayrollActionResult>;
  label: string;
  children: React.ReactNode;
  resumeId?: string;
}) {
  const router = useRouter();
  const [result, setResult] = useState<PayrollActionResult | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="space-y-3"
      onSubmit={async (event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        setBusy(true);
        try {
          const next = await action(data);
          setResult(next);
          if (next.ok) router.refresh();
        } catch {
          setResult({ ok: false, error: 'Aktion fehlgeschlagen. Bitte erneut versuchen.' });
        } finally {
          setBusy(false);
        }
      }}
    >
      <input type="hidden" name="resumeId" value={result?.pendingId ?? resumeId ?? ''} />
      {children}
      <button className="btn btn-primary" disabled={busy} type="submit">
        {busy ? 'Wird verarbeitet …' : label}
      </button>
      {result && (
        <div role="status" className={result.ok ? 'text-emerald-700' : 'text-red-700'}>
          {result.error ?? result.message ?? 'Gespeichert.'}
          {result.link && (
            <p>
              <a className="underline break-all" href={result.link}>
                {result.link.startsWith('/payroll/employee')
                  ? 'Persönlicher Arbeitnehmerlink (vertraulich weitergeben)'
                  : 'Ergebnis öffnen'}
              </a>
              {result.link.startsWith('/payroll/employee') && (
                <button
                  className="btn ml-2"
                  type="button"
                  onClick={() =>
                    navigator.clipboard.writeText(
                      new URL(result.link!, window.location.origin).href,
                    )
                  }
                >
                  Link kopieren
                </button>
              )}
            </p>
          )}
        </div>
      )}
    </form>
  );
}
