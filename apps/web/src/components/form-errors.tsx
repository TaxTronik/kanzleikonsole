'use client';

import { useEffect, useId, useRef } from 'react';

export type FieldErrors = Record<string, string[] | undefined>;

export function fieldErrorId(fieldName: string, prefix = 'field'): string {
  return `${prefix}-${fieldName.replace(/[^a-zA-Z0-9_-]/g, '-')}-error`;
}

export function fieldErrorProps(
  fieldName: string,
  fieldErrors: FieldErrors | undefined,
  options: { prefix?: string; describedBy?: string } = {},
): { 'aria-invalid'?: true; 'aria-describedby'?: string } {
  const errors = fieldErrors?.[fieldName];
  const ids = [options.describedBy, errors?.length ? fieldErrorId(fieldName, options.prefix) : null]
    .filter(Boolean)
    .join(' ');
  return {
    ...(errors?.length ? { 'aria-invalid': true as const } : {}),
    ...(ids ? { 'aria-describedby': ids } : {}),
  };
}

export function FieldError({
  name,
  errors,
  prefix,
}: {
  name: string;
  errors?: readonly string[];
  prefix?: string;
}) {
  if (!errors?.length) return null;
  return (
    <div id={fieldErrorId(name, prefix)} className="mt-1 text-sm text-danger">
      {errors.map((message, index) => (
        <p key={`${message}-${index}`}>{message}</p>
      ))}
    </div>
  );
}

export function FormErrorSummary({
  error,
  fieldErrors,
  fieldIds = {},
  title = 'Bitte prüfen Sie Ihre Angaben.',
}: {
  error?: string;
  fieldErrors?: FieldErrors;
  fieldIds?: Record<string, string>;
  title?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const instanceId = useId();
  const entries = Object.entries(fieldErrors ?? {}).filter(([, messages]) => messages?.length);
  const visible = Boolean(error || entries.length);

  useEffect(() => {
    if (visible) ref.current?.focus();
  }, [visible, error, instanceId]);

  if (!visible) return null;
  return (
    <div ref={ref} role="alert" tabIndex={-1} className="alert-error-sm outline-none">
      <p className="font-medium">{title}</p>
      {error && entries.length === 0 ? <p className="mt-1">{error}</p> : null}
      {entries.length ? (
        <ul className="mt-2 list-disc space-y-1 pl-5">
          {entries.flatMap(([name, messages]) =>
            (messages ?? []).map((message, index) => (
              <li key={`${name}-${message}-${index}`}>
                {fieldIds[name] ? (
                  <a className="underline" href={`#${fieldIds[name]}`}>
                    {message}
                  </a>
                ) : (
                  message
                )}
              </li>
            )),
          )}
        </ul>
      ) : null}
    </div>
  );
}
