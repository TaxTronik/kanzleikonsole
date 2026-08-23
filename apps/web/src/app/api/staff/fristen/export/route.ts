// =============================================================================
// CSV-Export des Fristenkontrollbuchs — der Erledigungsnachweis (z. B. für
// Berufshaftpflicht/Organisationsnachweis). Jeder Export landet als
// fristen.export.csv in der Audit-Hash-Chain.
// =============================================================================

import { NextResponse, type NextRequest } from 'next/server';
import { getClientIp, checkStaffExportLimit } from '@/server/rate-limit';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { toCsv, csvResponse, type CsvColumn } from '@/server/export/csv';
import { loadKontrollbuch } from '@/server/fristen/kontrollbuch';
import { QUELLE_LABELS, type FristEintrag } from '@/server/fristen/eintrag';
import { readModules } from '@/server/settings/modules';

const RANGES = [7, 30, 90];

export async function GET(req: NextRequest) {
  const session = await staffAuth();
  if (!session?.user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { tenantId, staffId } = session.user;
  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };
  const modules = await readModules(ctx);

  const rl = await checkStaffExportLimit('fristen', staffId);
  if (!rl.ok) {
    return NextResponse.json({ error: 'rate_limited', retryAfter: rl.retryAfter }, { status: 429 });
  }

  const sp = req.nextUrl.searchParams;
  const tage = RANGES.includes(Number(sp.get('tage'))) ? Number(sp.get('tage')) : 30;
  const nurMeine = sp.get('wer') === 'meine';

  const rows = await withTenantContext(ctx, async (tx) => {
    const eintraege = await loadKontrollbuch(tx, session, {
      tage,
      nurStaffId: nurMeine ? staffId : null,
      sources: { taxNotices: modules.taxNotices, reminders: modules.reminders },
    });
    // Der Export ist der Nachweis — er wird in der Chain dokumentiert
    // (RESTRICTED-Filterung übernimmt der Loader).
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'fristen.export.csv',
      resourceType: 'tenant',
      resourceId: tenantId,
      after: { tage, nurMeine, eintraege: eintraege.length },
      ip: getClientIp(req.headers),
    });
    return eintraege;
  });

  const columns: CsvColumn<FristEintrag>[] = [
    {
      key: 'faelligAm',
      label: 'Faellig am',
      accessor: (e) => e.faelligAm.toISOString().slice(0, 10),
    },
    { key: 'art', label: 'Art', accessor: (e) => QUELLE_LABELS[e.quelle] },
    { key: 'frist', label: 'Frist', accessor: (e) => e.titel },
    { key: 'mandant', label: 'Mandant', accessor: (e) => e.clientName },
    { key: 'verantwortlich', label: 'Verantwortlich', accessor: (e) => e.verantwortlich ?? '' },
    { key: 'status', label: 'Status', accessor: (e) => (e.erledigt ? 'erledigt' : 'offen') },
    {
      key: 'erledigtAm',
      label: 'Erledigt am',
      accessor: (e) => (e.erledigtAm ? e.erledigtAm.toISOString().slice(0, 10) : ''),
    },
    { key: 'erledigtVon', label: 'Erledigt von', accessor: (e) => e.erledigtVon ?? '' },
  ];

  return csvResponse(`fristenkontrollbuch-${tage}tage`, toCsv(rows, columns));
}
