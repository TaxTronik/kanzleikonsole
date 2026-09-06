'use client';

import { useEffect, useMemo, useState } from 'react';
import { searchUnlinkedGwgDocumentsAction } from './id-document-actions';

export interface SelectableGwgDocument {
  id: string;
  title: string;
  createdAt: string;
}

/**
 * Verbindet die kleine initiale Trefferliste mit einer entprellten Suche über
 * die komplette Mandantenakte. Ein Abbruchmarker verhindert, dass langsame
 * Antworten eine inzwischen neuere Eingabe überschreiben.
 */
export function useUnlinkedGwgDocumentSearch({
  checkId,
  clientId,
  initialDocuments,
  query,
  enabled,
}: {
  checkId: string;
  clientId: string;
  initialDocuments: SelectableGwgDocument[];
  query: string;
  enabled: boolean;
}) {
  const [remoteDocuments, setRemoteDocuments] = useState<SelectableGwgDocument[]>([]);
  const [pending, setPending] = useState(enabled && query.trim().length >= 2);
  const [error, setError] = useState<string | null>(null);
  const [limited, setLimited] = useState(false);
  const normalizedQuery = query.trim();

  const requestKey = JSON.stringify([checkId, clientId, enabled, normalizedQuery]);
  const [previousRequestKey, setPreviousRequestKey] = useState(requestKey);
  const shouldSearch = enabled && normalizedQuery.length >= 2;
  if (previousRequestKey !== requestKey) {
    setPreviousRequestKey(requestKey);
    setPending(shouldSearch);
    setError(null);
    if (!shouldSearch) {
      setRemoteDocuments([]);
      setLimited(false);
    }
  }

  useEffect(() => {
    if (!enabled || normalizedQuery.length < 2) return;
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      void searchUnlinkedGwgDocumentsAction({
        checkId,
        clientId,
        query: normalizedQuery,
      })
        .then((result) => {
          if (cancelled) return;
          if (!result.ok) {
            setRemoteDocuments([]);
            setLimited(false);
            setError(result.error ?? 'Dokumentsuche fehlgeschlagen.');
            return;
          }
          setRemoteDocuments(result.documents ?? []);
          setLimited(Boolean(result.limited));
        })
        .catch(() => {
          if (cancelled) return;
          setRemoteDocuments([]);
          setLimited(false);
          setError('Dokumentsuche fehlgeschlagen.');
        })
        .finally(() => {
          if (!cancelled) setPending(false);
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [checkId, clientId, enabled, normalizedQuery]);

  const documents = useMemo(() => {
    const byId = new Map<string, SelectableGwgDocument>();
    for (const document of initialDocuments) byId.set(document.id, document);
    for (const document of remoteDocuments) byId.set(document.id, document);
    const all = [...byId.values()];
    if (!normalizedQuery) return all;
    const needle = normalizedQuery.toLocaleLowerCase('de-DE');
    return all.filter((document) => document.title.toLocaleLowerCase('de-DE').includes(needle));
  }, [initialDocuments, normalizedQuery, remoteDocuments]);

  return { documents, pending, error, limited, normalizedQuery };
}
