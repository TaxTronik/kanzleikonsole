import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(new URL(`../../app/staff/(protected)/${path}`, import.meta.url), 'utf8');
}

describe('Verhaltensneutrale Darstellungsextraktionen', () => {
  it('AUDIT-VERIFY-ALERT-001: Admin-Karten zeigen nur bereits geladene Statusdaten', () => {
    const admin = source('admin/page.tsx');
    const cards = admin.slice(
      admin.indexOf('function AuditStatusCard'),
      admin.indexOf('function StatusHero'),
    );
    expect(admin).toContain('requireStaffPage({ admin: true })');
    expect(admin).toContain(
      'readTenantSettingValue(tx, tenantId, AUDIT_VERIFY_RESULT_SETTING_KEY)',
    );
    expect(admin).toContain('<AuditStatusCard verifyResult={verifyResult} />');
    expect(admin).toContain('<BackupStatusCard lastBackup={lastBackup} drill={drill} />');
    expect(cards).not.toContain('withTenantContext(');
    expect(cards).not.toContain('await ');
    expect(cards).toContain('Historischer Bruch — Recovery-Checkpoint gesetzt');
    expect(cards).toContain('Verifikationslauf fehlgeschlagen');
    expect(cards).toContain('Noch nie gesichert');
  });

  it('trennt n8n-Fortschrittsanzeige von Aktionspayloads und behält die fünf Stufen', () => {
    const n8n = source('admin/settings/n8n-form.tsx');
    const progress = n8n.slice(
      n8n.indexOf('function n8nSetupProgress'),
      n8n.indexOf('export function N8nForm'),
    );
    for (const label of ['Verbinden', 'Rückkanal', 'Workflows', 'Routen', 'Betrieb']) {
      expect(progress).toContain(`label: '${label}'`);
    }
    expect(progress).not.toContain('FormData');
    expect(progress).not.toContain('Action(');
    expect(n8n).toContain('n8nSetupProgress(');
    expect(n8n).toContain('function connectionFormData(): FormData');
    expect(n8n).toContain("if (keepApiKey) data.set('keepApiKey', 'on')");
  });

  it('hält Route-Titel/Vorbelegung rein darstellend und Ereignispayloads unverändert am Formular', () => {
    const routes = source('admin/settings/route-editor-section.tsx');
    const presentation = routes.slice(
      routes.indexOf('function routeEditorPresentation'),
      routes.indexOf('export function RouteEditorSection'),
    );
    expect(presentation).toContain(
      'routeDraft.id || routeDraft.workflowId || routeDraft.name || routeDraft.productionUrl',
    );
    expect(presentation).toContain('Route bearbeiten');
    expect(presentation).toContain('Erkannte Route übernehmen');
    expect(presentation).not.toContain('setRouteDraft');
    expect(routes).toContain('onSubmit={onSaveRoute}');
    expect(routes).toContain(
      'requiresSeparateTestWebhook(routeDraft.events) || Boolean(customEvent.trim())',
    );
  });

  it('RISK-ARCHIVE-SNAPSHOT-001: Editoroberfläche übernimmt weiterhin unveränderte Schreib-/Flyover-Bedingungen', () => {
    const doc = source('clients/[id]/subsumtion/subsumtion-document.tsx');
    const surface = doc.slice(
      doc.indexOf('function DocumentEditorSurface'),
      doc.indexOf('export const SubsumtionDocument'),
    );
    expect(surface).toContain('{canEdit && (');
    expect(surface).toContain('analyzed && canEdit && floatingToolbarEnabled && flyover');
    expect(surface).toContain('onReflow={!analyzed && canEdit ? reflow : undefined}');
    expect(doc).toContain('if (changed || !ctxRef.current.canEdit) return;');
    expect(doc).toContain('const best = smallestCoveringMarking(c.markings, plain);');
    expect(doc).toMatch(/useLayoutEffect\(\(\) => \{\s+ctxRef\.current\.analyzed = analyzed;/);
    expect(doc).toMatch(/useLayoutEffect\(\(\) => \{\s+flushRef\.current = async \(\) => \{/);
    expect(doc).toContain("dom.style.setProperty('font-size', `calc(0.875rem * ${zoom})`)");
  });

  it('RISK-EXTERNAL-ANONYMIZATION-001: Workspace extrahiert nur die vier Navigationsklassen', () => {
    const workspace = source('clients/[id]/subsumtion/subsumtion-workspace.tsx');
    for (const view of ['subsumtion', 'recherche', 'aufgaben', 'aktenregal']) {
      expect(workspace).toContain(`workspaceViewClass(view === '${view}'`);
    }
    expect(workspace).toContain("view === 'recherche' ? undefined : 'hidden'");
    expect(workspace).toContain('canEdit={!initial.archivedAt && canWrite}');
    expect(workspace).toContain('<ResearchComposer');
  });
});
