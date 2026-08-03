import { loadPoaForSigning } from '@/app/staff/(protected)/poa/sign-actions';
import { renderMarkdown } from '@/lib/markdown';
import { SignFlow } from './sign-flow';
import { fmtDateShort } from '@/lib/fmt';

export default async function PoaSignPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const sp = await searchParams;
  const token = sp.token ?? '';
  const result = await loadPoaForSigning(token);

  if (!result.ok) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface-page p-4">
        <div className="card p-8 max-w-md w-full text-center">
          <div className="text-3xl font-bold text-brand-700 mb-1">TaxTronik</div>
          <p className="text-sm text-muted mb-6">Vollmacht-Unterschrift</p>
          <div className="rounded-md bg-red-50 p-4 text-sm text-red-700">{result.error}</div>
        </div>
      </div>
    );
  }

  const { poa, tenantName } = result;
  const html = renderMarkdown(poa.scope);

  return (
    <div className="min-h-screen bg-surface-page py-12 px-4">
      <div className="max-w-3xl mx-auto">
        <div className="text-center mb-8">
          <div className="text-3xl font-bold text-brand-700 mb-1">TaxTronik</div>
          <p className="text-sm text-muted">
            {tenantName} — Vollmacht zur elektronischen Unterschrift
          </p>
        </div>

        <div className="card p-8 mb-6">
          <h1 className="text-2xl font-bold text-primary mb-1">{poa.subject}</h1>
          <p className="text-sm text-muted mb-6">
            Unterzeichner: {poa.signerName} ({poa.signerEmail})
          </p>

          <div className="grid grid-cols-2 gap-4 mb-6">
            <div className="bg-gray-50 rounded-md p-3">
              <p className="eyebrow">Gültig ab</p>
              <p className="text-sm font-medium">{fmtDateShort(poa.validFrom)}</p>
            </div>
            <div className="bg-gray-50 rounded-md p-3">
              <p className="eyebrow">Gültig bis</p>
              <p className="text-sm font-medium">
                {poa.validUntil ? fmtDateShort(poa.validUntil) : 'unbefristet'}
              </p>
            </div>
          </div>

          <h2 className="text-sm font-medium text-muted uppercase tracking-wide mb-3">
            Vollmachtsumfang
          </h2>
          {poa.documentId ? (
            // Extern hinterlegtes PDF: der Vollmachtstext steht im Dokument. Der
            // Unterzeichner muss exakt den beim Versand gebundenen Inhalt vor
            // der Bestätigung ansehen können.
            <div className="mb-6 rounded-md border border-default bg-gray-50 p-4">
              <p className="text-sm text-secondary mb-3">
                Der vollständige Vollmachtstext befindet sich im verknüpften PDF-Dokument. Bitte
                sehen Sie es vor der Unterschrift an.
              </p>
              <a
                href={`/poa/sign/document?token=${encodeURIComponent(token)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-secondary inline-flex items-center gap-2"
              >
                Zu unterzeichnendes Dokument (PDF) ansehen
              </a>
            </div>
          ) : (
            <div
              className="prose prose-sm max-w-none [&_h1]:text-xl [&_h1]:font-bold [&_h2]:text-lg [&_h2]:font-semibold [&_p]:my-3 [&_ul]:list-disc [&_ul]:ml-6 mb-6"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )}
        </div>

        <SignFlow token={token} signerEmail={poa.signerEmail} />
      </div>
    </div>
  );
}
