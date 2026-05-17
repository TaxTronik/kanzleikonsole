'use client';

import { useState, useTransition } from 'react';
import { createStateMachineAction } from './actions';

export function NewMachineForm() {
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [appliesTo, setAppliesTo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isPending, start] = useTransition();

  function submit() {
    setError(null);
    start(async () => {
      const r = await createStateMachineAction({
        slug: slug.trim(),
        name: name.trim(),
        description: description.trim() || null,
        appliesTo: appliesTo.trim() || null,
      });
      if (r && !r.ok) {
        setError(r.error ?? 'Fehler beim Anlegen.');
      }
      // redirect() im Action navigiert weg — sonst hier nichts zu tun
    });
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">Slug (technisch)</label>
          <input
            type="text"
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            maxLength={40}
            placeholder="onboarding_phase"
            className="input font-mono text-sm"
          />
        </div>
        <div>
          <label className="label">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            placeholder="Onboarding-Phase"
            className="input"
          />
        </div>
      </div>
      <div>
        <label className="label">Beschreibung (optional)</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          maxLength={500}
          className="input text-sm"
        />
      </div>
      <div>
        <label className="label">Geltungsbereich (optional, Freitext)</label>
        <input
          type="text"
          value={appliesTo}
          onChange={(e) => setAppliesTo(e.target.value)}
          maxLength={60}
          placeholder="z. B. client, gwg_check"
          className="input text-sm"
        />
      </div>
      {error && <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>}
      <button type="button" onClick={submit} disabled={isPending} className="btn-primary">
        {isPending ? 'Legt an…' : 'Anlegen'}
      </button>
    </div>
  );
}
