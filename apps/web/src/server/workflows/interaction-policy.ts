// CLIENT-FEEDBACK-001 / TAX-NOTICE-DECISION-001: these are operational policies, not legal conclusions.
export { FEEDBACK_INTERVAL_DAYS, canInviteFeedback } from '@taxtronik/db/workflow-feedback';
export function validWorkflowCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
export function validInteractionResponse(kind: string, response: string): boolean {
  return kind === 'NOTICE'
    ? ['APPEAL_REQUESTED', 'NO_OBJECTIONS'].includes(response)
    : kind === 'FEEDBACK' && ['1', '2', '3', '4', '5'].includes(response);
}
