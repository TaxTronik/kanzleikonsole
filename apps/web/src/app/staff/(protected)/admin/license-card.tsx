import { KeyRound, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import type { LicenseInfo } from '@/server/license/verify';
import { fmtDateShort } from '@/lib/fmt';


export function LicenseCard({ info }: { info: LicenseInfo }) {
  const tone = toneFor(info.status);
  const Icon = iconFor(info.status);

  return (
    <div
      className={`rounded-lg border p-4 mb-6 flex items-start gap-3 ${tone.container}`}
    >
      <Icon className={`h-5 w-5 mt-0.5 shrink-0 ${tone.icon}`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className={`text-sm font-medium ${tone.title}`}>
            {info.kanzleiName ? `Lizenz — ${info.kanzleiName}` : 'Lizenz'}
          </h2>
          {info.plan && (
            <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium bg-white/60 dark:bg-gray-900/60 text-secondary">
              {info.plan}
            </span>
          )}
        </div>
        <p className={`text-xs mt-1 ${tone.message}`}>{info.message}</p>
        {info.validUntil && (
          <p className="text-xs text-secondary mt-1">
            Gültig bis {fmtDateShort(info.validUntil)}
            {typeof info.daysRemaining === 'number' && info.daysRemaining >= 0 &&
              ` (noch ${info.daysRemaining} Tage)`}
            {typeof info.daysRemaining === 'number' && info.daysRemaining < 0 &&
              ` (${-info.daysRemaining} Tage abgelaufen)`}
          </p>
        )}
        {(info.maxStaff != null || info.maxClients != null) && (
          <p className="text-xs text-secondary mt-0.5">
            Limit:
            {info.maxStaff != null && ` ${info.maxStaff} Mitarbeiter`}
            {info.maxStaff != null && info.maxClients != null && ' ·'}
            {info.maxClients != null && ` ${info.maxClients} Mandanten`}
          </p>
        )}
        {info.status === 'UNCONFIGURED' && (
          <p className="text-xs text-muted mt-2">
            Lizenz konfigurieren via <code>LICENSE_KEY</code> + <code>LICENSE_PUBLIC_KEY</code> in der .env.
          </p>
        )}
      </div>
    </div>
  );
}

function toneFor(s: LicenseInfo['status']) {
  switch (s) {
    case 'VALID':
      return {
        container: 'border-green-200 bg-green-50 dark:border-emerald-900/40 dark:bg-emerald-900/10',
        icon: 'text-green-600',
        title: 'text-green-900 dark:text-emerald-200',
        message: 'text-green-700 dark:text-emerald-300',
      };
    case 'EXPIRED':
      return {
        container: 'border-amber-200 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-900/10',
        icon: 'text-amber-600',
        title: 'text-amber-900 dark:text-amber-200',
        message: 'text-amber-700 dark:text-amber-300',
      };
    case 'INVALID':
      return {
        container: 'border-red-200 bg-red-50 dark:border-red-900/40 dark:bg-red-900/10',
        icon: 'text-red-600',
        title: 'text-red-900 dark:text-red-200',
        message: 'text-red-700 dark:text-red-300',
      };
    case 'UNCONFIGURED':
    default:
      return {
        container: 'border-default bg-surface-raised',
        icon: 'text-muted',
        title: 'text-primary',
        message: 'text-secondary',
      };
  }
}

function iconFor(s: LicenseInfo['status']) {
  switch (s) {
    case 'VALID': return CheckCircle2;
    case 'EXPIRED': return AlertTriangle;
    case 'INVALID': return XCircle;
    case 'UNCONFIGURED':
    default: return KeyRound;
  }
}
