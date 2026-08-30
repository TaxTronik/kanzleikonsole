'use client';

// =============================================================================
// Rechtsnormen einer Markierung: Liste (Engine-Vorschlaege + eigene), Verwerfen/
// Zurueckholen je Fall, Gesetzestext-Aufklappen (Normgraph), katalogweite
// Kuratierung (KatalogPromote) und der Freigabe-Lebenszyklus des geteilten
// Festwissens (KatalogReviewControl).
//
// Aus marking-panel.tsx herausgeloest (mechanisch, identische Props) — die
// Datei trug 13 Komponenten in 1758 Zeilen.
// =============================================================================

import { useCallback, useEffect, useState } from 'react';
import {
  BookPlus,
  ChevronRight,
  Library,
  Loader2,
  Save,
  Scale,
  Search,
  Trash2,
  Undo2,
} from 'lucide-react';
import {
  resolveNormAction,
  resolveNormByZitatAction,
  searchNormAction,
  addBeraterNormAction,
  setNormVerworfenAction,
  removeBeraterNormAction,
  kuratiereKatalogNormAction,
  katalogKuratierungAction,
  reviewKatalogBegriffAction,
} from './norm-actions';
import { confirmDialog } from '@/components/ui/modal';
import {
  type NormRefDTO,
  type KatalogOverlay,
  type Flash,
  buildKatalogOverlay,
  katalogStatus,
} from './_ui';
import type { ResolvedNorm, NormHit } from '@/server/risk';
import { fmtIsoDate } from '@/lib/fmt';

// --- Rechtsnormen (Gesetzestext-Expandable) ---------------------------------

/** "norm:UStG:2:abs2:nr2" → "§ 2 Abs. 2 Nr. 2 UStG" (nur Anzeige). */
function formatNormId(id: string): string {
  const parts = id.split(':');
  if (parts[0] !== 'norm' || parts.length < 3) return id;
  const law = parts[1];
  const para = parts[2];
  const rest = parts.slice(3).map((seg) => {
    const abs = /^abs(\d+[a-z]?)$/i.exec(seg);
    if (abs) return `Abs. ${abs[1]}`;
    const nr = /^nr(\d+[a-z]?)$/i.exec(seg);
    if (nr) return `Nr. ${nr[1]}`;
    const s = /^s(\d+)$/i.exec(seg);
    if (s) return `Satz ${s[1]}`;
    return seg;
  });
  return `§ ${para}${rest.length ? ' ' + rest.join(' ') : ''} ${law}`;
}

/** Absatz-Marker "(1)" auf eigene Zeilen brechen — bessere Lesbarkeit. */
function formatGesetzestext(text: string): string {
  return text.replace(/\((\d+[a-z]?)\)\s*/g, '\n($1) ').trim();
}

/** Freigabe-Lebenszyklus des GETEILTEN Festwissens (Engine 1.1.0): entwurf →
 *  geprüft → freigegeben, nur vorwärts, immer über POST /v1/katalog/review —
 *  erst dann steht der Übergang in der Audit-Chain. Vier-Augen-Prinzip und
 *  „nur geteilte Einträge" erzwingt der Server; Ablehnungen (z. B. eigener
 *  Begriff, Rückwärts-Übergang) kommen als Fehlertext zurück. */
export function KatalogReviewControl({
  clientId,
  katalogId,
  pending,
  start,
  flash,
}: {
  clientId: string;
  katalogId: string;
  pending: boolean;
  start: (cb: () => void) => void;
  flash: Flash;
}) {
  async function review(status: 'geprüft' | 'freigegeben') {
    if (
      status === 'freigegeben' &&
      !(await confirmDialog(
        'Begriff kanzleiweit freigeben? Der Übergang ist nur vorwärts möglich und wird in der Audit-Chain verankert.',
        { title: 'Begriff freigeben', confirmLabel: 'Freigeben' },
      ))
    )
      return;
    start(async () => {
      const r = await reviewKatalogBegriffAction({ clientId, katalogId, status });
      flash(
        r,
        status === 'freigegeben'
          ? 'Begriff freigegeben (auditiert).'
          : 'Begriff als geprüft markiert (auditiert).',
      );
    });
  }
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <p className="text-[11px] text-muted inline-flex items-center gap-1">
        <Library className="h-3 w-3" /> Katalog-Review (geteilt)
      </p>
      <button
        type="button"
        disabled={pending}
        onClick={() => review('geprüft')}
        className="text-[11px] rounded border border-default px-1.5 py-0.5 hover:bg-gray-50 dark:hover:bg-gray-900/40 disabled:opacity-50"
      >
        Als geprüft markieren
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() => review('freigegeben')}
        className="text-[11px] rounded border border-emerald-600/60 text-emerald-700 dark:text-emerald-300 px-1.5 py-0.5 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 disabled:opacity-50"
      >
        Freigeben
      </button>
    </div>
  );
}

/** Die Engine-Norm ist NICHT verbindlich: der Berater ergänzt eigene Normen und
 *  verwirft Engine-Vorschläge (soft). Effektive Liste = nicht verworfene Einträge. */
export function NormRefList({
  clientId,
  markingId,
  katalogId,
  refs,
  fallback,
  engineConfigured,
  pending,
  start,
  flash,
  onChanged,
}: {
  clientId: string;
  markingId: string;
  katalogId: string | null;
  refs: NormRefDTO[] | null;
  fallback: string[];
  engineConfigured: boolean;
  pending: boolean;
  start: (cb: () => void) => void;
  flash: Flash;
  onChanged: () => void;
}) {
  // Strukturierte Refs sind die Quelle der Wahrheit; Altdaten/manuelle Markierungen
  // mit nur flachem normAnker werden in dieselbe Reihenfolge synthetisiert, die der
  // Server in readNormRefs erzeugt → die Indizes für verwerfen/entfernen passen.
  const list: NormRefDTO[] =
    refs && refs.length > 0
      ? refs
      : fallback.map((z) => ({
          zitat: z,
          id: null,
          titel: null,
          quelle: 'ENGINE' as const,
          verworfen: false,
        }));
  const [showAdd, setShowAdd] = useState(false);

  // Katalog-Overlay (GET /v1/katalog/kuratierung): best-effort: zeigt, welche
  // Normen katalogweit (kanzlei) kuratiert sind — getrennt vom per-Fall-Zustand.
  // Scheitert der Call (Endpoint noch nicht live), bleibt das Overlay einfach leer.
  const [overlay, setOverlay] = useState<KatalogOverlay | null>(null);
  const fetchOverlay = useCallback(() => {
    if (!katalogId) {
      setOverlay(null);
      return;
    }
    katalogKuratierungAction({ clientId, katalogId })
      .then((r) => {
        if (r.ok) setOverlay(buildKatalogOverlay(r));
      })
      .catch(() => {
        /* best-effort — kein Overlay */
      });
  }, [clientId, katalogId]);
  useEffect(() => {
    fetchOverlay();
  }, [fetchOverlay]);

  return (
    <div className="space-y-1">
      <p className="text-[11px] text-muted inline-flex items-center gap-1">
        <Scale className="h-3 w-3" /> Rechtsnormen{' '}
        <span className="text-disabled">· Vorschläge, nicht verbindlich</span>
      </p>
      {list.length > 0 && (
        <ul className="space-y-1">
          {list.map((r, i) => (
            <NormRefRow
              key={(r.id ?? r.zitat) + ':' + i}
              clientId={clientId}
              markingId={markingId}
              katalogId={katalogId}
              index={i}
              refItem={r}
              kat={katalogStatus(r, overlay)}
              engineConfigured={engineConfigured}
              pending={pending}
              start={start}
              flash={flash}
              onChanged={onChanged}
              onKatalogChanged={fetchOverlay}
            />
          ))}
        </ul>
      )}
      {showAdd ? (
        <AddNormForm
          clientId={clientId}
          markingId={markingId}
          pending={pending}
          start={start}
          flash={flash}
          onDone={() => {
            setShowAdd(false);
            onChanged();
          }}
          onCancel={() => setShowAdd(false)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setShowAdd(true)}
          disabled={pending}
          className="w-full inline-flex items-center justify-center gap-1.5 text-xs text-brand rounded border border-dashed border-default py-1.5 hover:bg-gray-50 dark:hover:bg-gray-900/40 disabled:opacity-50"
        >
          <BookPlus className="h-3.5 w-3.5" /> Eigene Norm ergänzen
        </button>
      )}
    </div>
  );
}

function NormRefRow({
  clientId,
  markingId,
  katalogId,
  index,
  refItem,
  kat,
  engineConfigured,
  pending,
  start,
  flash,
  onChanged,
  onKatalogChanged,
}: {
  clientId: string;
  markingId: string;
  katalogId: string | null;
  index: number;
  refItem: NormRefDTO;
  kat: 'verworfen' | 'ergaenzt' | null;
  engineConfigured: boolean;
  pending: boolean;
  start: (cb: () => void) => void;
  flash: Flash;
  onChanged: () => void;
  onKatalogChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [showKat, setShowKat] = useState(false);
  const [norm, setNorm] = useState<ResolvedNorm | null>(null);
  const [matched, setMatched] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Mit ID direkt auflösbar; ohne ID (z. B. frei eingetippte eigene Norm) über das
  // Zitat, sofern die Engine verfügbar ist.
  const canResolve = !!refItem.id || engineConfigured;
  const isBerater = refItem.quelle === 'BERATER';
  const verworfen = refItem.verworfen === true;

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && canResolve && !norm && !loading) {
      setLoading(true);
      setErr(null);
      const req = refItem.id
        ? resolveNormAction({ clientId, normId: refItem.id })
        : resolveNormByZitatAction({ clientId, zitat: refItem.zitat });
      req
        .then((r) => {
          if (!r.ok) {
            setErr(r.error);
            return;
          }
          if (!r.norm) {
            setErr('Zu diesem Zitat wurde im Normkorpus keine Norm gefunden.');
            return;
          }
          setNorm(r.norm);
          if ('matchedZitat' in r && r.matchedZitat && r.matchedZitat !== refItem.zitat)
            setMatched(r.matchedZitat);
        })
        .catch(() => setErr('Norm konnte nicht geladen werden.'))
        .finally(() => setLoading(false));
    }
  }

  function setVerworfen(v: boolean) {
    start(async () => {
      const r = await setNormVerworfenAction({
        markingId,
        index,
        zitat: refItem.zitat,
        verworfen: v,
      });
      flash(r, v ? 'Engine-Norm verworfen.' : 'Norm zurückgeholt.');
      if (r.ok) onChanged();
    });
  }

  function removeOwn() {
    start(async () => {
      const r = await removeBeraterNormAction({ markingId, index, zitat: refItem.zitat });
      flash(r, 'Eigene Norm entfernt.');
      if (r.ok) onChanged();
    });
  }

  return (
    <li
      className={
        'rounded border bg-surface ' +
        (verworfen ? 'border-default/40 opacity-60' : 'border-default/60')
      }
    >
      <div className="flex items-center">
        <button
          type="button"
          onClick={canResolve ? toggle : undefined}
          disabled={!canResolve}
          className={
            'flex-1 min-w-0 flex items-start gap-1.5 px-2 py-1 text-left text-xs ' +
            (canResolve ? 'hover:bg-gray-50 dark:hover:bg-gray-900/40' : 'cursor-default')
          }
          title={canResolve ? 'Gesetzestext anzeigen' : 'Keine Norm-ID — nicht auflösbar'}
        >
          {canResolve ? (
            <ChevronRight
              className={
                'h-3.5 w-3.5 shrink-0 mt-0.5 text-disabled transition-transform ' +
                (open ? 'rotate-90' : '')
              }
            />
          ) : (
            <span className="w-3.5 shrink-0" />
          )}
          <span
            className={
              'font-medium ' + (verworfen ? 'line-through text-disabled' : 'text-secondary')
            }
          >
            {refItem.zitat}
          </span>
          {refItem.titel && <span className="text-muted truncate">— {refItem.titel}</span>}
          {isBerater && <span className="badge-purple text-[10px] shrink-0">eigene</span>}
          {kat && (
            <span
              className={
                'inline-flex items-center gap-0.5 text-[10px] shrink-0 ' +
                (kat === 'verworfen'
                  ? 'text-red-600 dark:text-red-400'
                  : 'text-emerald-600 dark:text-emerald-400')
              }
              title={
                kat === 'verworfen'
                  ? 'Katalogweit verworfen (Kanzlei-Regel)'
                  : 'Katalogweit ergänzt (Kanzlei-Regel)'
              }
            >
              <Library className="h-2.5 w-2.5" /> Katalog:{' '}
              {kat === 'verworfen' ? 'verworfen' : 'ergänzt'}
            </span>
          )}
        </button>
        <div className="ml-auto flex items-center gap-1.5 pr-1.5 shrink-0">
          {/* Per-Fall-Aktion (nur diese Analyse) — zuerst, direkt an der Norm. */}
          {isBerater ? (
            <button
              type="button"
              onClick={removeOwn}
              disabled={pending}
              title="Eigene Norm entfernen"
              className="text-disabled hover:text-red-600 disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          ) : verworfen ? (
            <button
              type="button"
              onClick={() => setVerworfen(false)}
              disabled={pending}
              title="Vorschlag für diesen Fall zurückholen"
              className="text-[11px] text-brand hover:underline disabled:opacity-50 inline-flex items-center gap-0.5"
            >
              <Undo2 className="h-3 w-3" /> zurückholen
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setVerworfen(true)}
              disabled={pending}
              title="Engine-Vorschlag nur für diesen Fall verwerfen"
              className="text-[11px] text-muted hover:text-red-600 disabled:opacity-50"
            >
              verwerfen
            </button>
          )}
          {/* Katalog-Promotion (kanzleiweit/künftig) — durch Trenner klar abgesetzt. */}
          {katalogId && (
            <>
              <span className="h-4 w-px bg-gray-300 dark:bg-gray-700 shrink-0" aria-hidden="true" />
              <button
                type="button"
                onClick={() => setShowKat((v) => !v)}
                disabled={pending}
                title="Katalogweit kuratieren — wirkt auf künftige Analysen dieses Begriffs"
                className={
                  'text-[11px] inline-flex items-center gap-0.5 rounded px-1 py-0.5 disabled:opacity-50 ' +
                  (showKat
                    ? 'text-brand bg-gray-100 dark:bg-gray-800'
                    : 'text-muted hover:text-brand hover:bg-gray-50 dark:hover:bg-gray-900/40')
                }
              >
                <Library className="h-3 w-3" /> Katalog
              </button>
            </>
          )}
        </div>
      </div>
      {open && canResolve && (
        <div className="px-2 pb-2 pt-0.5 text-xs">
          {loading && (
            <span className="text-muted inline-flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" /> lädt …
            </span>
          )}
          {err && <span className="text-red-700 dark:text-red-300">{err}</span>}
          {matched && !loading && !err && (
            <p className="text-[11px] text-amber-600 dark:text-amber-400 mb-1">
              aufgelöst als „{matched}" (Normgraph).
            </p>
          )}
          {norm && !loading && !norm.gefunden && (
            <span className="text-muted">Im Normkorpus nicht gefunden.</span>
          )}
          {norm && norm.gefunden && (
            <div className="space-y-1">
              <p className="text-[11px] text-muted">
                {[
                  norm.titel,
                  norm.law,
                  norm.gueltigAb ? `gültig ab ${fmtIsoDate(norm.gueltigAb)}` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
              <div className="max-h-72 overflow-auto rounded bg-gray-50 dark:bg-gray-900 p-2 text-[11px] leading-relaxed whitespace-pre-wrap">
                {formatGesetzestext(norm.text)}
              </div>
              {norm.verweistAuf.length > 0 && (
                <p className="text-[11px] text-muted">
                  <span className="text-disabled">Verweist auf:</span>{' '}
                  {norm.verweistAuf.map(formatNormId).join(' · ')}
                </p>
              )}
            </div>
          )}
        </div>
      )}
      {showKat && katalogId && (
        <KatalogPromote
          markingId={markingId}
          norm={refItem.zitat}
          pending={pending}
          start={start}
          flash={flash}
          onChanged={onKatalogChanged}
          onClose={() => setShowKat(false)}
        />
      )}
    </li>
  );
}

/** Katalogweite Promotion (geschichtet): kuratiert eine Norm der Begriffs-Karte
 *  dauerhaft — wirkt auf künftige Analysen. Engine-Call + Audit in TaxTronik. */
function KatalogPromote({
  markingId,
  norm,
  pending,
  start,
  flash,
  onChanged,
  onClose,
}: {
  markingId: string;
  norm: string;
  pending: boolean;
  start: (cb: () => void) => void;
  flash: Flash;
  onChanged: () => void;
  onClose: () => void;
}) {
  const [scope, setScope] = useState<'geteilt' | 'personal'>('geteilt');
  function run(aktion: 'verwerfen' | 'ergaenzen' | 'zuruecksetzen') {
    start(async () => {
      const r = await kuratiereKatalogNormAction({ markingId, norm, aktion, scope });
      flash(
        r,
        aktion === 'verwerfen'
          ? 'Katalogweit verworfen.'
          : aktion === 'ergaenzen'
            ? 'In den Katalog aufgenommen.'
            : 'Katalog-Kuratierung zurückgesetzt.',
      );
      if (r.ok) {
        onChanged();
        onClose();
      }
    });
  }
  return (
    <div className="px-2 pb-2 pt-1 mt-0.5 border-t border-default/40 space-y-1.5">
      <p className="text-[11px] text-muted">
        Katalogweit für diesen Begriff — wirkt auf <strong>künftige</strong> Analysen, nicht
        rückwirkend.
      </p>
      <div className="flex items-center gap-3 text-[11px]">
        <span className="text-muted">Reichweite:</span>
        <label className="inline-flex items-center gap-1 cursor-pointer">
          <input
            type="radio"
            name={'kat-scope-' + markingId + norm}
            checked={scope === 'geteilt'}
            onChange={() => setScope('geteilt')}
          />{' '}
          geteilt (Kanzlei)
        </label>
        <label className="inline-flex items-center gap-1 cursor-pointer">
          <input
            type="radio"
            name={'kat-scope-' + markingId + norm}
            checked={scope === 'personal'}
            onChange={() => setScope('personal')}
          />{' '}
          persönlich
        </label>
      </div>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => run('verwerfen')}
          disabled={pending}
          className="btn-secondary text-[11px]"
        >
          verwerfen
        </button>
        <button
          type="button"
          onClick={() => run('ergaenzen')}
          disabled={pending}
          className="btn-secondary text-[11px]"
        >
          ergänzen
        </button>
        <button
          type="button"
          onClick={() => run('zuruecksetzen')}
          disabled={pending}
          className="text-[11px] text-muted hover:underline disabled:opacity-50"
        >
          zurücksetzen
        </button>
      </div>
    </div>
  );
}

/** „Eigene Norm ergänzen": Freitext-Zitat + optionale Engine-Normgraphsuche, die
 *  eine stabile Norm-ID + Titel anhängt (→ Gesetzestext aufklappbar). */
function AddNormForm({
  clientId,
  markingId,
  pending,
  start,
  flash,
  onDone,
  onCancel,
}: {
  clientId: string;
  markingId: string;
  pending: boolean;
  start: (cb: () => void) => void;
  flash: Flash;
  onDone: () => void;
  onCancel: () => void;
}) {
  const field = 'w-full rounded border border-default bg-surface px-2 py-1 text-xs';
  const [zitat, setZitat] = useState('');
  const [picked, setPicked] = useState<NormHit | null>(null);
  const [hits, setHits] = useState<NormHit[] | null>(null);
  const [searching, setSearching] = useState(false);

  function search() {
    const q = zitat.trim();
    if (q.length < 2) return;
    setSearching(true);
    setHits(null);
    setPicked(null);
    searchNormAction({ clientId, query: q })
      .then((r) => {
        if (r.ok) setHits(r.hits);
        else flash(r);
      })
      .catch(() => flash({ ok: false, error: 'Normsuche fehlgeschlagen.' }))
      .finally(() => setSearching(false));
  }

  // Treffer übernehmen → stabile ID + Titel anhängen (Gesetzestext wird auflösbar).
  function pick(h: NormHit) {
    setPicked(h);
    setZitat(h.zitat);
    setHits(null);
  }

  function submit() {
    const z = zitat.trim();
    if (!z) return;
    start(async () => {
      const r = await addBeraterNormAction({
        markingId,
        zitat: z,
        normId: picked?.id ?? null,
        titel: picked?.titel ?? null,
      });
      flash(r, 'Eigene Norm ergänzt.');
      if (r.ok) onDone();
    });
  }

  return (
    <div className="rounded border border-default/60 bg-surface p-2 space-y-1.5">
      <div className="flex items-center gap-1.5">
        <input
          value={zitat}
          onChange={(e) => {
            setZitat(e.target.value);
            setPicked(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Zitat, z. B. § 42 AO"
          className={'flex-1 ' + field}
          autoFocus
        />
        <button
          type="button"
          onClick={search}
          disabled={searching || zitat.trim().length < 2}
          className="btn-secondary text-xs shrink-0"
          title="In der Engine nach stabiler Norm-ID suchen"
        >
          {searching ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Search className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
      {picked && (
        <p className="text-[11px] text-emerald-700 dark:text-emerald-300">
          verknüpft: {picked.zitat}
          {picked.titel ? ` — ${picked.titel}` : ''} (Gesetzestext aufklappbar)
        </p>
      )}
      {hits &&
        (hits.length === 0 ? (
          <p className="text-[11px] text-muted">
            Kein Normgraph-Treffer — du kannst das Zitat trotzdem als Freitext übernehmen.
          </p>
        ) : (
          <ul className="space-y-0.5 max-h-40 overflow-auto">
            {hits.map((h) => (
              <li key={h.id}>
                <button
                  type="button"
                  onClick={() => pick(h)}
                  className="w-full text-left text-[11px] px-1.5 py-1 rounded hover:bg-gray-50 dark:hover:bg-gray-900/40"
                >
                  <span className="font-medium text-secondary">{h.zitat}</span>
                  {h.titel && <span className="text-muted"> — {h.titel}</span>}
                </button>
              </li>
            ))}
          </ul>
        ))}
      <div className="flex items-center gap-2 pt-0.5">
        <button
          type="button"
          onClick={submit}
          disabled={pending || zitat.trim().length === 0}
          className="btn-primary text-xs"
        >
          {pending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Save className="h-3.5 w-3.5" />
          )}{' '}
          Übernehmen
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          className="text-xs text-muted hover:underline"
        >
          Abbrechen
        </button>
      </div>
    </div>
  );
}
