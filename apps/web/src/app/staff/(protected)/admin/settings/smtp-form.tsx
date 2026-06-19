'use client';

import { useActionState, useState, useTransition, type SubmitEvent } from 'react';
import { Send, RefreshCw, CheckCircle2, AlertCircle } from 'lucide-react';
import {
  saveSmtpAction,
  sendTestMailAction,
  resetSmtpAction,
  type ActionResult,
} from './actions';
import type { SmtpConfig } from '@/server/settings/smtp';

interface Props {
  initial: SmtpConfig | null;
  envFallback: {
    host: string;
    port: number;
    from: string;
  };
  defaultTestTo: string;
}

const COMMON_PRESETS: Array<{ label: string; host: string; port: number; secure: boolean }> = [
  { label: 'Gmail (SMTP-Relay)',       host: 'smtp.gmail.com',          port: 587, secure: false },
  { label: 'Microsoft 365 / Exchange', host: 'smtp.office365.com',      port: 587, secure: false },
  { label: 'mailbox.org',              host: 'smtp.mailbox.org',        port: 465, secure: true  },
  { label: 'IONOS (1&1)',              host: 'smtp.ionos.de',           port: 587, secure: false },
  { label: 'Strato',                   host: 'smtp.strato.de',          port: 465, secure: true  },
  { label: 'Telekom',                  host: 'securesmtp.t-online.de',  port: 465, secure: true  },
];

export function SmtpForm({ initial, envFallback, defaultTestTo }: Props) {
  const [host, setHost] = useState(initial?.host ?? '');
  const [port, setPort] = useState<number>(initial?.port ?? 587);
  const [secure, setSecure] = useState<boolean>(initial?.secure ?? false);
  const [user, setUser] = useState(initial?.user ?? '');
  const [from, setFrom] = useState(initial?.from ?? '');
  const [replyTo, setReplyTo] = useState(initial?.replyTo ?? '');
  const [password, setPassword] = useState('');
  const [keepPassword, setKeepPassword] = useState<boolean>(Boolean(initial && !password));
  const hasInitialPassword = Boolean(initial && initial.password.length > 0);
  const [testTo, setTestTo] = useState(defaultTestTo);
  const [testResult, setTestResult] = useState<ActionResult | null>(null);
  const [isTesting, startTest] = useTransition();
  const [isResetting, startReset] = useTransition();

  const [saveState, saveAction, isSaving] = useActionState<ActionResult | null, FormData>(
    saveSmtpAction,
    null,
  );

  function applyPreset(p: typeof COMMON_PRESETS[number]) {
    setHost(p.host);
    setPort(p.port);
    setSecure(p.secure);
  }

  async function onTest(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    setTestResult(null);
    startTest(async () => {
      const fd = new FormData(form);
      // Werte aus den Hauptfeldern in das Test-Formular überführen
      fd.set('host', host);
      fd.set('port', String(port));
      if (secure) fd.set('secure', 'on');
      fd.set('user', user);
      fd.set('password', password);
      if (keepPassword) fd.set('keepPassword', 'on');
      fd.set('from', from);
      fd.set('replyTo', replyTo);
      fd.set('testTo', testTo);
      const r = await sendTestMailAction(null, fd);
      setTestResult(r);
    });
  }

  function onReset() {
    if (!confirm('Konfiguration zurücksetzen? Mails laufen danach wieder über die ENV-Vorgabe.')) return;
    startReset(async () => {
      await resetSmtpAction();
      window.location.reload();
    });
  }

  return (
    <div className="space-y-6">
      {!initial && (
        <div className="rounded-md border border-blue-200 dark:border-blue-900/60 bg-blue-50 dark:bg-blue-900/20 px-4 py-3 text-xs text-blue-900 dark:text-blue-200">
          Aktuell aktiv: <strong>ENV-Vorgabe</strong> ({envFallback.host}:{envFallback.port}, Absender {envFallback.from}).
          Sobald Sie hier speichern, wird stattdessen die Kanzlei-Konfiguration verwendet.
        </div>
      )}

      <form action={saveAction} className="space-y-4">
        {/* Anbieter-Presets */}
        <div>
          <div className="text-xs text-muted mb-1.5">
            Anbieter-Schnellwahl
          </div>
          <div className="flex flex-wrap gap-2">
            {COMMON_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => applyPreset(p)}
                className="text-xs px-2 py-1 rounded border border-default hover:bg-gray-100 text-secondary"
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <label className="label" htmlFor="host">SMTP-Server</label>
            <input
              id="host"
              name="host"
              type="text"
              className="input"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="smtp.kanzlei.example.de"
              required
            />
          </div>
          <div>
            <label className="label" htmlFor="port">Port</label>
            <input
              id="port"
              name="port"
              type="number"
              className="input"
              value={port}
              onChange={(e) => setPort(Number(e.target.value))}
              min={1}
              max={65535}
              required
            />
          </div>
        </div>

        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="secure"
            checked={secure}
            onChange={(e) => setSecure(e.target.checked)}
          />
          <span>SSL/TLS bei Verbindung (Port 465). Andernfalls STARTTLS opportunistisch.</span>
        </label>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label" htmlFor="user">Benutzername</label>
            <input
              id="user"
              name="user"
              type="text"
              className="input"
              value={user}
              onChange={(e) => setUser(e.target.value)}
              placeholder="(optional, oft Absender-Adresse)"
              autoComplete="off"
            />
          </div>
          <div>
            <label className="label" htmlFor="password">Passwort</label>
            <input
              id="password"
              name="password"
              type="password"
              className="input"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                if (e.target.value) setKeepPassword(false);
              }}
              placeholder={hasInitialPassword && keepPassword ? '⬢⬢⬢⬢⬢⬢⬢⬢' : ''}
              autoComplete="new-password"
            />
            {hasInitialPassword && (
              <label className="mt-1 inline-flex items-center gap-1.5 text-xs text-muted">
                <input
                  type="checkbox"
                  name="keepPassword"
                  checked={keepPassword}
                  onChange={(e) => {
                    setKeepPassword(e.target.checked);
                    if (e.target.checked) setPassword('');
                  }}
                />
                Gespeichertes Passwort beibehalten
              </label>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label" htmlFor="from">Absender (From-Header)</label>
            <input
              id="from"
              name="from"
              type="text"
              className="input"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              placeholder='Kanzlei Mustermann <kanzlei@example.de>'
              required
            />
          </div>
          <div>
            <label className="label" htmlFor="replyTo">Antwort-an (optional)</label>
            <input
              id="replyTo"
              name="replyTo"
              type="text"
              className="input"
              value={replyTo}
              onChange={(e) => setReplyTo(e.target.value)}
              placeholder="info@example.de"
            />
          </div>
        </div>

        <div className="flex items-center justify-between pt-2">
          <button
            type="submit"
            className="btn-primary"
            disabled={isSaving}
          >
            {isSaving ? 'Speichere…' : 'Speichern'}
          </button>
          {saveState?.ok && (
            <span className="trend-up">
              <CheckCircle2 className="h-4 w-4" />
              Gespeichert.
            </span>
          )}
          {saveState && !saveState.ok && (
            <span className="trend-down">
              <AlertCircle className="h-4 w-4" />
              {saveState.error}
            </span>
          )}
        </div>
      </form>

      {/* Test-Versand */}
      <form
        onSubmit={onTest}
        data-settings-no-track
        className="rounded-md border border-default bg-surface-raised p-4 space-y-2"
      >
        <div className="text-sm font-medium text-primary">
          Test-Mail senden
        </div>
        <p className="text-xs text-muted">
          Schickt eine Test-Mail mit den aktuellen Eingaben (ohne zu speichern). So
          prüfen Sie Server und Anmeldedaten, bevor Sie übernehmen.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-[14rem]">
            <label className="label" htmlFor="testTo">Empfänger</label>
            <input
              id="testTo"
              name="testTo"
              type="email"
              className="input"
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
              required
            />
          </div>
          <button
            type="submit"
            className="btn-secondary inline-flex items-center gap-1.5"
            disabled={isTesting || !host || !from}
          >
            <Send className="h-3.5 w-3.5" />
            {isTesting ? 'Sende…' : 'Test senden'}
          </button>
        </div>
        {testResult?.ok && (
          <div className="trend-up">
            <CheckCircle2 className="h-4 w-4" />
            Test-Mail verschickt — bitte Posteingang prüfen.
          </div>
        )}
        {testResult && !testResult.ok && (
          <div className="trend-down">
            <AlertCircle className="h-4 w-4" />
            {testResult.error}
          </div>
        )}
      </form>

      {initial && (
        <div className="border-t border-default pt-4">
          <button
            type="button"
            onClick={onReset}
            disabled={isResetting}
            className="text-xs text-muted hover:text-red-700 dark:hover:text-red-400 inline-flex items-center gap-1.5"
          >
            <RefreshCw className="h-3 w-3" />
            Kanzlei-Konfiguration zurücksetzen (wieder ENV-Fallback verwenden)
          </button>
        </div>
      )}
    </div>
  );
}
