// =============================================================================
// NoticeView — rendert die Datenschutzhinweise (Markdown) lesbar & freundlich.
//
// Nutzt den geteilten, HTML-escapenden Mini-Markdown-Renderer (lib/markdown).
// Bewusst OHNE 'use client': als reine Präsentation ohne Hooks funktioniert die
// Komponente sowohl im Server- (Staff-Vorschau) als auch im Client-Tree (Portal-
// Wizard). Das Prose-Styling ist identisch zum KB-Artikel-Renderer.
// =============================================================================

import { renderMarkdown } from '@/lib/markdown';

const PROSE_CLASSES =
  'prose prose-sm max-w-none text-secondary ' +
  '[&_h1]:text-lg [&_h1]:font-bold [&_h1]:text-primary [&_h1]:mb-2 ' +
  '[&_h2]:text-sm [&_h2]:font-semibold [&_h2]:text-primary [&_h2]:mt-4 [&_h2]:mb-1 ' +
  '[&_p]:my-2 [&_p]:leading-relaxed ' +
  '[&_ul]:list-disc [&_ul]:ml-5 [&_ul]:my-2 [&_ol]:list-decimal [&_ol]:ml-5 [&_ol]:my-2 [&_li]:my-0.5 ' +
  '[&_strong]:text-primary [&_a]:text-brand-700 [&_a:hover]:underline';

export function NoticeView({ body, className }: { body: string; className?: string }) {
  const html = renderMarkdown(body);
  return (
    <div
      className={className ? `${PROSE_CLASSES} ${className}` : PROSE_CLASSES}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
