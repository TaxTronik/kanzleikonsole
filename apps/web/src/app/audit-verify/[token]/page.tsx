import type { ReactNode } from 'react';
import { createHash } from 'node:crypto';
import { headers } from 'next/headers';
// =============================================================================
// /audit-verify/[token] — öffentliche, read-only Evidence-Verifikation
//
// Für externe Wirtschaftsprüfer: ein zeitlich begrenzter, signierter Token
// (siehe server/audit-access/token.ts) erlaubt das Nachrechnen der Hash-Chain
// + Rolling-Anker/Tagesversiegelungen EINER Kanzlei. Es werden KEINE
// Mandantendaten gezeigt — nur die Integritäts-Attestierung.
// Kein App-Shell, keine Session.
// =============================================================================

import { ShieldCheck, ShieldAlert, ShieldX } from 'lucide-react';
import { withSystemContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { prismaOwner } from '@/server/db/prisma-owner';
import { verifyAuditToken } from '@/server/audit-access/token';
import { checkIpOrGlobalLimit, checkRateLimit, getClientIp } from '@/server/rate-limit';
import { fmtDateTimeMedium, fmtDateMedium } from '@/lib/fmt';

export default async function AuditVerifyPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ip = getClientIp(await headers());
  // `getClientIp` liefert null, wenn kein vertrauenswuerdiger Proxy-Header
  // vorliegt. Roh interpoliert ergaebe das den Schluessel "…:null" — alle
  // anonymen Aufrufer teilten sich einen Bucket mit 20 Abrufen, und ein
  // einzelner Spammer sperrte die Verifikation fuer saemtliche externen
  // Pruefer. checkIpOrGlobalLimit faellt stattdessen auf eine weitere globale
  // Quota zurueck: Sturm-Schutz statt Lockout-Surface.
  const ipLimit = await checkIpOrGlobalLimit(
    'audit-verify-ip',
    ip,
    { max: 20, windowSec: 600 },
    { max: 200, windowSec: 600 },
  );
  if (!ipLimit.ok) return <RateLimitShell />;

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

  // Ein gültiger Link würde sonst pro Abruf die komplette Hash-Kette des
  // Tenants nachrechnen. Der tokenweite Bucket stoppt auch verteilte Abrufe
  // über viele IPs; im Browser landet nur ein nicht umkehrbarer Fingerprint.
  const tokenFingerprint = createHash('sha256').update(token).digest('hex').slice(0, 24);
  const tokenLimit = await checkRateLimit(`audit-verify-token:${tokenFingerprint}`, {
    max: 10,
    windowSec: 600,
  });
  if (!tokenLimit.ok) return <RateLimitShell />;

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
        <Row
          label="Geprüfte Tagesversiegelungen"
          value={result.sealsChecked.toLocaleString('de-DE')}
        />
        <Row label="Geprüfte Rolling-Anker" value={result.anchorsChecked.toLocaleString('de-DE')} />
        <Row
          label="Rolling-Anker mit Problem"
          value={result.anchorBreaks.length.toLocaleString('de-DE')}
          warn={result.anchorBreaks.length > 0}
        />
        <Row
          label="Lokal noch unverankerte Einträge"
          value={result.unanchoredEntries.toLocaleString('de-DE')}
          warn={result.unanchoredEntries > 0}
        />
        <Row
          label="Versiegelungen mit TSA-Problem"
          value={result.sealBreaks.length.toLocaleString('de-DE')}
          warn={result.sealBreaks.length > 0}
        />
        <Row
          label="Zeitstempel-Modus"
          value={
            result.tsaMode === 'rfc3161' ? 'externe TSA (RFC 3161)' : 'lokal — keine externe TSA'
          }
          warn={result.tsaMode !== 'rfc3161'}
        />
        {result.tsaMode === 'rfc3161' && result.sealsChecked > 0 && (
          <Row
            label="Trust-verankerte Siegel"
            value={`${result.sealsTrustAnchored ?? 0} / ${result.sealsChecked}`}
            warn={(result.sealsTrustAnchored ?? 0) < result.sealsChecked}
          />
        )}
        {result.tsaMode === 'rfc3161' && result.anchorsChecked > 0 && (
          <Row
            label="Trust-verankerte Rolling-Anker"
            value={`${result.anchorsTrustAnchored} / ${result.anchorsChecked}`}
            warn={result.anchorsTrustAnchored < result.anchorsChecked}
          />
        )}
        <Row
          label="Hash-Chain"
          value={result.ok ? 'lückenlos verkettet' : 'gebrochen'}
          warn={!result.ok}
        />
      </dl>

      <p className="text-xs text-disabled mt-4">
        Verifiziert am {fmtDateTimeMedium(verifiedAt)} · Link gültig bis{' '}
        {fmtDateMedium(decoded.expiresAt)}. Diese Seite rechnet die SHA-256-Hash-Kette des
        Audit-Logs und der gekoppelten externen Anchor-Kette nach und prüft die
        RFC-3161-Zeitstempel. Es werden keine personenbezogenen Mandantendaten angezeigt.
      </p>
    </Shell>
  );
}

function RateLimitShell() {
  return (
    <Shell>
      <div className="text-center">
        <ShieldAlert className="h-10 w-10 text-yellow-500 mx-auto mb-3" />
        <h1 className="text-lg font-semibold text-primary mb-1">Prüfung vorübergehend begrenzt</h1>
        <p className="text-sm text-muted">
          Bitte warten Sie einige Minuten und rufen Sie den Prüf-Link dann erneut auf.
        </p>
      </div>
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
