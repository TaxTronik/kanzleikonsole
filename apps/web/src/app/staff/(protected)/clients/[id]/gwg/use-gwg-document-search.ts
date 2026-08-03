'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { searchUnlinkedGwgDocumentsAction } from './id-document-actions';

export interface SelectableGwgDocument {
  id: string;
  title: string;
  createdAt: string;
}

/**
 * Verbindet die kleine initiale Trefferliste mit einer entprellten Suche über
 * die komplette Mandantenakte. Eine Sequenznummer verhindert, dass langsame
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
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limited, setLimited] = useState(false);
  const requestSequence = useRef(0);
  const normalizedQuery = query.trim();

  useEffect(() => {
    const sequence = ++requestSequence.current;
    if (!enabled || normalizedQuery.length < 2) {
      setRemoteDocuments([]);
      setPending(false);
      setError(null);
      setLimited(false);
      return;
    }

    setPending(true);
    setError(null);
    const timeout = window.setTimeout(() => {
      void searchUnlinkedGwgDocumentsAction({
        checkId,
        clientId,
        query: normalizedQuery,
      })
        .then((result) => {
          if (sequence !== requestSequence.current) return;
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
          if (sequence !== requestSequence.current) return;
          setRemoteDocuments([]);
          setLimited(false);
          setError('Dokumentsuche fehlgeschlagen.');
        })
        .finally(() => {
          if (sequence === requestSequence.current) setPending(false);
        });
    }, 250);

    return () => window.clearTimeout(timeout);
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
