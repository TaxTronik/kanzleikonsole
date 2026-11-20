// =============================================================================
// MarkdownContent — die einzige Stelle, an der Markdown als HTML ins DOM gelangt.
//
// Die Komponente nimmt Markdown-QUELLTEXT entgegen, nie fertiges HTML. Der
// Renderer (lib/markdown) escapet jeden Textblock und erzeugt nur eine feste
// Tag-Liste mit geprüften href-, src- und style-Werten
// (lib/__tests__/markdown*.test.ts). Aufrufer können so kein ungeprüftes HTML
// durchreichen. Zusätzlich blockiert die CSP (proxy.ts: script-src mit Nonce
// und 'strict-dynamic', ohne 'unsafe-inline') Inline-Skripte und
// Event-Handler.
//
// Weitere dangerouslySetInnerHTML-Stellen sperrt eslint.config.mjs
// (HTML_SINK_ALLOWLIST).
//
// Bewusst OHNE 'use client': Die Komponente hat keine Hooks und funktioniert
// im Server- wie im Client-Tree.
// =============================================================================

import { renderMarkdown } from '@/lib/markdown';

export function MarkdownContent({
  source,
  className,
  as: Tag = 'div',
}: {
  /** Markdown-Quelltext; wird vor dem Einfügen vollständig escapet. */
  source: string;
  className?: string;
  as?: 'div' | 'article';
}) {
  return <Tag className={className} dangerouslySetInnerHTML={{ __html: renderMarkdown(source) }} />;
}
