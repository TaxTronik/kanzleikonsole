// Fachkatalog: WORKFLOW-LIFECYCLE-001.
// F-13: the timed resume itself (CAS, end-state evidence) moved to the worker job
// workflow-auto-resume and @taxtronik/db/workflow-lifecycle (tests there); the web
// only classifies elapsed pauses for display and must not write on render.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isPauseElapsed } from '../auto-resume';

const NOW = new Date('2026-10-05T08:00:00.000Z');

describe('F-13 elapsed pause display', () => {
  it('marks a paused instance whose resume date has passed', () => {
    expect(
      isPauseElapsed({ status: 'PAUSED', pausedUntil: new Date('2026-10-05T00:00:00Z') }, NOW),
    ).toBe(true);
    expect(isPauseElapsed({ status: 'PAUSED', pausedUntil: NOW }, NOW)).toBe(true);
  });

  it('keeps open-ended, future and non-paused instances as they are', () => {
    expect(isPauseElapsed({ status: 'PAUSED', pausedUntil: null }, NOW)).toBe(false);
    expect(
      isPauseElapsed({ status: 'PAUSED', pausedUntil: new Date('2026-10-06T00:00:00Z') }, NOW),
    ).toBe(false);
    expect(
      isPauseElapsed({ status: 'ACTIVE', pausedUntil: new Date('2026-10-01T00:00:00Z') }, NOW),
    ).toBe(false);
    expect(
      isPauseElapsed({ status: 'CANCELLED', pausedUntil: new Date('2026-10-01T00:00:00Z') }, NOW),
    ).toBe(false);
  });

  it('no longer resumes workflows while rendering the client workflow page', () => {
    const page = readFileSync(
      join(__dirname, '../../../app/staff/(protected)/clients/[id]/workflows/page.tsx'),
      'utf8',
    );
    expect(page).not.toMatch(/autoResumePausedWorkflows|updateMany|evidenceService/);
  });
});
