import type { JSONContent } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import { BackgroundColor, Color, FontSize, TextStyle } from '@tiptap/extension-text-style';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';

const SAFE_COLOR = /^#[0-9a-f]{6}$/i;
const SAFE_FONT_SIZE = /^(?:0\.875|1|1\.125|1\.25|1\.5)rem$/;

function safeStyleDeclarations(attrs: Record<string, unknown> | undefined): string[] {
  const styles: string[] = [];
  if (typeof attrs?.color === 'string' && SAFE_COLOR.test(attrs.color)) {
    styles.push(`color: ${attrs.color.toLowerCase()}`);
  }
  if (typeof attrs?.backgroundColor === 'string' && SAFE_COLOR.test(attrs.backgroundColor)) {
    styles.push(`background-color: ${attrs.backgroundColor.toLowerCase()}`);
  }
  if (typeof attrs?.fontSize === 'string' && SAFE_FONT_SIZE.test(attrs.fontSize)) {
    styles.push(`font-size: ${attrs.fontSize}`);
  }
  return styles;
}

/**
 * Standard-Markdown kennt weder Text- noch Markerfarben. Wir bewahren diese
 * Formatierungen deshalb als eng begrenztes Inline-HTML innerhalb des
 * Markdown-Quelltexts. Die Serverdarstellung lässt nur dieselben drei
 * geprüften CSS-Eigenschaften und Werte wieder durch.
 */
const MarkdownTextStyle = TextStyle.extend({
  renderMarkdown: (
    node: JSONContent,
    helpers: { renderChildren: (node: JSONContent) => string },
  ) => {
    const styles = safeStyleDeclarations(node.attrs);
    const content = helpers.renderChildren(node);
    return styles.length > 0 ? `<span style="${styles.join('; ')}">${content}</span>` : content;
  },
});

export const knowledgeEditorExtensions = [
  StarterKit,
  Markdown.configure({ markedOptions: { gfm: true } }),
  MarkdownTextStyle,
  Color,
  BackgroundColor,
  FontSize,
  Image.configure({ allowBase64: false }),
];
