'use client';
// =============================================================================
// DocumentExplorer — DIE Dokumentenverwaltung (konsolidiert aus den früheren
// Komponenten DocumentBrowser + DocumentsManager).
//
// Aufgeteilt aus einer 1547-Zeilen-Datei — rein mechanisch:
//   index.tsx         Weiche browser/embedded + öffentliche Typen
//   types.ts          ManagedDoc, BrowserProps, EmbeddedProps
//   ops.tsx           useDocumentOps + geteilte Dialoge/Badges beider Varianten
//   browser-view.tsx  /staff/documents (URL-getrieben, Explorer-Stil)
//   embedded-view.tsx Mandanten-Tab + Aktenregal (lokal gefiltert, Tabelle)
// =============================================================================

import { useDocumentOps, SharedDialogs } from './ops';
import { BrowserView } from './browser-view';
import { EmbeddedView } from './embedded-view';
import type { BrowserProps, EmbeddedProps } from './types';

export type { Crumb, Entry, FolderNode, ManagedDoc, BrowserProps, EmbeddedProps } from './types';

export function DocumentExplorer(props: BrowserProps | EmbeddedProps) {
  const ops = useDocumentOps();
  const scopeClientId =
    props.variant === 'browser' ? (props.scope?.clientId ?? null) : props.clientId;
  return (
    <>
      {props.variant === 'browser' ? (
        <BrowserView {...props} ops={ops} />
      ) : (
        <EmbeddedView {...props} ops={ops} />
      )}
      <SharedDialogs ops={ops} scopeClientId={scopeClientId} />
    </>
  );
}
