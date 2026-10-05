import { NotFoundState } from '@/components/not-found-state';

// Unbekannte Adressen und notFound() außerhalb von Staff-/Portal-Bereich
// (z. B. abgeschaltete Module im Staff-Layout, öffentliche Signaturseiten).
// Ohne diese Datei erschiene Nexts englische Standardseite.
export default function RootNotFound() {
  return (
    <NotFoundState
      layout="page"
      links={[
        { href: '/staff/dashboard', label: 'Zum Kanzlei-Bereich' },
        { href: '/portal/dashboard', label: 'Zum Mandantenportal' },
      ]}
    />
  );
}
