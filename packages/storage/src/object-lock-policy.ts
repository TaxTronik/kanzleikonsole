import type { ObjectLockConfiguration } from '@aws-sdk/client-s3';

export type RequiredLockMode = 'GOVERNANCE' | 'COMPLIANCE';

export function evaluateObjectLockConfiguration(
  config: ObjectLockConfiguration | undefined,
  expected: { mode: RequiredLockMode; years: number },
): { ok: boolean; detail: string } {
  if (config?.ObjectLockEnabled !== 'Enabled') {
    return {
      ok: false,
      detail:
        'Object-Lock NICHT aktiv — Bucket muss mit --object-lock-enabled-for-bucket angelegt werden.',
    };
  }

  const retention = config.Rule?.DefaultRetention;
  if (retention?.Mode !== expected.mode || retention.Years !== expected.years) {
    const actualMode = retention?.Mode ?? '—';
    const actualDuration =
      retention?.Years !== undefined
        ? `${retention.Years} Jahre`
        : retention?.Days !== undefined
          ? `${retention.Days} Tage`
          : '—';
    return {
      ok: false,
      detail: `Default-Retention falsch: ${actualMode}/${actualDuration}; erwartet ${expected.mode}/${expected.years} Jahre.`,
    };
  }

  return {
    ok: true,
    detail: `Enabled (Default ${expected.mode}/${expected.years} Jahre)`,
  };
}
