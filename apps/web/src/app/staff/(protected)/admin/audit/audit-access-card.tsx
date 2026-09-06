import { env } from '@taxtronik/config';
import { CopyField } from '@/components/copy-field';
import { signAuditToken, AUDIT_TOKEN_TTL_DAYS } from '@/server/audit-access/token';

export function AuditAccessCard({ tenantId }: { tenantId: string }) {
  const auditLinkExpiresAt = (() => {
    const now = new Date();
    return (
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) +
      AUDIT_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000
    );
  })();
  return (
    <div className="card p-4 mb-6">
      <h2 className="text-sm font-medium text-primary mb-1">Prüfer-Link (read-only)</h2>
      <p className="text-xs text-muted mb-3">
        Geben Sie diesen Link an einen Wirtschaftsprüfer weiter — er rechnet die Hash-Chain und die
        TSA-Versiegelungen nach, OHNE Zugriff auf Mandantendaten. Gültig {AUDIT_TOKEN_TTL_DAYS}{' '}
        Tage.
      </p>
      <CopyField
        value={`${env.NEXTAUTH_URL.replace(/\/$/, '')}/audit-verify/${signAuditToken(
          tenantId,
          auditLinkExpiresAt,
        )}`}
      />
    </div>
  );
}
