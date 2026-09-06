import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { portalAuth } from '@/server/auth/portal';
import { readPortalFeatures } from '@/server/settings/portal-features';
import { InboxComposer } from '../composer';

export default async function NewPortalInboxThreadPage() {
  const session = await portalAuth();
  if (!session?.user) redirect('/portal/login');
  const { tenantId, contactId } = session.user;
  const features = await readPortalFeatures({
    tenantId,
    actorId: contactId,
    actorType: 'CLIENT_CONTACT',
  });
  if (!features.clientInbox) notFound();

  return (
    <main className="p-4 sm:p-8">
      <Link
        href="/portal/inbox"
        className="mb-5 inline-flex items-center gap-2 text-sm text-brand-700 hover:underline"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Zurück zu Nachrichten
      </Link>
      <div className="mx-auto max-w-3xl">
        <h1 className="text-2xl font-bold text-primary">Nachricht an Kanzlei</h1>
        <p className="mb-6 mt-1 text-sm text-muted">
          Für ein weiteres Anliegen beginnen Sie später einfach einen neuen Verlauf.
        </p>
        <section className="card p-5 sm:p-6">
          <InboxComposer mode={{ kind: 'new' }} allowAttachments={features.documentUpload} />
        </section>
      </div>
    </main>
  );
}
