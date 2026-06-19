import type { ReactNode } from 'react';
// =============================================================================
// /audit-verify/[token] — öffentliche, read-only Evidence-Verifikation
//
// Für externe Wirtschaftsprüfer: ein zeitlich begrenzter, signierter Token
// (siehe server/audit-access/token.ts) erlaubt das Nachrechnen der Hash-Chain
// + TSA-Versiegelungen EINER Kanzlei. Es werden KEINE Mandantendaten gezeigt —
// nur die Integritäts-Attestierung (Kette intakt?, Anzahl Einträge/Stempel).
// Kein App-Shell, keine Session.
// =============================================================================

import { ShieldCheck, ShieldAlert, ShieldX } from 'lucide-react';
import { withSystemContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { prismaOwner } from '@/server/db/prisma-owner';
import { verifyAuditToken } from '@/server/audit-access/token';
import { fmtDateTimeMedium, fmtDateMedium } from '@/lib/fmt';

export default async function AuditVerifyPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const decoded = verifyAuditToken(token);

  if (!decoded) {
    return (
      <Shell>
        <div className="text-center">
          <ShieldX className="h-10 w-10 text-red-500 mx-auto mb-3" />
          <h1 className="text-lg font-semibold text-primary mb-1">Link ungültig oder abgelaufen</h1>
          <p className="text-sm text-muted">
            Bitte fordern Sie bei der Kanzlei einen neuen Prüf-Link an.
          </p>
        </div>
      </Shell>
    );
  }

  const tenant = await prismaOwner.tenant.findUnique({
    where: { id: decoded.tenantId },
    select: { name: true },
  });
  if (!tenant) {
    return (
      <Shell>
        <div className="text-center">
          <ShieldX className="h-10 w-10 text-red-500 mx-auto mb-3" />
          <h1 className="text-lg font-semibold text-primary">Kanzlei nicht gefunden</h1>
        </div>
      </Shell>
    );
  }

  const result = await withSystemContext(decoded.tenantId, (tx) =>
    evidenceService.verifyChain(tx, decoded.tenantId),
  );
  const verifiedAt = new Date();

  return (
    <Shell>
      <div className="flex items-center gap-3 mb-4">
        {result.ok ? (
          <ShieldCheck className="h-10 w-10 text-emerald-500 shrink-0" />
        ) : (
          <ShieldAlert className="h-10 w-10 text-red-500 shrink-0" />
        )}
        <div>
          <h1 className="text-lg font-semibold text-primary">
            {result.ok ? 'Manipulationsevidenz intakt' : 'Abweichung festgestellt'}
          </h1>
          <p className="text-sm text-muted">{tenant.name}</p>
        </div>
      </div>

      <dl className="text-sm divide-y divide-border-subtle border-t border-b border-default">
        <Row label="Geprüfte Audit-Einträge" value={result.checked.toLocaleString('de-DE')} />
        <Row label="Geprüfte Tagesversiegelungen" value={result.sealsChecked.toLocaleString('de-DE')} />
        <Row
          label="Versiegelungen mit TSA-Problem"
          value={result.sealBreaks.length.toLocaleString('de-DE')}
          warn={result.sealBreaks.length > 0}
        />
        <Row
          label="Hash-Chain"
          value={result.ok ? 'lückenlos verkettet' : 'gebrochen'}
          warn={!result.ok}
        />
      </dl>

      <p className="text-xs text-disabled mt-4">
        Verifiziert am {fmtDateTimeMedium(verifiedAt)} · Link gültig bis {fmtDateMedium(decoded.expiresAt)}.
        Diese Seite rechnet die SHA-256-Hash-Kette des Audit-Logs nach und prüft die
        RFC-3161-Zeitstempel. Es werden keine personenbezogenen Mandantendaten angezeigt.
      </p>
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-surface-page flex items-center justify-center p-6">
      <div className="card p-8 max-w-lg w-full">{children}</div>
    </div>
  );
}

function Row({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex items-center justify-between py-2.5">
      <dt className="text-muted">{label}</dt>
      <dd className={warn ? 'font-semibold text-red-600' : 'font-medium text-primary'}>{value}</dd>
    </div>
  );
}
