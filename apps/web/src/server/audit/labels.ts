// =============================================================================
// Audit-Action / Resource-Type Labels — deutsche Anzeigen für UIs
//
// Compliance-View (/staff/admin/audit) bleibt absichtlich technisch
// (zeigt `action` und `resourceType` als Rohstring), weil das die formelle
// Audit-Spur ist. Diese Datei wird in „freundlichen" Views verwendet:
// Dashboard, Mandanten-Aktivitätsstrom, Notifications.
// =============================================================================

export const ACTION_LABELS: Record<string, string> = {
  // Mandanten
  'client.created': 'Mandant angelegt',
  'client.update.administrative': 'Mandanten-Verwaltungsdaten geändert',
  'client.update.gwg_relevant': 'GwG-relevante Stammdaten geändert',
  'client.responsibilities.update': 'Bearbeiter-Zuordnung aktualisiert',
  'client.mandate.end': 'Mandat beendet (GwG-Löschuhr gestartet)',
  'client.mandate.reopen': 'Mandat wieder aufgenommen',
  'client.anonymize': 'Mandant anonymisiert (DSGVO Art. 17)',
  'client.belege.export': 'DATEV-Belege exportiert',
  'subsumtion.report.export': 'Subsumtions-Report exportiert',
  'client.onboarding.complete': 'Onboarding abgeschlossen',

  // Dokumente
  'document.upload': 'Dokument hochgeladen',
  'document.upload.pending': 'Dokument-Upload vorgemerkt',
  'document.upload.complete': 'Dokument-Upload abgeschlossen',
  'document.download': 'Dokument heruntergeladen',
  'document.preview': 'Dokument angesehen',
  'document.version.add': 'Neue Dokument-Version',
  'document.delete': 'Dokument gelöscht (ausgeblendet)',
  'document.restore': 'Dokument wiederhergestellt',
  'document.retag': 'Dokument-Typ geändert',
  'document.move_folder': 'Dokument in Ordner verschoben',
  'document.share': 'Dokument für Mandant freigegeben',
  'document.unshare': 'Mandanten-Freigabe zurückgezogen',
  'document.text_extract': 'Dokumenttext extrahiert',

  // Dokument-Ablage (Ordner + Typen)
  'document_folder.create': 'Ordner angelegt',
  'document_folder.rename': 'Ordner umbenannt',
  'document_folder.delete': 'Ordner gelöscht',
  'document_folder.move': 'Ordner verschoben',
  'document_type.create': 'Datei-Typ angelegt',
  'document_type.update': 'Datei-Typ geändert',
  'document_type.delete': 'Datei-Typ gelöscht',

  // Anforderungen
  'request.create': 'Anforderung erstellt',
  'request.response': 'Antwort gesendet',
  'request.response.inbound_mail': 'Antwort per E-Mail eingegangen',
  'request.close': 'Anforderung geschlossen',

  // Telefonzettel
  'phone_note.create': 'Telefonzettel erstellt',
  'phone_note.done': 'Telefonzettel erledigt',
  'phone_note.undone': 'Telefonzettel zurück auf offen',
  'phone_note.forward': 'Telefonzettel übertragen',
  'phone_note.to_reminder': 'Telefonzettel in Wiedervorlage überführt',

  // RSS-Feeds
  'rss_feed.add': 'RSS-Feed hinzugefügt',
  'rss_feed.delete': 'RSS-Feed entfernt',
  'rss_feed.enable': 'RSS-Feed aktiviert',
  'rss_feed.disable': 'RSS-Feed deaktiviert',
  'rss_feed.reset_defaults': 'RSS-Defaults wiederhergestellt',

  // Kanzleikalender
  'appointment.create': 'Termin angelegt',
  'appointment.update': 'Termin geändert',
  'appointment.delete': 'Termin gelöscht',
  'appointment_request.create': 'Terminanfrage gestellt',
  'appointment_request.accept': 'Terminanfrage angenommen',
  'appointment_request.reject': 'Terminanfrage abgelehnt',
  'appointment_request.cancel': 'Terminanfrage zurückgenommen',

  // Portal-Zugänge
  'client_contact.create': 'Ansprechpartner angelegt',
  'client_contact.update': 'Ansprechpartner aktualisiert',
  'client_contact.deactivate': 'Ansprechpartner deaktiviert',
  'client_contact.ical_rotate': 'Kalender-Feed-URLs widerrufen (iCal)',

  // GwG-Prüfung
  'gwg.check.open': 'GwG-Prüfung gestartet',
  'gwg.check.assess': 'GwG-Risikobewertung',
  'gwg.check.submit_for_review': 'GwG-Prüfung zur Freigabe eingereicht',
  'gwg.owner.add': 'Wirtschaftlich Berechtigter erfasst',
  'gwg.owner.update': 'Wirtschaftlich Berechtigten aktualisiert',
  'gwg.owner.remove': 'Wirtschaftlich Berechtigten aus aktuellem Prüfsnapshot entfernt',
  'gwg.id_document.add': 'Ausweisdokument erfasst',
  'gwg.id_document.update': 'Ausweisangaben geprüft und aktualisiert',
  'gwg.id_document.set_files_update': 'Dateien eines Ausweissatzes aktualisiert',
  'gwg.check.verify': 'GwG-Prüfung verifiziert',
  'gwg.check.reject': 'GwG-Prüfung abgelehnt',
  'gwg.evidence.add': 'GwG-Rechtsträgernachweis zugeordnet',
  'gwg.legal_entity_details.update': 'GwG-Register- und Vertretungsdaten aktualisiert',
  'gwg.evidence.destroy.request': 'Vernichtung von GwG-Belegen angefordert',
  'gwg.evidence.destroy': 'GwG-Beleg vernichtet (§ 8 Abs. 4)',
  'gwg.check.destroy': 'GwG-Aufzeichnungen vernichtet (§ 8 Abs. 4)',
  // RF-8: System-Statuswechsel aus dem Worker (gwg-expiry-check)
  'gwg.check.expire': 'GwG-Prüfung abgelaufen (System)',
  'client.deactivate.gwg_expired': 'Mandant deaktiviert — GwG-Prüfung abgelaufen',

  // Rechnungen
  'invoice.create': 'Rechnung erstellt',
  'invoice.create.from_time': 'Rechnung aus Zeiterfassung',
  'invoice.send': 'Rechnung versendet',
  'invoice.paid': 'Rechnung bezahlt',
  'invoice.cancel': 'Rechnung storniert',
  'invoice.storno.create': 'Stornorechnung erstellt',
  // RF-8: System-Statuswechsel aus dem Worker (invoice-overdue-check)
  'invoice.overdue': 'Rechnung überfällig (System)',
  'invoice.xrechnung.download': 'XRechnung exportiert',
  'invoice.zugferd.download': 'ZUGFeRD exportiert',

  // Vollmachten
  'poa.create': 'Vollmacht erstellt',
  'poa.send': 'Vollmacht versendet',
  'poa.sign': 'Vollmacht signiert',
  'poa.revoke': 'Vollmacht widerrufen',
  'poa.signer.anonymize': 'Unterzeichnerdaten der Vollmacht anonymisiert',
  // RF-8: System-Statuswechsel aus dem Worker (poa-expiry-check)
  'poa.expire': 'Vollmacht abgelaufen (System)',

  // Steuertermine + Bescheide
  'tax_schedule.create': 'Steuertermin-Konfig erstellt',
  'tax_schedule.update': 'Steuertermin-Konfig geändert (Fristen)',
  'tax_schedule.deactivate': 'Steuertermin-Konfig deaktiviert',
  'tax_deadline.auto_request': 'Auto-Anforderung erzeugt',
  'tax_deadline.complete': 'Steuertermin erledigt',
  'tax_notice.create': 'Bescheid erfasst',
  'elster.kontoabfrage': 'ELSTER-Kontoabfrage durchgeführt',
  'privacy.consent.grant': 'Datenschutz-Einwilligung erfasst',
  'privacy.consent.revoke': 'Datenschutz-Einwilligung widerrufen',
  'privacy.config.update': 'Kanzlei-Datenschutzangaben geändert',
  'privacy.consent_options.update': 'Datenschutz-Einwilligungsoptionen geändert',
  'tax_notice.status': 'Bescheid-Status geändert',

  // BWA
  'bwa.import': 'BWA-Daten importiert',
  'bwa.delete': 'BWA-Periode gelöscht',

  // Zeiterfassung
  'time_entry.start': 'Zeiterfassung gestartet',
  'time_entry.stop': 'Zeiterfassung beendet',
  'time_entry.delete': 'Zeiterfassung gelöscht',

  // Abwesenheiten
  'vacation.request': 'Urlaubsantrag',
  'vacation.approve': 'Urlaubsantrag genehmigt',
  'vacation.reject': 'Urlaubsantrag abgelehnt',
  'vacation.cancel': 'Urlaubsantrag zurückgezogen',
  // 'sick.create' bleibt für Alt-Einträge in der Chain lesbar; seit iter87
  // heißt der Vorgang absence.report (generische Abwesenheitsmeldung).
  'sick.create': 'Krankmeldung',
  'absence.report': 'Abwesenheitsmeldung',
  'absence.end': 'Abwesenheit beendet',
  'absence.delete': 'Abwesenheitsmeldung gelöscht',

  // Knowledge-Base
  'kb.article.create': 'Wissensartikel erstellt',
  'kb.article.update': 'Wissensartikel aktualisiert',
  'kb.article.delete': 'Wissensartikel gelöscht',
  'kb.category.create': 'Wissens-Kategorie erstellt',

  // Tenant-Einstellungen
  'tenant.settings.seller.update': 'Kanzlei-Stammdaten geändert',
  'tenant.settings.branding.update': 'Branding geändert',

  // Dienstleister
  'service_provider.create': 'Dienstleister angelegt',
  'service_provider.delete': 'Dienstleister gelöscht',

  // DSGVO
  'dsgvo.request.create': 'DSGVO-Anfrage erstellt',
  'dsgvo.request.received': 'DSGVO-Anfrage eingegangen',
  'dsgvo.request.in_progress': 'DSGVO-Anfrage in Bearbeitung',
  'dsgvo.request.completed': 'DSGVO-Anfrage abgeschlossen',
  'dsgvo.request.rejected': 'DSGVO-Anfrage abgelehnt',
  'dsgvo.export.contact': 'DSGVO-Datenauskunft',
  'dsgvo.anonymize.contact': 'DSGVO-Anonymisierung',
  'dsgvo.retention.run': 'DSGVO-Fristenlöschung (System)',

  // Portal-Settings
  'portal.notifications.toggle': 'Portal-Benachrichtigungen geändert',

  // Exporte
  'requests.export.csv': 'Anforderungen exportiert (CSV)',
  'invoices.export.csv': 'Rechnungen exportiert (CSV)',
  'fristen.export.csv': 'Fristenkontrollbuch exportiert (CSV)',
  'clients.export.csv': 'Mandanten exportiert (CSV)',
  'audit.export.csv': 'Audit-Log exportiert (CSV)',

  // Workflows
  'workflow.template.create': 'Workflow-Vorlage angelegt',
  'workflow.template.update': 'Workflow-Vorlage geändert',
  'workflow.template.delete': 'Workflow-Vorlage gelöscht',
  'workflow.instance.start': 'Workflow gestartet',

  // Formular-Builder
  'form.template.create': 'Formular-Vorlage angelegt',
  'form.template.update': 'Formular-Vorlage geändert',
  'form.template.delete': 'Formular-Vorlage gelöscht',
  'form.submission.create': 'Formular versendet',
  'form.submission.submit': 'Formular ausgefüllt',
  'form.submission.upload': 'Formular-Datei hochgeladen',

  // Mitarbeiter
  'staff.create': 'Mitarbeiter angelegt',
  'staff.activate': 'Mitarbeiter aktiviert',
  'staff.deactivate': 'Mitarbeiter deaktiviert',
  'staff.roles.update': 'Mitarbeiter-Rollen geändert',
  'staff.permissions.update': 'Mitarbeiter-Berechtigungen geändert',
  'staff.skills.update': 'Mitarbeiter-Tätigkeiten geändert',
  'staff_skill.create': 'Tätigkeit angelegt',
  'staff_skill.update': 'Tätigkeit geändert',
  'staff_skill.delete': 'Tätigkeit gelöscht',

  // Tenant-Einstellungen (weitere)
  'tenant.settings.modules.update': 'Module geändert',
  'tenant.settings.access_policy.update': 'Zugriffsmodell geändert',
  'tenant.settings.tax_region.update': 'Steuer-Region geändert',
  'tenant.settings.smtp.update': 'SMTP-Einstellungen geändert',
  'tenant.settings.smtp.reset': 'SMTP-Einstellungen zurückgesetzt',
  'tenant.settings.tsa.update': 'Zeitstempel-Behörde geändert',
  'tenant.settings.n8n.update': 'n8n-Verbindung geändert',
  'tenant.settings.n8n.reset': 'n8n-Verbindung zurückgesetzt',
  'tenant.settings.n8n.delete': 'n8n-Verbindung deaktiviert und bereinigt',
  'tenant.settings.n8n.callback_token.rotate': 'n8n-Callback-Token rotiert',
  'tenant.settings.n8n.endpoint.upsert': 'n8n-Workflow-Route geändert',
  'tenant.settings.n8n.endpoint.delete': 'n8n-Workflow-Route entfernt',
  'tenant.settings.n8n.delivery.retry': 'n8n-Zustellung erneut eingeplant',
  'tenant.settings.n8n.delivery.acknowledge': 'n8n-Zustellfehler quittiert',
  'tenant.settings.n8n.event.replay': 'n8n-Event nachträglich zugeordnet',
  'tenant.settings.n8n.event.skip': 'n8n-Event ohne Versand abgeschlossen',
  'tenant.settings.n8n.workflows_import': 'n8n-Workflows importiert',
  'workflow.item.execute': 'Workflow-Schritt angestoßen',
  'workflow.instance.cancel': 'Workflow abgebrochen',
  'workflow.instance.delete': 'Workflow endgültig gelöscht',
  'workflow.instance.restore': 'Workflow wiederhergestellt',
  'workflow.instance.pause': 'Workflow pausiert',
  'workflow.instance.resume': 'Workflow fortgesetzt',
  'workflow.instance.auto_resume': 'Workflow automatisch fortgesetzt',
  'workflow.item.add': 'Workflow-Schritt hinzugefügt',
  'workflow.item.handover': 'Workflow-Schritt übergeben',
  'workflow.item.comment': 'Workflow-Schritt kommentiert',
  'workflow.instance.members_update': 'Workflow-Team geändert',
  'document.acknowledge': 'Dokument-Empfang bestätigt',
  'document.unacknowledge': 'Empfangsbestätigung zurückgenommen',
  'client_reminder.create': 'Wiedervorlage angelegt',
  'client_reminder.done': 'Wiedervorlage erledigt',
  'client_reminder.delete': 'Wiedervorlage gelöscht',
  'pending_binder.create': 'Pendelordner angelegt',
  'pending_binder.status_change': 'Pendelordner-Status geändert',
  'pending_binder.delete': 'Pendelordner gelöscht',
  'client_handover.create': 'Anlieferung angelegt',
  'client_handover.start': 'Anlieferung in Bearbeitung',
  'client_handover.ready': 'Anlieferung abholbereit gemeldet',
  'client_handover.picked_up': 'Anlieferung abgeholt',
  'client_handover.status_change': 'Anlieferungs-Status geändert',
  'client_handover.delete': 'Anlieferung gelöscht',
  'tenant.settings.letterhead.update': 'Briefkopf geändert',
  'tenant.settings.legal.update': 'Rechtliche Links geändert',
  'tenant.settings.mail_dispatch.update': 'Mail-Dispatch-Modus geändert',
  'tenant.settings.client_layout.update': 'Mandanten-Cockpit-Layout geändert',
  'tenant.settings.portal_features.update': 'Mandantenportal-Features geändert',
  'invoice_category.create': 'Rechnungstyp angelegt',
  'invoice_category.update': 'Rechnungstyp geändert',
  'invoice_category.delete': 'Rechnungstyp gelöscht',
  'invoice.upload': 'Externe Rechnung hochgeladen',
  'invoice.archive.zugferd': 'ZUGFeRD-Archiv erzeugt',
  'email_template.create': 'E-Mail-Vorlage angelegt',
  'email_template.update': 'E-Mail-Vorlage geändert',
  'email_template.delete': 'E-Mail-Vorlage gelöscht',

  // GwG-Onboarding (Mandanten-Selbstidentifizierung)
  'gwg.onboarding.invite': 'GwG-Onboarding eingeladen',
  'gwg.onboarding.cancel': 'GwG-Onboarding abgebrochen',
  'gwg.onboarding.upload.id': 'GwG-Onboarding: Ausweis hochgeladen',
  'gwg.onboarding.upload.extra': 'GwG-Onboarding: Zusatzdokument hochgeladen',
  'gwg.onboarding.submit': 'GwG-Onboarding eingereicht',

  // Stammdaten-Änderungsanträge (Mandanten-Self-Service)
  'client_master_change.submit': 'Stammdaten-Änderung beantragt',
  'client_master_change.approve': 'Stammdaten-Änderung genehmigt',
  'client_master_change.reject': 'Stammdaten-Änderung abgelehnt',

  // Audit-Archiv
  'audit.rotate.trigger': 'Audit-Rotation gestartet',
  'audit.verify.trigger': 'Audit-Verifikation gestartet',
  'audit.recovery.checkpoint': 'Audit-Recovery-Checkpoint gesetzt',

  // Auth-/Systemereignisse (Audit-Lücke geschlossen: Logins standen vorher
  // nur in flüchtigen pino-Logs, nicht in der Hash-Chain)
  'auth.login.success': 'Anmeldung erfolgreich',
  'auth.login.failure': 'Anmeldung fehlgeschlagen',
  'auth.login.lockout': 'Konto gesperrt (Fehlversuche)',
  'auth.totp.enroll': 'TOTP eingerichtet',
  'auth.backup_code.consume': 'Backup-Code verwendet (Recovery)',
  'auth.magic_link.consume': 'Portal-Anmeldung (Magic-Link)',
  'auth.portal.profile.switch': 'Mandantenprofil gewechselt',
  'backup.trigger': 'Backup manuell gestartet',
  'backup.run': 'Backup-Lauf',
  'backup.download': 'Backup heruntergeladen',
  'backup.download_denied': 'Backup-Download blockiert',
  'backup.drill.completed': 'Restore-Test erfolgreich (System)',
  'backup.drill.failed': 'Restore-Test fehlgeschlagen (System)',
  'compliance.verfahrensdoku.generated': 'Verfahrensdokumentation erzeugt',

  // Custom-Felder
  'client_custom_field.create': 'Custom-Feld angelegt',
  'client_custom_field.update': 'Custom-Feld geändert',
  'client_custom_field.delete': 'Custom-Feld gelöscht',
  'client_custom_field.values.update': 'Custom-Werte gespeichert',

  // Status-Maschinen
  'state_machine.create': 'Status-Maschine angelegt',
  'state_machine.update': 'Status-Maschine geändert',
  'state_machine.delete': 'Status-Maschine gelöscht',
  'state_machine.definition.save': 'Status-Maschine-Definition gespeichert',

  // Steuererklärungen / Vor-Bescheide
  'tax_filing.create': 'Steuererklärung erfasst',
  'tax_filing.update': 'Steuererklärung geändert',
  'tax_filing.delete': 'Steuererklärung gelöscht',
  'tax_filing.share': 'Steuererklärung an Mandant freigegeben',
  'tax_filing.unshare': 'Steuererklärungs-Freigabe zurückgezogen',

  // Anforderungs-Vorlagen
  'request_template.create': 'Anforderungs-Vorlage angelegt',
  'request_template.update': 'Anforderungs-Vorlage geändert',
  'request_template.delete': 'Anforderungs-Vorlage gelöscht',

  // BWA-Planrechnungen
  'bwa_plan.create': 'BWA-Planung erstellt',
  'bwa_plan.update': 'BWA-Planung geändert',
  'bwa_plan.delete': 'BWA-Planung gelöscht',

  // Tax-News-Opt-in
  'staff.tax_news.opt_in': 'BMF/BFH-Benachrichtigungen aktiviert',
  'staff.tax_news.opt_out': 'BMF/BFH-Benachrichtigungen deaktiviert',

  // Risk-Layer / Subsumtion (TCMS)
  'risk.analysis.created': 'Subsumtion angelegt',
  'risk.analysis.reanalyzed': 'Subsumtion neu analysiert',
  'risk.analysis.reformatted': 'Subsumtion neu formatiert',
  'risk.analysis.llm_enriched': 'Subsumtion mit KI vertieft',
  'risk.analysis.archived': 'Subsumtion archiviert',
  'risk.marking.created': 'Markierung erstellt',
  'risk.marking.decided': 'Markierung bewertet',
  'risk.marking.norms_curated': 'Rechtsnormen kuratiert',
  'risk.marking.delegated': 'Recherche delegiert',
  'risk.marking.deleted': 'Markierung gelöscht',
  'risk.catalog.defined': 'Katalog-Begriff definiert',
  'risk.catalog.norm_curated': 'Katalog-Norm kuratiert',
  'risk.catalog.reviewed': 'Katalog-Review-Status gesetzt',
  'risk.research.sent': 'Rechercheauftrag gesendet',
  'risk.research.received': 'Rechercheergebnis empfangen',
  'risk.research.submitted': 'Rechercheergebnis eingereicht',
  'risk.research.assigned': 'Rechercheergebnis zugeordnet',
  'risk.research.discarded': 'Rechercheergebnis verworfen',
  'risk.research.archived': 'Rechercheergebnis archiviert',
  'risk.research.restored': 'Rechercheergebnis reaktiviert',
  'risk.research.verworfen': 'Rechercheergebnis geprüft und verworfen',
  'subsumtion.vertraulich.gesetzt': 'Subsumtion als vertraulich gekennzeichnet',
  'subsumtion.vertraulich.aufgehoben': 'Vertraulichkeit der Subsumtion aufgehoben',
  'risk.research.deleted': 'Rechercheergebnis gelöscht',
  'risk.research.saved_to_shelf': 'Rechercheergebnis im Aktenregal abgelegt',
  'risk.los.beantragt': 'Quantenlos beantragt (QPU-Queue)',
  'risk.los.gezogen': 'Quantenlos-Stichprobe gezogen',
  'tenant.settings.quantenlos_ibm.update': 'IBM-Quantum-Zugang (Quantenlos) hinterlegt',
  'tenant.settings.quantenlos_ibm.reset': 'IBM-Quantum-Zugang (Quantenlos) entfernt',
};

export const RESOURCE_TYPE_LABELS: Record<string, string> = {
  client: 'Mandant',
  client_contact: 'Ansprechpartner',
  document: 'Dokument',
  document_folder: 'Ordner',
  document_type: 'Datei-Typ',
  request: 'Anforderung',
  phone_note: 'Telefonzettel',
  gwg_check: 'GwG-Prüfung',
  invoice: 'Rechnung',
  power_of_attorney: 'Vollmacht',
  tax_schedule_config: 'Steuertermin-Konfig',
  tax_deadline: 'Steuertermin',
  tax_notice: 'Bescheid',
  bwa_period: 'BWA-Periode',
  time_entry: 'Zeiteintrag',
  vacation_request: 'Urlaubsantrag',
  sick_leave: 'Krankmeldung',
  absence: 'Abwesenheitsmeldung',
  kb_article: 'Wissensartikel',
  kb_category: 'Wissens-Kategorie',
  service_provider: 'Dienstleister',
  dsgvo_request: 'DSGVO-Anfrage',
  tenant_setting: 'Kanzlei-Einstellung',
  workflow_template: 'Workflow-Vorlage',
  workflow_instance: 'Workflow',
  form_template: 'Formular-Vorlage',
  form_submission: 'Formular',
  staff_user: 'Mitarbeiter',
  staff_skill: 'Tätigkeit',
  client_master_change_request: 'Stammdaten-Änderung',
  gwg_onboarding_invite: 'GwG-Onboarding',
  audit_archive: 'Audit-Archiv',
  client_custom_field_def: 'Custom-Feld-Definition',
  backup_record: 'Backup',
  backup: 'Backup',
  state_machine: 'Status-Maschine',
  tax_filing: 'Steuererklärung',
  request_template: 'Anforderungs-Vorlage',
  bwa_plan: 'BWA-Planung',
  tax_news_item: 'BMF/BFH-Eintrag',
  client_reminder: 'Wiedervorlage',
  pending_binder: 'Pendelordner',
  rss_feed: 'RSS-Feed',
  appointment: 'Termin',
  appointment_request: 'Terminanfrage',
  client_handover: 'Anlieferung',
  invoice_category: 'Rechnungstyp',
  risk_analysis: 'Subsumtion',
  risk_marking: 'Markierung',
  risk_research_request: 'Rechercheauftrag',
  risk_research_result: 'Rechercheergebnis',
  quantenlos: 'Quantenlos-Ziehung',
};

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

export function resourceLabel(resourceType: string): string {
  return RESOURCE_TYPE_LABELS[resourceType] ?? resourceType;
}
