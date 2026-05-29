'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search, Loader2, Users, Inbox, FileText, BookOpen, Receipt, ArrowRight } from 'lucide-react';

interface SearchResult {
  type: 'client' | 'request' | 'document' | 'kb_article' | 'invoice' | 'nav';
  id: string;
  title: string;
  subtitle?: string;
  href: string;
}

const ICON: Record<SearchResult['type'], React.ComponentType<{ className?: string }>> = {
  client: Users,
  request: Inbox,
  document: FileText,
  kb_article: BookOpen,
  invoice: Receipt,
  nav: ArrowRight,
};

export function GlobalSearch({ navItems = [] }: { navItems?: { label: string; href: string }[] }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);

  // Nav-Kommandos (Sprung zu Seiten) — rein clientseitig aus der gefilterten
  // Navigation des Layouts. Schon ab 1 Zeichen, damit „re“ → Rechnungen sofort
  // trifft, während die Volltext-Suche (API) erst ab 2 Zeichen feuert.
  const navMatches = useMemo<SearchResult[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return navItems
      .filter((n) => n.label.toLowerCase().includes(q))
      .slice(0, 6)
      .map((n) => ({ type: 'nav' as const, id: `nav:${n.href}`, title: n.label, subtitle: 'Seite öffnen', href: n.href }));
  }, [query, navItems]);

  // Gemeinsame Trefferliste: Nav-Kommandos zuerst, dann Datensätze.
  const items = useMemo(() => [...navMatches, ...results], [navMatches, results]);

  // Cmd+K / Ctrl+K → Fokus
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      } else if (e.key === 'Escape') {
        setOpen(false);
        inputRef.current?.blur();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Click-outside → schließen
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, []);

  // Debounced search (API erst ab 2 Zeichen)
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/staff/search?q=${encodeURIComponent(q)}`);
        if (!res.ok) {
          if (!cancelled) setResults([]);
          return;
        }
        const data = (await res.json()) as { results: SearchResult[] };
        if (!cancelled) setResults(data.results);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);

  // activeIdx zurücksetzen, wenn sich die Trefferliste ändert
  useEffect(() => {
    setActiveIdx(0);
  }, [items.length]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      const r = items[activeIdx];
      if (r) {
        e.preventDefault();
        navigate(r);
      }
    }
  }

  function navigate(r: SearchResult) {
    setOpen(false);
    setQuery('');
    setResults([]);
    router.push(r.href);
  }

  const showPanel = open && query.trim().length >= 1;

  return (
    <div ref={containerRef} className="relative w-full max-w-md">
      <div className="relative">
        {loading ? (
          <Loader2 className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-disabled animate-spin" />
        ) : (
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-disabled" />
        )}
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder="Mandanten, Anforderungen, Seiten…  (Strg+K)"
          className="w-full pl-9 pr-12 py-2 text-sm border border-default rounded-md bg-gray-50 focus:bg-surface focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
        />
        <kbd className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-disabled bg-surface border border-default rounded px-1.5 py-0.5 hidden md:block">
          ⌘K
        </kbd>
      </div>

      {showPanel && (
        <div className="absolute left-0 right-0 mt-1 bg-surface border border-default rounded-md shadow-lg max-h-96 overflow-y-auto z-50">
          {items.length === 0 && !loading ? (
            <p className="px-4 py-3 text-sm text-disabled text-center">Keine Treffer.</p>
          ) : (
            <ul>
              {items.map((r, i) => {
                const Icon = ICON[r.type];
                return (
                  <li key={`${r.type}-${r.id}`}>
                    <button
                      type="button"
                      onClick={() => navigate(r)}
                      onMouseEnter={() => setActiveIdx(i)}
                      className={
                        i === activeIdx
                          ? 'w-full text-left px-4 py-2.5 bg-brand-50 flex items-center gap-3'
                          : 'w-full text-left px-4 py-2.5 hover:bg-gray-50 flex items-center gap-3'
                      }
                    >
                      <Icon className="h-4 w-4 text-muted shrink-0" />
                      <div className="min-w-0 flex-1">
                        <p className="item-title">{r.title}</p>
                        {r.subtitle && <p className="text-xs text-muted truncate">{r.subtitle}</p>}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
