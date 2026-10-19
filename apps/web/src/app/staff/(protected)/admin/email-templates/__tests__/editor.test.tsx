// @vitest-environment jsdom
// TCMS Stufe 4: System-Vorlagen der Mitteilungen des Tax-CMS in der
// Vorlagenverwaltung – Slugs sichtbar (auch ohne eigene Fassung der Kanzlei)
// und Platzhalter erklärt, einschließlich des Hinweises zum Code.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../actions', () => ({
  saveEmailTemplateAction: vi.fn(),
  deleteEmailTemplateAction: vi.fn(),
}));
vi.mock('@/components/ui/modal', () => ({ confirmDialog: vi.fn(), noticeDialog: vi.fn() }));

import { TCMS_MAIL_VORLAGEN, TCMS_VORLAGEN_PLATZHALTER } from '@taxtronik/mail/tcms-vorlagen';
import { EmailTemplateEditor } from '../editor';

afterEach(() => cleanup());

const CODE = TCMS_MAIL_VORLAGEN['tcms-freigabe-code'];

describe('E-Mail-Vorlagen: System-Vorlagen des Tax-CMS', () => {
  it('zeigt fehlende System-Slugs mit Standardtext und ihren Platzhaltern', () => {
    render(
      <EmailTemplateEditor
        initial={[]}
        systemStandard={[{ slug: CODE.slug, name: CODE.name, subject: CODE.subject }]}
      />,
    );
    const bereich = screen.getByRole('region', { name: 'System-Vorlagen mit Standardtext' });
    expect(bereich.textContent).toContain('System · tcms-freigabe-code');
    expect(bereich.textContent).toContain('Tax-CMS: Bestätigungscode');
    for (const p of TCMS_VORLAGEN_PLATZHALTER['tcms-freigabe-code']) {
      expect(bereich.textContent).toContain(`{{${p.name}}}`);
    }
    expect(bereich.textContent).toContain('nie im Betreff');
  });

  it('erklärt beim Bearbeiten einer TCMS-System-Vorlage ihre Platzhalter', () => {
    render(
      <EmailTemplateEditor
        initial={[
          {
            id: '11111111-1111-4111-8111-111111111111',
            slug: 'tcms-freigabe-angefordert',
            name: 'Tax-CMS: Freigabe angefordert',
            category: 'System',
            subject: 'Freigabe angefordert: {{freigabe.titel}}',
            bodyMd: 'Text',
            active: true,
          },
        ]}
      />,
    );
    expect(screen.queryByText('Platzhalter dieser System-Vorlage')).toBeNull();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'E-Mail-Vorlage „Tax-CMS: Freigabe angefordert“ bearbeiten',
      }),
    );
    const liste = document.getElementById('email-template-placeholders');
    expect(liste?.textContent).toContain('{{freigabe.hinweis}}');
    expect(liste?.textContent).toContain('{{link}}');
    expect(liste?.textContent).not.toContain('{{code}}');
  });

  it('zeigt bei eigenen Vorlagen ohne Slug keine System-Platzhalter', () => {
    render(
      <EmailTemplateEditor
        initial={[
          {
            id: '22222222-2222-4222-8222-222222222222',
            slug: null,
            name: 'Erinnerung Belege',
            category: null,
            subject: 'Belege',
            bodyMd: 'Text',
            active: true,
          },
        ]}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'E-Mail-Vorlage „Erinnerung Belege“ bearbeiten' }),
    );
    expect(document.getElementById('email-template-placeholders')).toBeNull();
    expect(screen.queryByRole('region', { name: 'System-Vorlagen mit Standardtext' })).toBeNull();
  });
});
