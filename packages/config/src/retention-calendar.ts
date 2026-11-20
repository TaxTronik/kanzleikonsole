// Produktstichtag für volle Aufbewahrungsjahre nach deutschem Kalenderjahr.
// SQL-TIMESTAMP-Werte übergibt Prisma hier als UTC-kodierte Zeitpunkte.
const yearInBerlin = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Berlin',
  year: 'numeric',
});
const timeInBerlin = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Berlin',
  hourCycle: 'h23',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function firstOfJanuaryUtc(year: number): Date {
  const date = new Date(0);
  date.setUTCFullYear(year, 0, 1);
  return date;
}

/** Technische Freigabe um 00:00 UTC am 1. Januar nach dem letzten vollen Jahr. */
export function retentionAfterBerlinYear(anchor: Date, years: number): Date {
  return firstOfJanuaryUtc(Number(yearInBerlin.format(anchor)) + years + 1);
}

/** Exklusive Obergrenze für den Anker. Exakte Umkehrung des UTC-Freigabestichtags. */
export function dueRetentionAnchorCutoff(now: Date, years: number): Date {
  const jan1 = firstOfJanuaryUtc(now.getUTCFullYear() - years);
  // Um 00:00 UTC ist es in Berlin am selben 1. Januar bereits nach Mitternacht.
  const [hours, minutes, seconds] = timeInBerlin.format(jan1).split(':').map(Number);
  jan1.setUTCHours(-hours!, -minutes!, -seconds!);
  return jan1;
}
