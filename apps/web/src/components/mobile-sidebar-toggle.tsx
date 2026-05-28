'use client';

import { useState, useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { Menu, X } from 'lucide-react';

/**
 * Hamburger-Toggle für die Sidebar auf <md.
 *
 * Steuert die Sichtbarkeit der `<aside>` über Body-Class `sidebar-open`.
 * CSS in globals.css übernimmt das Verstecken/Anzeigen via media-query.
 */
export function MobileSidebarToggle() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    if (open) {
      document.body.classList.add('sidebar-open');
      document.body.classList.add('overflow-hidden');
    } else {
      document.body.classList.remove('sidebar-open');
      document.body.classList.remove('overflow-hidden');
    }
    return () => {
      document.body.classList.remove('sidebar-open');
      document.body.classList.remove('overflow-hidden');
    };
  }, [open]);

  // Beim Pfadwechsel automatisch schließen
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="md:hidden p-2 -ml-2 text-muted hover:text-primary hover:bg-gray-100 rounded-md"
        aria-label={open ? 'Menü schließen' : 'Menü öffnen'}
      >
        {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
      </button>

      {/* Backdrop, der die Sidebar schließt beim Klick */}
      {open && (
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="md:hidden fixed inset-0 bg-black/40 z-30"
          aria-label="Menü schließen"
        />
      )}
    </>
  );
}
