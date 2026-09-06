import { readFormSchema } from '@/server/forms/schema-snapshot';
import { validateFormAnswers } from '@/server/forms/validate-answers';
import { berlinWallClockToUtc } from '@/lib/fmt';

// Fachkatalog: YEAR-END-CAMPAIGN-001. Progress describes entered values, never professional completeness.
export function formAnswerProgress(snapshot: unknown, rawAnswers: unknown) {
  if (!snapshot || !rawAnswers || typeof rawAnswers !== 'object' || Array.isArray(rawAnswers))
    return null;
  try {
    const fields = readFormSchema(snapshot, {
      name: '',
      description: null,
      introMd: null,
      fields: [],
    }).fields.filter((f) => f.type !== 'INFO_TEXT');
    const answers = rawAnswers as Record<string, unknown>;
    let filled = 0,
      requiredFilled = 0;
    for (const field of fields) {
      const value = answers[field.key];
      if (
        value === undefined ||
        value === null ||
        (typeof value === 'string' && value.trim() === '') ||
        (Array.isArray(value) && value.length === 0)
      )
        continue;
      try {
        validateFormAnswers([field], { [field.key]: value }, { requireRequired: true });
        filled++;
        if (field.required) requiredFilled++;
      } catch {
        /* Invalid values do not count towards progress. */
      }
    }
    return {
      filled,
      total: fields.length,
      requiredFilled,
      requiredTotal: fields.filter((f) => f.required).length,
      percent: fields.length ? Math.round((filled / fields.length) * 100) : null,
    };
  } catch {
    return null;
  }
}
export function campaignSubmissionPhase(
  submission: { status: string; submittedAt: Date | null },
  requestStatus?: string,
) {
  if (requestStatus === 'CANCELLED') return 'CANCELLED';
  if (submission.status === 'REVIEWED') return 'REVIEWED';
  if (submission.status === 'SUBMITTED') return 'SUBMITTED';
  if (requestStatus === 'CLOSED') return 'CLOSED';
  if (submission.status === 'DRAFT' && submission.submittedAt) return 'RETURNED';
  return submission.status === 'DRAFT' ? 'IN_PROGRESS' : 'PENDING';
}

const berlinMonth = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Berlin',
  year: 'numeric',
  month: '2-digit',
});
function monthKey(date: Date) {
  const p = berlinMonth.formatToParts(date);
  return p.find((p) => p.type === 'year')!.value + '-' + p.find((p) => p.type === 'month')!.value;
}
export function feedbackMonthWindow(now = new Date()) {
  const current = monthKey(now);
  const [year, month] = current.split('-').map(Number);
  const keys = Array.from({ length: 12 }, (_, i) => {
    const date = new Date(Date.UTC(year!, month! - 12 + i, 1));
    return date.toISOString().slice(0, 7);
  });
  return { keys, start: berlinWallClockToUtc(keys[0] + '-01T00:00')!, end: now };
}
// Fachkatalog: CLIENT-FEEDBACK-001. Denominator is invitations in the same visible invitation-month cohort.
export function feedbackMonthlyTrend(
  rows: ReadonlyArray<{
    kind: string;
    createdAt: Date;
    respondedAt: Date | null;
    response: string | null;
  }>,
  now = new Date(),
) {
  const window = feedbackMonthWindow(now);
  return window.keys.map((month) => {
    const invites = rows.filter(
      (row) => row.kind === 'FEEDBACK' && row.createdAt <= now && monthKey(row.createdAt) === month,
    );
    const ratings = invites
      .filter(
        (row) => row.respondedAt && row.respondedAt <= now && /^[1-5]$/.test(row.response ?? ''),
      )
      .map((row) => Number(row.response));
    return {
      month,
      invitations: invites.length,
      responses: ratings.length,
      average: ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null,
      responseRate: invites.length ? (ratings.length / invites.length) * 100 : null,
    };
  });
}
