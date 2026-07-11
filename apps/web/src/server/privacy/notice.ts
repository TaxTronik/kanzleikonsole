// =============================================================================
// Datenschutzhinweise (Teil A) — versionierter Standardtext + Kanzlei-Config.
//
// Der Standardtext (A.1–A.11) ist eine versionierte Konstante: ändert er sich
// inhaltlich, wird PRIVACY_NOTICE_VERSION erhöht, sodass nachvollziehbar bleibt,
// welche Fassung ein Mandant akzeptiert hat. Die kanzleispezifischen Angaben
// (Aufsichtsbehörde, DSB, Datenschutz-Kontakt, Drittland-Dienste) liegen in
// tenant_setting `privacy.notice`; die Empfängerliste (A.5) wird aus der
// bestehenden DSGVO-Anbietererfassung (ServiceProvider) gespeist.
//
// Beim Erteilen wird der GERENDERTE Volltext als notice_snapshot eingefroren —
// spätere Config-/Anbieteränderungen berühren alte Einwilligungen nicht.
// =============================================================================

import type { TxClient } from '@taxtronik/db';
import { withTenantContext, type TenantContext } from '@taxtronik/db';

/** Inhaltliche Version des Standardtextes. Bei Textänderung erhöhen. */
export const PRIVACY_NOTICE_VERSION = 2;

const PRIVACY_SETTING_KEY = 'privacy.notice';

/** Kanzleispezifische Angaben (füllen die Platzhalter der Vorlage). */
export interface PrivacyConfig {
  /** Verantwortliche Stelle: Name, Anschrift, Telefon, E-Mail. Leer → Tenant-Name. */
  responsibleBody: string;
  /** Datenschutzbeauftragte/r (Name + Kontakt) oder „nicht benannt". */
  dpoContact: string;
  /** Zuständige Aufsichtsbehörde: Name + Anschrift. */
  supervisoryAuthority: string;
  /** Datenschutz-/Widerrufskontakt der Kanzlei (E-Mail/Anschrift). */
  privacyContact: string;
  /** Konkrete eingesetzte Dienste mit Drittlandbezug oder „keine". */
  drittlandServices: string;
}

export const DEFAULT_PRIVACY_CONFIG: PrivacyConfig = {
  responsibleBody: '',
  dpoContact: 'nicht benannt',
  supervisoryAuthority: '',
  privacyContact: '',
  drittlandServices: 'keine',
};

/** True, wenn die Pflicht-Angaben für einen belastbaren Hinweis gesetzt sind. */
export function isPrivacyConfigComplete(cfg: PrivacyConfig): boolean {
  return (
    cfg.responsibleBody.trim() !== '' &&
    cfg.supervisoryAuthority.trim() !== '' &&
    cfg.privacyContact.trim() !== ''
  );
}

export async function readPrivacyConfig(ctx: TenantContext): Promise<PrivacyConfig> {
  return withTenantContext(ctx, (tx) => readPrivacyConfigTx(tx, ctx.tenantId));
}

export async function readPrivacyConfigTx(tx: TxClient, tenantId: string): Promise<PrivacyConfig> {
  const row = await tx.tenantSetting.findUnique({
    where: { tenantId_key: { tenantId, key: PRIVACY_SETTING_KEY } },
  });
  if (!row) return { ...DEFAULT_PRIVACY_CONFIG };
  return { ...DEFAULT_PRIVACY_CONFIG, ...(row.value as Partial<PrivacyConfig>) };
}

export async function writePrivacyConfig(ctx: TenantContext, cfg: PrivacyConfig): Promise<void> {
  await withTenantContext(ctx, async (tx) => {
    await tx.tenantSetting.upsert({
      where: { tenantId_key: { tenantId: ctx.tenantId, key: PRIVACY_SETTING_KEY } },
      create: {
        tenantId: ctx.tenantId,
        key: PRIVACY_SETTING_KEY,
        value: cfg as object,
        updatedBy: ctx.actorId ?? undefined,
      },
      update: { value: cfg as object, updatedBy: ctx.actorId ?? undefined },
    });
  });
}

/** Eingangsdaten fürs Rendern des Volltextes. */
export interface NoticeRenderInput {
  kanzleiName: string;
  config: PrivacyConfig;
  /** DSGVO-relevante Dienstleister mit Datenzugriff (aus ServiceProvider). */
  providers: Array<{ name: string; category: string }>;
}

/**
 * Rendert die Datenschutzhinweise (Teil A) als Markdown-Volltext. Platzhalter
 * werden aus `config`/`kanzleiName` gefüllt; A.5 (Empfänger) listet zusätzlich
 * die konkret erfassten Dienstleister mit Datenzugriff.
 */
export function renderPrivacyNotice(input: NoticeRenderInput): string {
  const { kanzleiName, config, providers } = input;
  const responsible = config.responsibleBody.trim() || kanzleiName;

  const providerLines =
    providers.length > 0
      ? providers.map((p) => `- ${p.name}${p.category ? ` (${p.category})` : ''}`).join('\n')
      : '- (Derzeit sind keine Dienstleister mit Datenzugriff erfasst.)';

  // Hinweis: Jeder Absatz und jeder Listenpunkt steht bewusst auf EINER Zeile
  // (kein Soft-Wrap, keine weichen Trennstriche). So rendert der Markdown-Parser
  // die Blöcke sauber; der Zeilenumbruch übernimmt der Browser.
  return `# Datenschutzhinweise zur Mandatsbearbeitung

*Kurzfassung:* Die Verarbeitung mandatsnotwendiger Daten erfolgt nicht auf Grundlage einer pauschalen Einwilligung, sondern zur Anbahnung und Durchführung des Steuerberatungsmandats, zur Erfüllung gesetzlicher Pflichten und zur Wahrung berechtigter Interessen. Freiwillige Einwilligungen (Teil B) werden nur dort eingeholt, wo sie rechtlich oder praktisch sinnvoll sind.

**Verantwortliche Stelle:** ${responsible}

**Datenschutzbeauftragte/r:** ${config.dpoContact.trim() || 'nicht benannt'}

## 1. Verantwortlichkeit und berufsrechtliche Einordnung

Die Kanzlei verarbeitet personenbezogene Daten im Rahmen des Steuerberatungsmandats als eigenständig Verantwortliche im Sinne der DSGVO, weisungsfrei unter Beachtung der berufsrechtlichen Verschwiegenheitspflicht. Ein Vertrag zur Auftragsverarbeitung zwischen Mandant und Kanzlei ist für die steuerberatende Tätigkeit regelmäßig nicht erforderlich.

## 2. Zwecke der Verarbeitung

- Mandatsanbahnung, -annahme, Identitäts- und Kollisionsprüfung, Anlage der Akte.
- Steuerliche Beratung, Steuererklärungen, Finanz-/Lohnbuchführung, Jahresabschlüsse, BWA und sonstige beauftragte Leistungen.
- Kommunikation mit Mandanten, Finanzbehörden, Sozialversicherungsträgern, Gerichten, Banken, Versicherern und sonstigen mandatsbezogenen Stellen.
- Erfüllung gesetzlicher, berufs-, handels-, steuer- und geldwäscherechtlicher Pflichten sowie Dokumentations- und Aufbewahrungspflichten.
- Abrechnung, Forderungsmanagement, Qualitätssicherung, Kanzleiorganisation, IT-Sicherheit, Rechtsverfolgung und -verteidigung.

## 3. Kategorien verarbeiteter Daten

Je nach Mandatsumfang insbesondere: Stamm- und Identifikationsdaten (inkl. Steuer-ID/Steuernummer/USt-ID), Kontakt- und Kommunikationsdaten, Mandats-, Vertrags- und Abrechnungsdaten, Steuer-/Finanz-/Buchhaltungs- und Bankdaten, Lohn- und Beschäftigtendaten (soweit beauftragt, inkl. Sozialversicherungs- und Gesundheitsdaten sowie Religionszugehörigkeit für Kirchensteuerzwecke), Daten Dritter (Angehörige, Gesellschafter, Beschäftigte, wirtschaftlich Berechtigte) sowie technische Nutzungsdaten (Portale, Datenräume, IT-Sicherheit).

## 4. Rechtsgrundlagen

- Art. 6 Abs. 1 lit. b DSGVO — Anbahnung/Durchführung/Beendigung des Mandats.
- Art. 6 Abs. 1 lit. c DSGVO — gesetzliche Pflichten (steuer-, handels-, berufs-, geldwäscherechtlich).
- Art. 6 Abs. 1 lit. f DSGVO — berechtigte Interessen (Organisation, IT-Sicherheit, Qualitätssicherung, Forderungsmanagement, Rechtsverfolgung).
- Art. 9 Abs. 2 lit. g DSGVO i. V. m. § 11 StBerG — besondere Datenkategorien, soweit für die steuerberatende Tätigkeit erforderlich.
- Art. 6 Abs. 1 lit. a (ggf. Art. 9 Abs. 2 lit. a) DSGVO — nur bei gesonderter, freiwilliger Einwilligung (Teil B).

## 5. Empfänger und Kategorien von Empfängern

Daten werden nur weitergegeben, soweit zur Mandatsbearbeitung erforderlich, gesetzlich zulässig oder gesondert eingewilligt: Finanzbehörden, Sozialversicherungsträger, Gerichte, Register, Banken, Versicherer; zur Verschwiegenheit verpflichtete Berufsträger/Mitarbeiter/Korrespondenzkanzleien; sowie IT-, Hosting-, Wartungs-, Archiv-, Druck-, Post- und Zahlungsdienstleister, die vertraglich und berufsrechtlich zur Vertraulichkeit verpflichtet sind. Konkret eingesetzte Dienstleister mit Datenzugriff (Stand heute):

${providerLines}

## 6. Drittlandübermittlungen

Eine Übermittlung in Staaten außerhalb der EU/des EWR erfolgt grundsätzlich nicht, es sei denn, dies ist für das Mandat erforderlich, gesetzlich zulässig oder technisch im Rahmen eingesetzter Dienste vorgesehen; dann werden Angemessenheitsbeschlüsse oder geeignete Garantien beachtet. Konkrete Dienste mit Drittlandbezug: ${config.drittlandServices.trim() || 'keine'}.

## 7. Speicherdauer und Löschung

Daten werden gespeichert, solange dies für Mandatsbearbeitung, Abrechnung, Dokumentation und gesetzliche Pflichten erforderlich ist. Handakten werden nach § 66 StBerG grundsätzlich zehn Jahre nach Beendigung des Auftrags aufbewahrt. Für steuer- und handelsrechtliche Unterlagen gelten je Datenklasse insbesondere sechs-, acht- oder zehnjährige Fristen; GwG- und laufende Verfahrens-/Haftungsfristen können abweichen. Danach werden Daten gelöscht, anonymisiert oder — solange eine Pflicht fortbesteht — in der Verarbeitung eingeschränkt.

## 8. Pflicht zur Bereitstellung

Die Bereitstellung der mandatserforderlichen Daten ist regelmäßig vertraglich oder gesetzlich erforderlich; ohne sie kann das Mandat nicht ordnungsgemäß bearbeitet werden.

## 9. Datensicherheit

Die Kanzlei setzt angemessene technische und organisatorische Maßnahmen ein. Für besonders vertrauliche oder umfangreiche Unterlagen wird ein sicherer Weg (Mandantenportal, Datenraum, Ende-zu-Ende-verschlüsselte Kommunikation) empfohlen.

## 10. Rechte betroffener Personen

Betroffene haben Rechte auf Auskunft, Berichtigung, Löschung, Einschränkung, Datenübertragbarkeit und Widerspruch; erteilte Einwilligungen können jederzeit mit Wirkung für die Zukunft widerrufen werden (Art. 7 Abs. 3 DSGVO). Diese Rechte können durch Aufbewahrungs- und Verschwiegenheitspflichten begrenzt sein.

Kontakt: ${config.privacyContact.trim() || '[Datenschutz-Kontakt der Kanzlei]'}.

Beschwerderecht bei der Aufsichtsbehörde: ${config.supervisoryAuthority.trim() || '[Aufsichtsbehörde]'}.

## 11. Automatisierte Entscheidungen

Eine ausschließlich automatisierte Entscheidungsfindung mit rechtlicher Wirkung findet im Rahmen der Mandatsbearbeitung nicht statt.
`;
}
