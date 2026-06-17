'use client';

// =============================================================================
// FileButton — stilbarer Datei-Auswahl-Button.
//
// Der native <input type="file"> zeigt sein "Durchsuchen…"-Label als Browser-
// Standard und lässt sich nicht konsistent per CSS wie ein App-Button formatieren
// (erscheint daher oft als "nur Text"). Diese Komponente versteckt den nativen
// Input hinter einem <label> in Button-Optik und zeigt den gewählten Dateinamen
// an. Der Input bleibt form-tauglich (name/accept werden gesetzt und beim
// Submit mitgesendet); onSelect liefert die gewählte Datei für Validierung /
// FileReader-Vorschau.
// =============================================================================

import { useRef, useState, type ReactNode } from 'react';
import { Upload } from 'lucide-react';

export function FileButton({
  id,
  name,
  accept,
  onSelect,
  children,
  className,
  disabled,
}: {
  id: string;
  /** Wenn gesetzt, wird der Input unter diesem Namen mit dem Formular übermittelt.
   *  Ohne name dient der Button nur der Auswahl (z. B. wenn der Wert via
   *  FileReader in ein verstecktes Feld fließt). */
  name?: string;
  accept?: string;
  onSelect?: (file: File) => void;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  // Wenn der Caller die Datei per FileReader verarbeitet und ein Fehler
  // auftritt, kann er den Input zurücksetzen (leerer Wert) — wir followen
  // das via eines einfachen Effekts auf den value. Der Einfachheit halber
  // wird hier nur der Anzeige-Name gepurgt, wenn onChange ohne Datei feuert.
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <label
        htmlFor={id}
        className={
          (className ?? 'btn-secondary') +
          ' cursor-pointer inline-flex items-center gap-2' +
          (disabled ? ' opacity-60 pointer-events-none' : '')
        }
      >
        <Upload className="h-4 w-4" />
        {children}
        <input
          ref={inputRef}
          id={id}
          name={name}
          type="file"
          accept={accept}
          disabled={disabled}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) {
              setFileName(null);
              return;
            }
            setFileName(f.name);
            onSelect?.(f);
          }}
        />
      </label>
      {fileName && <span className="text-xs text-muted truncate max-w-[200px]">{fileName}</span>}
    </div>
  );
}
