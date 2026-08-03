'use client';

// =============================================================================
// Praesentations-Bausteine des n8n-Formulars (aus n8n-form.tsx herausgeloest):
// reine Leaf-Komponenten ohne Formular-State.
// =============================================================================

import { Check, Clipboard } from 'lucide-react';

export function StatusCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'good' | 'bad' | 'neutral';
}) {
  return (
    <div className="rounded-lg border border-default bg-surface-raised p-3">
      <p className="text-[10px] uppercase tracking-wide text-muted">{label}</p>
      <p
        className={
          tone === 'good'
            ? 'mt-1 text-lg font-semibold text-emerald-700 dark:text-emerald-400'
            : tone === 'bad'
              ? 'mt-1 text-lg font-semibold text-red-700 dark:text-red-400'
              : 'mt-1 text-lg font-semibold text-primary'
        }
      >
        {value}
      </p>
    </div>
  );
}

export function ModeOption({
  checked,
  onChange,
  title,
  description,
}: {
  checked: boolean;
  onChange: () => void;
  title: string;
  description: string;
}) {
  return (
    <label
      className={
        checked
          ? 'cursor-pointer rounded-md border border-blue-500 bg-blue-50 p-3 dark:bg-blue-950/30'
          : 'cursor-pointer rounded-md border border-default p-3'
      }
    >
      <span className="flex items-center gap-2 text-sm font-medium text-primary">
        <input type="radio" checked={checked} onChange={onChange} /> {title}
      </span>
      <span className="mt-1 block pl-5 text-xs text-muted">{description}</span>
    </label>
  );
}

export function SecretKeep({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <label className="mt-1 inline-flex items-center gap-2 text-xs text-muted">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />{' '}
      {label}
    </label>
  );
}

export function ReadOnlyValue({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="label">{label}</p>
      <code className="block break-all rounded bg-surface-raised px-3 py-2 text-xs text-primary">
        {value}
      </code>
    </div>
  );
}

export function CopyButton({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copied: string | null;
  onCopy: (label: string, value: string) => void;
}) {
  return (
    <button
      type="button"
      className="btn-secondary inline-flex shrink-0 items-center gap-1 text-xs"
      onClick={() => onCopy(label, value)}
    >
      {copied === label ? <Check className="h-3 w-3" /> : <Clipboard className="h-3 w-3" />}{' '}
      {copied === label ? 'Kopiert' : 'Kopieren'}
    </button>
  );
}

export function CredentialRow({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copied: string | null;
  onCopy: (label: string, value: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-32 shrink-0 font-medium">{label}</span>
      <code className="min-w-0 flex-1 break-all rounded bg-white/70 px-2 py-1 dark:bg-black/20">
        {value}
      </code>
      <CopyButton label={label} value={value} copied={copied} onCopy={onCopy} />
    </div>
  );
}
