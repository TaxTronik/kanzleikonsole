import { describe, expect, it } from 'vitest';
import { escapeMarkdownVariable, renderSafeMarkdown } from '../markdown';

describe('renderSafeMarkdown XSS hardening', () => {
  it('escaped Raw-HTML und Attributbegrenzer', () => {
    const html = renderSafeMarkdown('<img src=x onerror="alert(1)">');

    expect(html).not.toContain('<img');
    expect(html).not.toContain('onerror="');
    expect(html).toContain('&lt;img');
    expect(html).toContain('&quot;');
  });

  it('erzeugt aus Schemes im Text nur HTTP(S)-Autolinks', () => {
    const html = renderSafeMarkdown(
      'javascript:alert(1) data:text/html,x https://safe.example.test/path',
    );

    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('href="data:');
    expect(html).toContain('href="https://safe.example.test/path"');
  });

  it('laesst keinen Attributausbruch aus einem Autolink zu', () => {
    const html = renderSafeMarkdown('https://example.test/" onmouseover="alert(1)');

    expect(html).not.toContain('onmouseover="');
    expect(html).not.toContain('<script');
  });

  it('interpretiert escaped Variablen weder als Markdown noch als Autolink', () => {
    const value = escapeMarkdownVariable('**Admin** https://evil.example.test');
    const html = renderSafeMarkdown(value);

    expect(html).not.toContain('<strong>');
    expect(html).not.toContain('<a ');
    expect(html).toContain('**Admin** https://evil.example.test');
  });
});
