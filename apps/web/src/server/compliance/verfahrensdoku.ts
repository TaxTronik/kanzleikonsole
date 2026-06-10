// =============================================================================
// Selbstbeschreibende GoBD-Verfahrensdokumentation.
//
// Jede Kanzlei braucht eine Verfahrensdokumentation (GoBD Tz. 10.1) — und sie
// veraltet in dem Moment, in dem sie geschrieben wird. TaxTronik WEISS aber,
// was reingehört: aktive Module, Versionsstand, Backup-/Drill-Status,
// Audit-Chain-Zustand, TSA-Konfiguration, Rollen, Aufbewahrungslogik. Dieses
// Modul sammelt den IST-Zustand (collect…) und rendert daraus ein datiertes
// Markdown-Dokument (build…, pure Funktion → testbar). Die Erzeugung selbst
// wird in der Audit-Chain verankert (Route-Handler).
//
// Bewusst Markdown statt PDF: revisionssicher ablegen kann die Kanzlei das
// Dokument als Dokument-Upload (GoBD-Schutzstufe); fürs Layouten reicht jeder
// Markdown-Konverter. Statische Architektur-Aussagen hier müssen mit der
// Realität des Repos übereinstimmen — bei Architekturänderungen mitpflegen.
// =============================================================================

import { withTenantContext, type TenantContext } from '@taxtronik/db';
import {
  AUDIT_VERIFY_RESULT_SETTING_KEY,
  BACKUP_DRILL_RESULT_SETTING_KEY,
  type PersistedDrillResult,
  type PersistedVerifyResult,
} from '@taxtronik/evidence';
import { readModules, type ModuleConfig } from '@/server/settings/modules';
import { readTsaConfig } from '@/server/settings/tsa';
import { getTsaProvider } from '@taxtronik/evidence';

export interface VerfahrensdokuData {
  tenantName: string;
  generatedAt: string; // ISO
  generatedBy: string; // Name des Erzeugers
  appVersion: string;
  gitSha: string;
  modules: ModuleConfig;
  tsaLabel: string;
  lastBackup: { at: string; status: string; sizeBytes: number | null } | null;
  drill: PersistedDrillResult | null;
  auditVerify: PersistedVerifyResult | null;
  counts: {
    staffActive: number;
    clients: number;
    portalContactsActive: number;
    documents: number;
    auditEntries: number;
    archiveSegments: number;
  };
}

export async function collectVerfahrensdokuData(
  ctx: TenantContext,
  generatedBy: string,
): Promise<VerfahrensdokuData> {
  const [tenant, modules, tsa] = await Promise.all([
    withTenantContext(ctx, (tx) =>
      tx.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId }, select: { name: true } }),
    ),
    readModules(ctx),
    readTsaConfig(ctx).catch(() => null),
  ]);

  const [lastBackup, drillSetting, verifySetting, ...counts] = await withTenantContext(
    ctx,
    (tx) =>
      Promise.all([
        tx.backupRecord.findFirst({ orderBy: { startedAt: 'desc' } }),
        tx.tenantSetting.findUnique({
          where: { tenantId_key: { tenantId: ctx.tenantId, key: BACKUP_DRILL_RESULT_SETTING_KEY } },
        }),
        tx.tenantSetting.findUnique({
          where: { tenantId_key: { tenantId: ctx.tenantId, key: AUDIT_VERIFY_RESULT_SETTING_KEY } },
        }),
        tx.staffUser.count({ where: { active: true } }),
        tx.client.count(),
        tx.clientContact.count({ where: { active: true } }),
        tx.document.count({ where: { deletedAt: null } }),
        tx.auditLog.count(),
        tx.auditArchive.count(),
      ]),
  );

  // TSA-Anzeige: Tenant-Override > ENV-Default > Self-Timestamp.
  let tsaLabel = 'Self-Timestamp (KEIN Drittnachweis — nur Dev/Test zulässig)';
  if (tsa?.providerId === 'custom' && tsa.customUrl) tsaLabel = `Eigene TSA: ${tsa.customUrl}`;
  else if (tsa?.providerId) tsaLabel = getTsaProvider(tsa.providerId)?.label ?? tsa.providerId;
  else if (process.env['TIMESTAMP_AUTHORITY_URL']) tsaLabel = `RFC-3161-TSA: ${process.env['TIMESTAMP_AUTHORITY_URL']}`;

  return {
    tenantName: tenant.name,
    generatedAt: new Date().toISOString(),
    generatedBy,
    appVersion: process.env['APP_VERSION'] ?? 'dev',
    gitSha: process.env['GIT_SHA'] ?? 'unknown',
    modules,
    tsaLabel,
    lastBackup: lastBackup
      ? {
          at: lastBackup.startedAt.toISOString(),
          status: lastBackup.status,
          sizeBytes: lastBackup.sizeBytes === null ? null : Number(lastBackup.sizeBytes),
        }
      : null,
    drill: (drillSetting?.value ?? null) as PersistedDrillResult | null,
    auditVerify: (verifySetting?.value ?? null) as PersistedVerifyResult | null,
    counts: {
      staffActive: counts[0],
      clients: counts[1],
      portalContactsActive: counts[2],
      documents: counts[3],
      auditEntries: counts[4],
      archiveSegments: counts[5],
    },
  };
}

const MODULE_LABEL: Partial<Record<keyof ModuleConfig, string>> = {
  bwa: 'BWA-Auswertungen',
  knowledge: 'Wissensdatenbank',
  timeTracking: 'Zeiterfassung',
  phoneNotes: 'Telefonzettel',
  taxNotices: 'Bescheide & Steuertermine',
  workflows: 'Workflows',
  forms: 'Formular-Builder',
  reminders: 'Wiedervorlagen',
  binders: 'Pendelordner',
  handovers: 'Anlieferungen',
  appointments: 'Kanzleikalender',
  rssReader: 'RSS-Reader',
  inboundMail: 'E-Mail-Eingang (n8n)',
};

function d(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
}

/** Reines Rendering — keine IO, vollständig testbar. */
export function buildVerfahrensdoku(data: VerfahrensdokuData): string {
  const activeModules = (Object.keys(MODULE_LABEL) as Array<keyof ModuleConfig>)
    .filter((k) => data.modules[k] === true)
    .map((k) => MODULE_LABEL[k])
    .join(', ');

  const backupLine = data.lastBackup
    ? `Letzte Sicherung: ${d(data.lastBackup.at)} (${data.lastBackup.status}${data.lastBackup.sizeBytes ? `, ${(data.lastBackup.sizeBytes / 1024 / 1024).toFixed(1)} MB` : ''})`
    : 'Letzte Sicherung: NOCH KEINE — Backup-Einrichtung prüfen!';

  const drillLine = data.drill
    ? data.drill.ok
      ? `Letzter Wiederherstellungstest (Restore-Drill): ${d(data.drill.checkedAt)} — ERFOLGREICH; ${data.drill.auditChecked} Audit-Einträge auf der wiederhergestellten Datenbank verifiziert (Backup: ${data.drill.backupKey ?? '—'}).`
      : `Letzter Wiederherstellungstest (Restore-Drill): ${d(data.drill.checkedAt)} — FEHLGESCHLAGEN (${data.drill.error ?? 'unbekannt'}). Maßnahme erforderlich!`
    : 'Wiederherstellungstest (Restore-Drill): noch kein Lauf — der Test läuft automatisch monatlich am 1.';

  const verifyLine = data.auditVerify
    ? data.auditVerify.ok
      ? `Letzte Integritätsprüfung: ${d(data.auditVerify.checkedAt)} — Kette intakt (${data.auditVerify.checked} Einträge, ${data.auditVerify.sealsChecked} Tagesversiegelungen).`
      : `Letzte Integritätsprüfung: ${d(data.auditVerify.checkedAt)} — BRUCH FESTGESTELLT. Sofortige Prüfung erforderlich!`
    : 'Integritätsprüfung: noch kein persistiertes Ergebnis (täglicher Prüfjob, 02:45 UTC).';

  return `# Verfahrensdokumentation nach GoBD

**Kanzlei:** ${data.tenantName}
**Stand:** ${d(data.generatedAt)} (automatisch aus dem laufenden System erzeugt)
**Erstellt durch:** ${data.generatedBy}
**Systemversion:** TaxTronik ${data.appVersion} (Commit ${data.gitSha})

> Dieses Dokument wurde von TaxTronik aus der tatsächlichen Systemkonfiguration
> generiert. Die Erzeugung ist als Ereignis in der revisionssicheren
> Audit-Hash-Chain protokolliert. Es ergänzt die organisatorische
> Verfahrensdokumentation der Kanzlei (Arbeitsanweisungen, Zuständigkeiten)
> um den technischen Teil — es ersetzt sie nicht.

## 1. Allgemeine Beschreibung des Verfahrens

TaxTronik ist das zentrale Kanzlei- und Mandanten-System dieser Kanzlei und
wird **On-Premise** betrieben: alle Daten (Datenbank, Dokumente, Protokolle)
verbleiben auf Systemen unter Kontrolle der Kanzlei. Es verarbeitet
Mandanten-Stammdaten, Dokumente/Belege, Kommunikation über das Mandantenportal,
Fristen sowie Compliance-Workflows (GwG, DSGVO, Vollmachten/eIDAS).

Aktive Module: ${activeModules || '—'}.

Mengengerüst (Stand ${d(data.generatedAt)}): ${data.counts.clients} Mandanten,
${data.counts.documents} Dokumente, ${data.counts.staffActive} aktive
Mitarbeiter-Konten, ${data.counts.portalContactsActive} aktive Portal-Zugänge.

## 2. Technische Systemdokumentation

### 2.1 Zugriffsschutz und Mandantentrennung

- Mitarbeiter-Anmeldung mit Passwort **und TOTP-Zweitfaktor** (verpflichtend);
  Mandanten-Zugang über zeitlich begrenzte Einmal-Anmeldelinks (Magic-Link).
- Mandantentrennung ist **doppelt** erzwungen: applikationsseitige
  Zugriffsprüfungen UND Postgres **Row-Level-Security** als Datenbank-Backstop.
- Rollenmodell (Admin/Partner/Mitarbeiter) mit Tätigkeitsbereichen; Mandanten-
  und Kanzlei-Oberfläche sind technisch getrennte Anmeldekontexte.

### 2.2 Unveränderbarkeit und Protokollierung (GoBD Tz. 8, 10.1)

- Jede compliance-relevante Aktion wird in einer **kryptografischen
  Audit-Hash-Chain** protokolliert (SHA-256-verkettete Einträge, nur anfügbar).
  Aktuell ${data.counts.auditEntries} Einträge, ${data.counts.archiveSegments} unveränderlich archivierte Segmente.
- Tagesversiegelung mit Zeitstempel: **${data.tsaLabel}**.
- ${verifyLine}
- Steuerlich relevante Dokumente liegen im Object-Store mit
  **Object-Lock (COMPLIANCE-Mode, 10 Jahre)** — auch Administratoren können
  sie vor Fristablauf nicht löschen oder ändern. GwG-Unterlagen: 5 Jahre
  (§ 8 Abs. 4 GwG). Jeder Upload durchläuft vor Annahme einen Virenscan
  (ClamAV); nicht bestandene Dateien werden nicht gespeichert.

### 2.3 Datensicherung und Wiederherstellbarkeit (GoBD Tz. 10.2)

- Tägliche Datenbanksicherung (pg_dump, komprimiert, SHA-256-geprüft) in den
  internen Object-Store; Aufbewahrung gemäß Backup-Konzept der Kanzlei.
- ${backupLine}
- ${drillLine}
- Wiederherstellungsverfahren ist dokumentiert (Disaster-Recovery-Runbook)
  und wird zusätzlich bei jeder Software-Änderung automatisiert im
  CI-Selbsttest (Backup→Restore-Roundtrip inkl. Chain-Verifikation) geprüft.

### 2.4 Datenschutz (DSGVO)

- Automatisierte Fristenlöschung läuft täglich (Benachrichtigungen,
  Telefonnotizen, Login-Metadaten) gemäß Löschkonzept.
- Lösch- und Auskunftsanfragen (Art. 15/17) werden im System geführt;
  GwG-Pflichtlöschung und Mandanten-Anonymisierung sind als geführte
  Admin-Prozesse umgesetzt.

## 3. Betriebsdokumentation / Internes Kontrollsystem

- **Updates:** Versionierte, signierte Releases; Einspielen ausschließlich
  durch den Betreiber (kein Auto-Update). Vor jeder Migration wird
  automatisch gesichert; Rollback-Verfahren ist dokumentiert.
- **Überwachung:** Tägliche automatische Integritätsprüfung der Audit-Chain;
  monatlicher automatischer Wiederherstellungstest; optionaler E-Mail-Alarm
  bei Ausfall von Datenbank, Queue, Dokumentenspeicher oder Virenscanner.
- **Vier-Augen-Prinzip:** Freigaben des geteilten Fachwissens (Begriffskatalog)
  erfordern eine zweite Person und werden auditiert.

---
*Generiert von TaxTronik ${data.appVersion}. Dieses Dokument bei wesentlichen
Konfigurationsänderungen neu erzeugen und revisionssicher ablegen.*
`;
}
