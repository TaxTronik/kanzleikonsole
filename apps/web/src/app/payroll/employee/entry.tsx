'use client';
import { useEffect, useState } from 'react';
import { PayrollActionForm } from '@/components/payroll-action-form';
import { enterEmployeeAction } from './actions';
export function EmployeeEntry() {
  const [invite, setInvite] = useState('');
  useEffect(() => {
    function readInvite() {
      const { hash, pathname, search } = window.location;
      const token = new URLSearchParams(hash.slice(1)).get('invite');
      if (token) {
        setInvite(token);
        window.history.replaceState(null, '', pathname + search);
      }
    }
    readInvite();
    window.addEventListener('hashchange', readInvite);
    return () => window.removeEventListener('hashchange', readInvite);
  }, []);

  if (!invite) return null;
  return (
    <PayrollActionForm
      action={enterEmployeeAction}
      onSuccess={() => {
        setInvite('');
        window.location.replace('/payroll/employee');
      }}
      label="Persönlichen Vorgang öffnen"
    >
      <p>
        Dieser Einmallink öffnet ausschließlich Ihren Personalfragebogen. Er schafft keinen
        Mandantenzugang. Bitte den Link nicht weitergeben.
      </p>
      <input type="hidden" name="token" value={invite} />
    </PayrollActionForm>
  );
}
