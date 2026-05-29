'use client';

import { useState } from 'react';
import { Copy, Check } from 'lucide-react';

/** Read-only Textfeld mit Kopieren-Button (für Links, Tokens etc.). */
export function CopyField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard nicht verfügbar — Nutzer markiert manuell.
    }
  }

  return (
    <div className="flex gap-2">
      <input
        readOnly
        value={value}
        onFocus={(e) => e.currentTarget.select()}
        className="input flex-1 text-xs font-mono"
      />
      <button type="button" onClick={copy} className="btn-secondary text-xs whitespace-nowrap">
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        {copied ? 'Kopiert' : 'Kopieren'}
      </button>
    </div>
  );
}
