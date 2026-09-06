'use client';
import { useEffect, useRef } from 'react';
import { PayrollActionForm } from '@/components/payroll-action-form';
import { enterEmployeeAction } from './actions';
export function EmployeeEntry({ hasSession = false }: { hasSession?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const token = params.get('invite');
    if (token && input.current) input.current.value = token;
    if (wrapper.current) wrapper.current.hidden = hasSession && !token;
    window.history.replaceState(null, '', window.location.pathname);
  }, [hasSession]);
  return (
    <div ref={wrapper} hidden={hasSession}>
      <PayrollActionForm
        action={async (data) => {
          const result = await enterEmployeeAction(data);
          if (result.ok && wrapper.current) wrapper.current.hidden = true;
          return result;
        }}
        label="Persönlichen Vorgang öffnen"
      >
        <p>
          Dieser Einmallink öffnet ausschließlich Ihren Personalfragebogen. Er schafft keinen
          Mandantenzugang. Bitte den Link nicht weitergeben.
        </p>
        <input ref={input} type="hidden" name="token" />
      </PayrollActionForm>
    </div>
  );
}
