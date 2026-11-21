import { berlinTodayUtcMidnight } from '@taxtronik/tax';
import type { InvoiceMode } from '@/server/settings/modules';

/** INV-NUMBER-ALLOCATION-001: bearbeitbare Datumsvorschläge bei der Rechnungsanlage. */
export function initialInvoiceDates(mode: Exclude<InvoiceMode, 'OFF'>) {
  const issue = berlinTodayUtcMidnight();
  const due = new Date(issue);
  due.setUTCDate(due.getUTCDate() + (mode === 'EXTERNAL' ? 14 : 30));
  return {
    initialIssueDate: issue.toISOString().slice(0, 10),
    initialDueDate: due.toISOString().slice(0, 10),
  };
}
