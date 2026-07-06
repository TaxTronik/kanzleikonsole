// =============================================================================
// Abwesenheits-Vertretung: wer ist HEUTE abwesend, und welche offenen
// Mandantenvorgänge liegen bei deren Mandaten an?
//
// Orga-Hilfe, keine Überwachung: zeigt nur OFFENE Anforderungen der Mandanten
// abwesender Kolleg:innen, damit das Team sie übernehmen kann — keine
// Auswertung von Personen, keine Quoten/Zeiten.
// =============================================================================

import type { TxClient } from '@taxtronik/db';
import { berlinTodayUtcMidnight } from '@/lib/fmt';

export interface CoverageRequest {
  id: string;
  title: string;
  clientId: string;
  clientName: string;
  dueAt: Date | null;
}

export interface CoverageEntry {
  staffId: string;
  fullName: string;
  // iter87: 'absent' statt 'sick' — Krankheit und sonstige Abwesenheit werden
  // im Team bewusst nicht unterschieden (Persönlichkeitsrechte).
  kind: 'vacation' | 'absent';
  until: Date | null;
  requests: CoverageRequest[];
}

export async function loadAbsenceCoverage(tx: TxClient, selfId: string): Promise<CoverageEntry[]> {
  // startDate/endDate sind @db.Date (UTC-Mitternacht). Gegen die aktuelle
  // Uhrzeit verglichen fiele der LETZTE Abwesenheitstag ab 00:00 UTC heraus —
  // daher auf den Berliner Tagesbeginn (UTC-Mitternacht) normalisieren.
  const today = berlinTodayUtcMidnight();

  const [vacations, absences] = await Promise.all([
    tx.vacationRequest.findMany({
      where: { status: 'APPROVED', startDate: { lte: today }, endDate: { gte: today } },
      select: { endDate: true, staff: { select: { id: true, fullName: true } } },
    }),
    tx.absence.findMany({
      where: { startDate: { lte: today }, OR: [{ endDate: null }, { endDate: { gte: today } }] },
      select: { endDate: true, staff: { select: { id: true, fullName: true } } },
    }),
  ]);

  // Abwesende sammeln (Urlaub hat Vorrang bei Doppelnennung). Sich selbst nicht
  // anzeigen — die eigene Abwesenheit braucht keine Vertretungssicht.
  const absent = new Map<string, CoverageEntry>();
  for (const v of vacations) {
    if (v.staff.id === selfId) continue;
    absent.set(v.staff.id, {
      staffId: v.staff.id,
      fullName: v.staff.fullName,
      kind: 'vacation',
      until: v.endDate,
      requests: [],
    });
  }
  for (const s of absences) {
    if (s.staff.id === selfId || absent.has(s.staff.id)) continue;
    absent.set(s.staff.id, {
      staffId: s.staff.id,
      fullName: s.staff.fullName,
      kind: 'absent',
      until: s.endDate,
      requests: [],
    });
  }
  if (absent.size === 0) return [];

  const absentIds = [...absent.keys()];

  // Zuständigkeiten der Abwesenden → Mandanten, die sie betreuen.
  const responsibilities = await tx.clientResponsibility.findMany({
    where: { staffId: { in: absentIds }, role: { in: ['HAUPTBEARBEITER', 'BERUFSTRAEGER'] } },
    select: { staffId: true, clientId: true },
  });
  // clientId → Menge betreuender abwesender Staff
  const clientToStaff = new Map<string, Set<string>>();
  for (const r of responsibilities) {
    if (!clientToStaff.has(r.clientId)) clientToStaff.set(r.clientId, new Set());
    clientToStaff.get(r.clientId)!.add(r.staffId);
  }
  const clientIds = [...clientToStaff.keys()];
  if (clientIds.length === 0) return [...absent.values()];

  // Offene Anforderungen dieser Mandanten.
  const requests = await tx.request.findMany({
    where: { clientId: { in: clientIds }, status: { in: ['OPEN', 'IN_PROGRESS', 'RESPONDED'] } },
    select: { id: true, title: true, clientId: true, dueAt: true, client: { select: { name: true } } },
    orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
    take: 200,
  });

  for (const req of requests) {
    const coveringStaff = clientToStaff.get(req.clientId);
    if (!coveringStaff) continue;
    const entry: CoverageRequest = {
      id: req.id,
      title: req.title,
      clientId: req.clientId,
      clientName: req.client.name,
      dueAt: req.dueAt,
    };
    for (const sid of coveringStaff) {
      absent.get(sid)?.requests.push(entry);
    }
  }

  // Abwesende mit offenen Vorgängen zuerst.
  return [...absent.values()].sort((a, b) => b.requests.length - a.requests.length);
}
