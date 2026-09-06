import { payrollDownload } from '@/server/payroll/download';
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return payrollDownload('employee', (await params).id);
}
