'use client';

import { useState, useTransition } from 'react';
import { ShieldCheck } from 'lucide-react';
import { requestSigningOtpAction, signPoaAction } from '@/app/staff/(protected)/poa/actions';

type Stage = 'consent' | 'otp-sent' | 'signed' | 'error';

interface Props {
  token: string;
  signerEmail: string;
}

export function SignFlow({ token, signerEmail }: Props) {
  const [agreed, setAgreed] = useState(false);
  const [otp, setOtp] = useState('');
  const [stage, setStage] = useState<Stage>('consent');
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function requestOtp() {
    setError(null);
    startTransition(async () => {
      const r = await requestSigningOtpAction(token);
      if (r.error) {
        setError(r.error);
      } else {
        setStage('otp-sent');
      }
    });
  }

  function sign() {
    setError(null);
    startTransition(async () => {
      // N1: IP + User-Agent werden serverseitig aus headers() gelesen — der
      // Client darf eIDAS-Audit-Felder nicht selbst liefern. Action-Input
      // trägt nur Token + OTP.
      const r = await signPoaAction({
        rawToken: token,
        otp,
      });
      if (r.error) {
        setError(r.error);
      } else {
        setStage('signed');
      }
    });
  }

  if (stage === 'signed') {
    return (
      <div className="card p-8 text-center">
        <ShieldCheck className="h-12 w-12 text-green-600 mx-auto mb-3" />
        <h2 className="text-lg font-semibold text-gray-900 mb-2">
          Vollmacht unterschrieben
        </h2>
        <p className="text-sm text-gray-600">
          Vielen Dank. Ihre Kanzlei wurde benachrichtigt.
          Sie können dieses Fenster nun schließen.
        </p>
      </div>
    );
  }

  if (stage === 'consent') {
    return (
      <div className="card p-6">
        <h2 className="text-sm font-medium text-gray-900 mb-3">Elektronische Unterschrift</h2>
        <p className="text-sm text-gray-600 mb-4">
          Mit Klick auf „Bestätigungscode anfordern" senden wir Ihnen einen 6-stelligen
          Code an <strong>{signerEmail}</strong>. Mit Eingabe des Codes unterzeichnen Sie
          die Vollmacht elektronisch (eIDAS-konforme fortgeschrittene elektronische
          Signatur via Magic-Link + OTP).
        </p>

        <label className="flex items-start gap-2 text-sm text-gray-700 mb-4">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            className="mt-1"
          />
          <span>
            Ich habe den Vollmachtsinhalt geprüft und stimme der elektronischen
            Unterschrift zu.
          </span>
        </label>

        {error && (
          <div className="rounded-md bg-red-50 p-3 text-sm text-red-700 mb-3">{error}</div>
        )}

        <button
          type="button"
          onClick={requestOtp}
          className="btn-primary w-full"
          disabled={!agreed || isPending}
        >
          {isPending ? 'Sendet…' : 'Bestätigungscode per E-Mail anfordern'}
        </button>
      </div>
    );
  }

  // stage === 'otp-sent'
  return (
    <div className="card p-6">
      <h2 className="text-sm font-medium text-gray-900 mb-3">Bestätigungscode eingeben</h2>
      <p className="text-sm text-gray-600 mb-4">
        Wir haben einen 6-stelligen Code an <strong>{signerEmail}</strong> gesendet.
        Geben Sie den Code unten ein, um die Vollmacht zu unterzeichnen.
      </p>
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]{6}"
        maxLength={6}
        className="input text-center text-2xl tracking-widest mb-3"
        placeholder="000000"
        value={otp}
        onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
        autoFocus
      />
      {error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700 mb-3">{error}</div>
      )}
      <button
        type="button"
        onClick={sign}
        className="btn-primary w-full"
        disabled={otp.length !== 6 || isPending}
      >
        {isPending ? 'Unterschreibt…' : 'Vollmacht jetzt unterzeichnen'}
      </button>
      <button
        type="button"
        onClick={() => { setStage('consent'); setOtp(''); }}
        className="btn-secondary w-full mt-2"
      >
        Zurück
      </button>
    </div>
  );
}
