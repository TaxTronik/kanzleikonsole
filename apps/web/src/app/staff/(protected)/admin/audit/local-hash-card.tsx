import Link from 'next/link';
import { Fingerprint } from 'lucide-react';
import { fmtDateTimeSeconds } from '@/lib/fmt';
import type { AuditPageData } from './audit-page-data';

export function LocalHashCard({ head }: { head: AuditPageData['localHead'] }) {
  return (
    <section className="card p-4 min-w-0" aria-labelledby="local-audit-hash-title">
      <div className="flex items-start gap-3">
        <Fingerprint className="h-5 w-5 shrink-0 text-muted mt-0.5" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h2 id="local-audit-hash-title" className="text-sm font-medium text-primary">
            Lokale Hash-Kette
          </h2>
          {head ? (
            <>
              <p className="text-xs text-secondary mt-1">
                Aktuelle Spitze:{' '}
                <Link
                  href={`/staff/admin/audit/${head.id}`}
                  className="text-brand-700 underline underline-offset-2"
                >
                  Audit-ID {String(head.id)}
                </Link>
                {' · '}Ereigniszeit {fmtDateTimeSeconds(head.occurredAt)}
              </p>
              <p className="text-xs text-muted mt-3 mb-1">Gespeicherter SHA-256-Kettenwert</p>
              <code className="block rounded-md border border-default bg-surface-sunken p-3 text-xs text-primary font-mono break-all select-all">
                {Buffer.from(head.thisHash).toString('hex')}
              </code>
              <p className="text-xs text-muted mt-2">
                Vollständige Kanzleikette, unabhängig von Listenfiltern. Die Hashanzeige ersetzt
                keine Integritätsprüfung; deren letzten Stand zeigt der Prüfstatus unten.
              </p>
            </>
          ) : (
            <p className="text-xs text-secondary mt-1">
              Noch keine lokalen Audit-Ereignisse vorhanden. Mit dem ersten Ereignis erscheint hier
              der gespeicherte Kettenwert.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
