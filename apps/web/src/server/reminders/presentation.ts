import type { StaffSession } from '@/server/auth/staff';
import { parseDelegationNotes } from '@/server/risk/delegate-notes';
import { darfSteuern } from './access';

export function reminderArchiveAvailability(
  session: StaffSession,
  reminder: {
    archivedAt: Date | null;
    doneAt: Date | null;
    doneByStaff: string | null;
    createdByStaff: string;
  },
) {
  const mayManage = darfSteuern(session, reminder);
  return {
    canArchive:
      mayManage && !reminder.archivedAt && Boolean(reminder.doneAt && reminder.doneByStaff),
    canRestore: mayManage && Boolean(reminder.archivedAt),
  };
}

export function reminderResearchContext(reminder: {
  notes: string | null;
  riskMarkings: Array<{ id: string; analysisId: string }>;
  originRiskMarking: { id: string; analysisId: string } | null;
}) {
  const active = reminder.riskMarkings[0] ?? null;
  const origin = reminder.originRiskMarking ?? active;
  const parsed = origin
    ? parseDelegationNotes(reminder.notes)
    : {
        auftrag: reminder.notes?.trim() || null,
        begriff: null,
        normAnker: [],
        fundstelle: null,
      };
  const description = parsed.auftrag;
  return {
    description,
    auftrag: description,
    begriff: parsed.begriff,
    normAnker: parsed.normAnker,
    fundstelle: parsed.fundstelle,
    researchMarkingId: active?.id ?? null,
    researchAnalysisId: active?.analysisId ?? null,
    originResearchMarkingId: origin?.id ?? null,
    originResearchAnalysisId: origin?.analysisId ?? null,
  };
}

export function reminderDate(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

export function reminderStaffName(names: Map<string, string>, id: string | null): string | null {
  return id ? (names.get(id) ?? null) : null;
}
