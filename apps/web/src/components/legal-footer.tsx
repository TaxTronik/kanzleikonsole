import Link from 'next/link';
import type { LegalLinks } from '@/server/settings/legal';

/**
 * Footer mit Impressum + Datenschutzerklärung. Pflicht auf Login-Seiten.
 * Wenn beide Links leer sind, rendert er gar nichts — der Admin hat noch
 * nicht konfiguriert. (Aufgabe der Kanzlei, nicht der Software, die korrekten
 * URLs einzutragen.)
 */
export function LegalFooter({ links }: { links: LegalLinks }) {
  const has = Boolean(links.impressumUrl || links.privacyUrl);
  if (!has) return null;
  return (
    <footer className="mt-6 text-center text-xs text-gray-500 dark:text-gray-400 space-x-4">
      {links.impressumUrl && (
        <Link
          href={links.impressumUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-gray-900 dark:hover:text-gray-100 hover:underline"
        >
          Impressum
        </Link>
      )}
      {links.privacyUrl && (
        <Link
          href={links.privacyUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-gray-900 dark:hover:text-gray-100 hover:underline"
        >
          Datenschutz
        </Link>
      )}
    </footer>
  );
}
