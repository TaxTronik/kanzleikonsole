'use client';

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { usePathname, useRouter } from 'next/navigation';
import {
  Search,
  Loader2,
  Users,
  Inbox,
  FileText,
  BookOpen,
  Receipt,
  ArrowRight,
} from 'lucide-react';
import { useAccessibleDisplayEnabled } from './accessible-display';
import { useAnchoredPanel } from './ui/use-anchored-panel';
import { revealPanelOption } from './ui/anchored-panel';

interface SearchResult {
  type: 'client' | 'request' | 'document' | 'kb_article' | 'invoice' | 'nav';
  id: string;
  title: string;
  subtitle?: string;
  href: string;
}

const ICON: Record<SearchResult['type'], ComponentType<{ className?: string }>> = {
  client: Users,
  request: Inbox,
  document: FileText,
  kb_article: BookOpen,
  invoice: Receipt,
  nav: ArrowRight,
};

interface SearchNavItem {
  label: string;
  href: string;
  aliases?: readonly string[];
}

export function GlobalSearch({ navItems = [] }: { navItems?: SearchNavItem[] }) {
  const pathname = usePathname();
  // Das persistente Staff-Layout behält sonst Query und auch browserseitig
  // autofillte DOM-Werte über Seitenwechsel hinweg. Ein Pfadwechsel montiert
  // deshalb bewusst eine frische Suche.
  return <GlobalSearchForPath key={pathname} navItems={navItems} />;
}

function GlobalSearchForPath({ navItems }: { navItems: SearchNavItem[] }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const accessibleDisplay = useAccessibleDisplayEnabled();
  const listboxId = useId();
  const statusId = useId();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const showPanel = open && query.trim().length >= 1;
  const panelStyle = useAnchoredPanel(showPanel, containerRef, 448, 'start', 384);

  // Nav-Kommandos (Sprung zu Seiten) — rein clientseitig aus der gefilterten
  // Navigation des Layouts. Schon ab 1 Zeichen, damit „re“ → Rechnungen sofort
  // trifft, während die Volltext-Suche (API) erst ab 2 Zeichen feuert.
  const navMatches = useMemo<SearchResult[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return navItems
      .filter(
        (n) =>
          n.label.toLowerCase().includes(q) ||
          n.aliases?.some((alias) => alias.toLowerCase().includes(q)),
      )
      .slice(0, 6)
      .map((n) => ({
        type: 'nav' as const,
        id: `nav:${n.href}`,
        title: n.label,
        subtitle: 'Seite öffnen',
        href: n.href,
      }));
  }, [query, navItems]);

  // Gemeinsame Trefferliste: Nav-Kommandos zuerst, dann Datensätze.
  const items = useMemo(() => [...navMatches, ...results], [navMatches, results]);

  // Cmd+K / Ctrl+K → Fokus
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
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

  const [previousQuery, setPreviousQuery] = useState(query);
  if (previousQuery !== query) {
    setPreviousQuery(query);
    setLoading(query.trim().length >= 2);
    setError(null);
    if (query.trim().length < 2) setResults([]);
  }

  // Debounced search (API erst ab 2 Zeichen)
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/staff/search?q=${encodeURIComponent(q)}`);
        if (!res.ok) {
          if (!cancelled) {
            setResults([]);
            setError('Suche fehlgeschlagen — bitte später erneut versuchen.');
          }
          return;
        }
        const data = (await res.json()) as { results: SearchResult[] };
        if (!cancelled) setResults(data.results);
      } catch {
        // Netzwerk-/Offline-Fehler: Fehlerzustand statt „Keine Treffer".
        if (!cancelled) {
          setResults([]);
          setError('Suche nicht erreichbar — bitte Verbindung prüfen.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);

  // Keep keyboard selection aligned before rendering a changed result list.
  const [previousSelection, setPreviousSelection] = useState({ query, count: items.length });
  if (previousSelection.query !== query || previousSelection.count !== items.length) {
    setPreviousSelection({ query, count: items.length });
    setActiveIdx(0);
  }

  useEffect(() => {
    if (!showPanel || !panelRef.current) return;
    const option = panelRef.current.querySelector<HTMLElement>('[aria-selected="true"]');
    if (option) revealPanelOption(panelRef.current, option);
  }, [activeIdx, items, showPanel, panelStyle]);

  function handleKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      if (items.length > 0)
        setActiveIdx((i) => (showPanel ? Math.min(i + 1, items.length - 1) : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
      if (items.length > 0)
        setActiveIdx((i) => (showPanel ? Math.max(i - 1, 0) : items.length - 1));
    } else if (e.key === 'Home' && showPanel && items.length > 0) {
      e.preventDefault();
      setActiveIdx(0);
    } else if (e.key === 'End' && showPanel && items.length > 0) {
      e.preventDefault();
      setActiveIdx(items.length - 1);
    } else if (e.key === 'Enter' && showPanel) {
      const r = items[activeIdx];
      if (r) {
        e.preventDefault();
        navigate(r);
      }
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === 'Tab') {
      // Results use aria-activedescendant; Tab continues in the page, not the list.
      setOpen(false);
    }
  }

  function navigate(r: SearchResult) {
    setOpen(false);
    setQuery('');
    setResults([]);
    router.push(r.href);
  }

  const activeOptionId =
    showPanel && items[activeIdx] ? `${listboxId}-option-${activeIdx}` : undefined;
  const statusMessage = !query.trim()
    ? ''
    : loading
      ? 'Suche läuft.'
      : error
        ? error
        : items.length === 0
          ? 'Keine Treffer.'
          : `${items.length} Treffer verfügbar.`;

  return (
    <div ref={containerRef} className="relative w-full max-w-md">
      <div className="relative">
        {loading ? (
          <Loader2
            className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-disabled animate-spin"
            aria-hidden="true"
          />
        ) : (
          <Search
            className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-disabled"
            aria-hidden="true"
          />
        )}
        <input
          ref={inputRef}
          type="search"
          name="taxtronik-global-search"
          autoComplete="off"
          role="combobox"
          aria-label="Globale Suche"
          aria-autocomplete="list"
          aria-controls={showPanel ? listboxId : undefined}
          aria-expanded={showPanel}
          aria-activedescendant={activeOptionId}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={handleKeyDown}
          placeholder="Mandanten, Anforderungen, Seiten…  (Strg+K)"
          className="w-full pl-9 pr-12 py-2 text-sm border border-default rounded-md bg-gray-50 focus:bg-surface focus:outline-none focus:ring-2 focus:ring-focus focus:border-transparent"
        />
        <kbd
          aria-hidden="true"
          className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-disabled bg-surface border border-default rounded px-1.5 py-0.5 hidden md:block"
        >
          ⌘K
        </kbd>
      </div>

      <p id={statusId} role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {statusMessage}
      </p>

      {showPanel && (
        <div
          ref={panelRef}
          id={listboxId}
          role="listbox"
          aria-label="Suchergebnisse"
          aria-busy={loading}
          style={panelStyle}
          className="absolute bg-surface border border-default rounded-md shadow-lg overflow-y-auto overscroll-contain z-50"
        >
          {items.length === 0 && !loading ? (
            error ? (
              <p role="presentation" className="px-4 py-3 text-sm text-red-700 text-center">
                {error}
              </p>
            ) : (
              <p role="presentation" className="px-4 py-3 text-sm text-disabled text-center">
                Keine Treffer.
              </p>
            )
          ) : (
            <ul role="presentation">
              {items.map((r, i) => {
                const Icon = ICON[r.type];
                return (
                  <li key={`${r.type}-${r.id}`} role="presentation">
                    <button
                      id={`${listboxId}-option-${i}`}
                      type="button"
                      role="option"
                      tabIndex={-1}
                      aria-selected={i === activeIdx}
                      onClick={() => navigate(r)}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => setActiveIdx(i)}
                      className={
                        i === activeIdx
                          ? 'w-full text-left px-4 py-2.5 bg-brand-50 flex items-center gap-3'
                          : 'w-full text-left px-4 py-2.5 hover:bg-gray-50 flex items-center gap-3'
                      }
                    >
                      <Icon className="h-4 w-4 text-muted shrink-0" aria-hidden="true" />
                      <div className="min-w-0 flex-1">
                        <p className={accessibleDisplay ? 'font-medium break-words' : 'item-title'}>
                          {r.title}
                        </p>
                        {r.subtitle && (
                          <p
                            className={
                              accessibleDisplay
                                ? 'text-sm text-muted break-words'
                                : 'text-xs text-muted truncate'
                            }
                          >
                            {r.subtitle}
                          </p>
                        )}
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
