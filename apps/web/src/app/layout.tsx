import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { THEME_BOOTSTRAP_JS } from '@/lib/theme';
import { ThemeSync } from '@/components/theme-sync';
import './globals.css';
import './accessible-display.css';

export const metadata: Metadata = {
  title: 'TaxTronik',
  description: 'Kanzlei- und Mandanten-Dashboard',
};

// Alle Routes als dynamic markieren: TaxTronik ist eine on-prem-App mit
// authentifizierten Sessions, jede Page macht entweder Auth-Check oder
// DB-Calls beim Render. Static Generation würde während des Builds eine
// echte DB-Verbindung verlangen (gibt's im Build-Container nicht) und
// hilft uns ohnehin nichts (kein User sieht statische Inhalte).
export const dynamic = 'force-dynamic';

// Anti-FOUC: setzt Theme-/UI-Mode-Klasse VOR dem ersten Paint über ein
// synchrones INLINE-Script im SSR-HTML (eine externe Datei flackert beim
// Refresh kurz hell). Der Script-Inhalt lebt zentral in @/lib/theme
// (THEME_BOOTSTRAP_JS), damit Theme-Logik nicht mehr dreifach divergiert.
//
// WICHTIG: <html> bekommt bewusst KEINE server-gerenderte className.
// Theme (`dark`) und UI-Mode (`ui-modern`) werden ausschließlich imperativ
// per classList gesetzt (Bootstrap-Script + Toggles + ThemeSync). Sobald React
// hier eine dynamische className rendert (früher: ui_mode-Cookie), überschreibt
// der nächste router.refresh() mit abweichendem Cookie-Stand das komplette
// class-Attribut und löscht die imperativ gesetzte dark-Klasse — das war die
// Ursache für „Dark Mode springt zufällig auf hell". Der ui_mode-Cookie bleibt
// als Fallback für das Bootstrap-Script erhalten (localStorage hat Vorrang).
//
// React 19 / Next 16 zeigen fürs Inline-Script im DEV-Mode eine Konsolen-
// Warnung ("Encountered a script tag…"). Bewusst akzeptiert: reine
// Development-Meldung (Production-Build gibt sie nicht aus); das Script läuft
// beim initialen Laden korrekt, bei Client-Navigationen ist das Theme bereits
// gesetzt.

export default async function RootLayout({ children }: { children: ReactNode }) {
  const nonce = (await headers()).get('x-nonce') ?? undefined;

  return (
    <html lang="de" suppressHydrationWarning>
      <head>
        <script
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_JS }}
        />
      </head>
      <body>
        <ThemeSync />
        {children}
      </body>
    </html>
  );
}
