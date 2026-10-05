// F-17: DST behaviour of the registered cron schedules, evaluated with BullMQ's
// own repeat strategy (cron-parser) — independent of the process time zone.
import { defaultRepeatStrategy } from 'bullmq';
import { describe, expect, it } from 'vitest';
import {
  JOB_QUEUES,
  type QueueScheduleDefinition,
  type ScheduleTimeZone,
} from '@taxtronik/config/job-queues';

// Last Sundays of March/October: Europe/Berlin skips 02:00-03:00 on the first,
// repeats it on the second.
const SPRING_FORWARD = '2027-03-28';
const FALL_BACK = '2026-10-25';
const MINUTE = 60_000;

type CronRepeat = { pattern: string; tz: ScheduleTimeZone };

function cronSchedules(): Array<[string, CronRepeat]> {
  return Object.values(JOB_QUEUES).flatMap((queue) => {
    const schedule: QueueScheduleDefinition | null = queue.schedule;
    return schedule != null && 'pattern' in schedule.repeat
      ? [[queue.name, schedule.repeat as CronRepeat]]
      : [];
  });
}

/** Runs like the worker computes them: each next run from the previous run time. */
function runsBetween(repeat: CronRepeat, fromIso: string, toIso: string): Date[] {
  const end = Date.parse(toIso);
  const runs: Date[] = [];
  let cursor = Date.parse(fromIso);
  for (;;) {
    const next = defaultRepeatStrategy(cursor, { pattern: repeat.pattern, tz: repeat.tz });
    if (next == null || next > end) return runs;
    runs.push(new Date(next));
    cursor = next + 1;
  }
}

function localDay(date: Date, tz: ScheduleTimeZone): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(date);
}

function localTime(date: Date, tz: ScheduleTimeZone): string {
  return new Intl.DateTimeFormat('de-DE', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

describe('F-17 schedule time zones across daylight-saving switches', () => {
  it('runs the 02:30 evidence seal and the 02:45 verification exactly once on the spring-forward day', () => {
    for (const [repeat, expected] of [
      [JOB_QUEUES.evidenceSeal.schedule.repeat, '2027-03-28T02:30:00.000Z'],
      [JOB_QUEUES.auditVerify.schedule.repeat, '2027-03-28T02:45:00.000Z'],
    ] as const) {
      const runs = runsBetween(repeat, '2027-03-27T12:00:00Z', '2027-03-29T00:00:00Z');
      expect(runs.map((run) => run.toISOString())).toEqual([expected]);
    }
  });

  it('documents why: the same 02:30 pattern in Europe/Berlin is moved off its slot on that day', () => {
    const runs = runsBetween(
      { pattern: '30 2 * * *', tz: 'Europe/Berlin' },
      '2027-03-27T12:00:00Z',
      '2027-03-29T00:00:00Z',
    );
    // 02:30 does not exist in Berlin on 28 March 2027; cron-parser runs at 03:30 CEST.
    expect(runs.map((run) => localTime(run, 'Europe/Berlin'))).toEqual(['03:30']);
  });

  it.each([
    ['spring forward', SPRING_FORWARD],
    ['fall back', FALL_BACK],
  ])(
    'fires every daily cron schedule once per local day at its nominal time (%s)',
    (_label, day) => {
      const from = new Date(Date.parse(`${day}T00:00:00Z`) - 3 * 24 * 60 * MINUTE).toISOString();
      const to = new Date(Date.parse(`${day}T00:00:00Z`) + 3 * 24 * 60 * MINUTE).toISOString();
      for (const [name, repeat] of cronSchedules()) {
        const [minute, hour, dayOfMonth, , dayOfWeek] = repeat.pattern.split(' ');
        if (dayOfMonth !== '*' || dayOfWeek !== '*') continue;
        const runs = runsBetween(repeat, from, to);
        const perDay = new Map<string, string[]>();
        for (const run of runs) {
          const key = localDay(run, repeat.tz);
          perDay.set(key, [...(perDay.get(key) ?? []), localTime(run, repeat.tz)]);
        }
        const hours = hour!.includes('/')
          ? (() => {
              const [range, step] = hour!.split('/');
              const [first, last] = range!.split('-').map(Number);
              const result: number[] = [];
              for (let h = first!; h <= last!; h += Number(step)) result.push(h);
              return result;
            })()
          : [Number(hour)];
        const expected = hours.map(
          (h) => `${String(h).padStart(2, '0')}:${String(Number(minute)).padStart(2, '0')}`,
        );
        // The switch day and its neighbours: same slots, no skip, no duplicate.
        for (const key of [...perDay.keys()].filter(
          (k) => k !== localDay(new Date(from), repeat.tz),
        )) {
          expect({ name, day: key, times: perDay.get(key) }).toEqual({
            name,
            day: key,
            times: expected,
          });
        }
        expect({ name, switchDay: perDay.has(day) }).toEqual({ name, switchDay: true });
      }
    },
  );

  it('keeps every Europe/Berlin schedule out of the 02:00-03:00 switch window', () => {
    for (const [name, repeat] of cronSchedules()) {
      if (repeat.tz !== 'Europe/Berlin') continue;
      const hour = repeat.pattern.split(' ')[1]!;
      const [range, step] = hour.split('/');
      const [first, last] = range!.split('-').map(Number);
      const hours: number[] = [];
      for (let h = first!; h <= (last ?? first)!; h += step ? Number(step) : 1) hours.push(h);
      expect({ name, hours: hours.includes(2) }).toEqual({ name, hours: false });
    }
  });
});
