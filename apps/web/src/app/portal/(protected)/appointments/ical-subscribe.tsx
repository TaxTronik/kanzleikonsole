'use client';

import { useState } from 'react';
import { CalendarClock, Copy, Check } from 'lucide-react';

export function IcalSubscribe({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard nicht verfügbar — Nutzer kann die URL manuell markieren.
    }
  }

  return (
    <div className="card p-4 mb-6">
      <h2 className="text-sm font-medium text-primary mb-1 flex items-center gap-2">
        <CalendarClock className="h-4 w-4 text-brand-600" />
        Kalender abonnieren
      </h2>
      <p className="text-xs text-muted mb-3">
        Fügen Sie diesen Link in Outlook, Apple Kalender oder Google Kalender als
        Abo-Kalender hinzu — Ihre Termine und Steuerfristen erscheinen dann
        automatisch und aktualisieren sich. Behandeln Sie den Link wie ein
        Passwort: Wer ihn hat, sieht Ihre Termine.
      </p>
      <div className="flex gap-2">
        <input
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          className="input flex-1 text-xs font-mono"
        />
        <button type="button" onClick={copy} className="btn-secondary text-xs whitespace-nowrap">
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? 'Kopiert' : 'Kopieren'}
        </button>
      </div>
    </div>
  );
}
