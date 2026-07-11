import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const protectedRoot = resolve(__dirname, '..');

function source(relativePath: string): string {
  return readFileSync(resolve(protectedRoot, relativePath), 'utf8');
}

describe('destructive staff actions', () => {
  it('requires an explicit confirmation before revoking a power of attorney', () => {
    const page = source('poa/[id]/page.tsx');
    const control = source('poa/[id]/revoke-poa-form.tsx');
    const modal = source('../../../components/ui/modal.tsx');

    expect(page).toContain('<RevokePoaForm');
    expect(page).not.toContain('action={revokePoaAction}');
    expect(control).toContain('<ConfirmModal');
    expect(control).toMatch(/<ConfirmModal\s+danger/);
    expect(control).toContain('await revokePoaAction(formData)');
    expect(control).toContain('htmlFor={reasonId}');
    expect(control).toContain('aria-describedby={hintId}');
    expect(control).toContain('disabled={!trimmedReason}');
    expect(control).toContain('§ 80 Abs. 1 Satz 3 AO');
    expect(control).toContain('§ 80a');
    expect(control).toContain('Abs. 1 Satz 4 AO');
    expect(control).not.toContain('§ 80 Abs. 1 S. 4 AO');
    expect(modal).toContain('role="alert"');
  });

  it('keeps send failures visible instead of discarding the action result', () => {
    const page = source('poa/[id]/page.tsx');
    const control = source('poa/[id]/revoke-poa-form.tsx');

    expect(page).toContain('<SendPoaForm');
    expect(page).not.toContain('await sendForSignatureAction(fd)');
    expect(control).toContain('useActionState<ActionResult | null, FormData>');
    expect(control).toContain('return await sendForSignatureAction(formData)');
    expect(control).toContain(
      "error: actionError(error, 'Die Vollmacht konnte nicht versendet werden.')",
    );
    expect(control).toContain('role="alert"');
    expect(control).toContain('disabled={pending}');
  });

  it('requires an explicit confirmation before anonymizing a DSGVO contact', () => {
    const page = source('admin/dsgvo/[id]/page.tsx');
    const control = source('admin/dsgvo/[id]/anonymize-contact-button.tsx');

    expect(page).toContain('<AnonymizeContactButton');
    expect(page).not.toContain('action={anonymizeContactAction}');
    expect(control).toContain('<ConfirmModal');
    expect(control).toMatch(/<ConfirmModal\s+danger/);
    expect(control).toContain('await anonymizeContactAction(formData)');
    expect(control).toContain('router.refresh()');
    expect(control).toContain('type="button"');
    expect(control).toContain('Dieser Teilschritt lässt sich nicht rückgängig machen');
  });
});
