'use client';
import { useState, useRef } from 'react';
import type { StructureInput } from '@/server/mandate-expansion/model';
import { ActionForm } from '../action-form';
import { saveStructureAction } from '../actions';
export default function StructureEditor({
  initial,
  clients,
}: {
  initial: StructureInput;
  clients: Array<{ id: string; name: string }>;
}) {
  const [data, setData] = useState(initial);
  const [linked, setLinked] = useState('');
  const dragging = useRef<string | null>(null);
  const nodeChange = (key: string, patch: Partial<StructureInput['nodes'][number]>) =>
    setData((d) => ({ ...d, nodes: d.nodes.map((n) => (n.key === key ? { ...n, ...patch } : n)) }));
  const addNode = (kind: 'PERSON' | 'ORGANIZATION' | 'CLIENT') => {
    const client = clients.find((c) => c.id === linked);
    if (kind === 'CLIENT' && (!client || data.nodes.some((n) => n.linkedClientId === linked)))
      return;
    setData((d) => ({
      ...d,
      nodes: [
        ...d.nodes,
        {
          key: crypto.randomUUID(),
          kind,
          label:
            kind === 'CLIENT'
              ? client!.name
              : kind === 'PERSON'
                ? 'Neue Person'
                : 'Neue Gesellschaft',
          linkedClientId: kind === 'CLIENT' ? linked : null,
          x: 40 + (d.nodes.length % 4) * 220,
          y: 40 + (Math.floor(d.nodes.length / 4) % 5) * 100,
        },
      ],
    }));
  };
  return (
    <ActionForm action={saveStructureAction} className="space-y-6">
      <input type="hidden" name="structure" value={JSON.stringify(data)} />
      <p className="text-sm text-muted">
        Manuell dokumentierte direkte Beziehungen. Keine automatische Personenidentität, indirekte
        Beteiligungsquote, wirtschaftlich-berechtigte Person oder Organschaft. Gespeicherte
        Versionen bleiben getrennt von GwG-Freigaben.
      </p>
      <div className="border rounded-lg overflow-hidden bg-slate-50">
        <svg
          viewBox="0 0 1040 600"
          className="w-full touch-none"
          role="img"
          aria-label="Beteiligungsstruktur; alle Angaben sind auch in den Tabellen editierbar"
          onPointerMove={(e) => {
            if (!dragging.current) return;
            const r = e.currentTarget.getBoundingClientRect();
            nodeChange(dragging.current, {
              x: Math.max(0, Math.min(900, ((e.clientX - r.left) / r.width) * 1040 - 70)),
              y: Math.max(0, Math.min(500, ((e.clientY - r.top) / r.height) * 600 - 25)),
            });
          }}
          onPointerUp={() => {
            dragging.current = null;
          }}
          onPointerCancel={() => {
            dragging.current = null;
          }}
        >
          <defs>
            <marker
              id="structure-arrow"
              markerWidth="8"
              markerHeight="8"
              refX="7"
              refY="4"
              orient="auto"
            >
              <path d="M0 0L8 4L0 8Z" fill="#64748b" />
            </marker>
          </defs>
          {data.edges.map((edge, i) => {
            const a = data.nodes.find((n) => n.key === edge.from),
              b = data.nodes.find((n) => n.key === edge.to);
            return a && b ? (
              <g key={i}>
                <line
                  x1={a.x + 70}
                  y1={a.y + 25}
                  x2={b.x + 70}
                  y2={b.y + 25}
                  stroke="#64748b"
                  strokeWidth="2"
                  markerEnd="url(#structure-arrow)"
                />
                <text x={(a.x + b.x) / 2 + 70} y={(a.y + b.y) / 2 + 18} fontSize="12">
                  {edge.percentage === null ? edge.kind : `${edge.percentage}%`}
                </text>
              </g>
            ) : null;
          })}
          {data.nodes.map((n) => (
            <g
              key={n.key}
              transform={`translate(${n.x},${n.y})`}
              onPointerDown={(e) => {
                dragging.current = n.key;
                e.currentTarget.ownerSVGElement?.setPointerCapture(e.pointerId);
              }}
              style={{ cursor: 'grab' }}
            >
              <rect
                width="140"
                height="52"
                rx="7"
                fill={n.kind === 'CLIENT' ? '#dbeafe' : 'white'}
                stroke="#475569"
              />
              <text x="8" y="21" fontSize="12">
                {n.label.length > 21 ? `${n.label.slice(0, 20)}…` : n.label}
              </text>
              <text x="8" y="40" fontSize="10" fill="#64748b">
                {n.kind}
              </text>
            </g>
          ))}
        </svg>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-secondary"
          onClick={() => addNode('PERSON')}
          disabled={data.nodes.length >= 30}
        >
          Person hinzufügen
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => addNode('ORGANIZATION')}
          disabled={data.nodes.length >= 30}
        >
          Externe Gesellschaft hinzufügen
        </button>
        <select
          aria-label="Bestehenden Mandanten verknüpfen"
          className="input max-w-xs"
          value={linked}
          onChange={(e) => setLinked(e.target.value)}
        >
          <option value="">Bestehenden Mandanten wählen</option>
          {clients
            .filter((c) => !data.nodes.some((n) => n.linkedClientId === c.id))
            .map((c) => (
              <option value={c.id} key={c.id}>
                {c.name}
              </option>
            ))}
        </select>
        <button
          type="button"
          className="btn-secondary"
          disabled={!linked || data.nodes.length >= 30}
          onClick={() => addNode('CLIENT')}
        >
          Mandant verknüpfen
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="text-left font-semibold py-2">
            Knoten – alternativ ohne Drag-and-drop bearbeitbar
          </caption>
          <thead>
            <tr>
              <th>Name</th>
              <th>Art / Akte</th>
              <th>X</th>
              <th>Y</th>
              <th>Entfernen</th>
            </tr>
          </thead>
          <tbody>
            {data.nodes.map((n) => (
              <tr key={n.key}>
                <td>
                  <input
                    className="input"
                    aria-label="Knotenname"
                    value={n.label}
                    maxLength={160}
                    readOnly={Boolean(n.linkedClientId)}
                    onChange={(e) => nodeChange(n.key, { label: e.target.value })}
                  />
                </td>
                <td>
                  {n.linkedClientId ? (
                    <a
                      className="text-blue-700 underline"
                      href={`/staff/clients/${n.linkedClientId}`}
                    >
                      Mandantenakte öffnen
                    </a>
                  ) : (
                    n.kind
                  )}
                </td>
                <td>
                  <input
                    className="input w-20"
                    aria-label="X-Position"
                    type="number"
                    min="0"
                    max="900"
                    value={n.x}
                    onChange={(e) => nodeChange(n.key, { x: Number(e.target.value) })}
                  />
                </td>
                <td>
                  <input
                    className="input w-20"
                    aria-label="Y-Position"
                    type="number"
                    min="0"
                    max="500"
                    value={n.y}
                    onChange={(e) => nodeChange(n.key, { y: Number(e.target.value) })}
                  />
                </td>
                <td>
                  <button
                    type="button"
                    disabled={n.linkedClientId === data.clientId}
                    onClick={() =>
                      setData((d) => ({
                        ...d,
                        nodes: d.nodes.filter((v) => v.key !== n.key),
                        edges: d.edges.filter((v) => v.from !== n.key && v.to !== n.key),
                      }))
                    }
                  >
                    Entfernen
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2 className="font-semibold">Direkte Beteiligungen / Kontrolle</h2>
      {data.edges.map((edge, i) => (
        <div className="flex flex-wrap gap-2 border-b pb-3" key={i}>
          {(['from', 'to'] as const).map((side) => (
            <select
              className="input max-w-48"
              aria-label={side === 'from' ? 'Inhaber' : 'Zielgesellschaft'}
              key={side}
              value={edge[side]}
              onChange={(e) =>
                setData((d) => ({
                  ...d,
                  edges: d.edges.map((v, j) => (j === i ? { ...v, [side]: e.target.value } : v)),
                }))
              }
            >
              {data.nodes.map((n) => (
                <option value={n.key} key={n.key}>
                  {n.label}
                </option>
              ))}
            </select>
          ))}
          <select
            className="input max-w-44"
            aria-label="Beziehungsart"
            value={edge.kind}
            onChange={(e) =>
              setData((d) => ({
                ...d,
                edges: d.edges.map((v, j) =>
                  j === i ? { ...v, kind: e.target.value as typeof edge.kind } : v,
                ),
              }))
            }
          >
            <option value="CAPITAL">Kapitalanteil</option>
            <option value="VOTING">Stimmrechte</option>
            <option value="CONTROL">Sonstige Kontrolle</option>
          </select>
          <input
            className="input w-24"
            aria-label="Direkter Anteil in Prozent"
            type="number"
            min="0"
            max="100"
            step="0.01"
            placeholder="% optional"
            value={edge.percentage ?? ''}
            onChange={(e) =>
              setData((d) => ({
                ...d,
                edges: d.edges.map((v, j) =>
                  j === i
                    ? { ...v, percentage: e.target.value === '' ? null : Number(e.target.value) }
                    : v,
                ),
              }))
            }
          />
          <input
            className="input max-w-xs"
            aria-label="Beziehungsnachweis"
            placeholder="Grundlage / Hinweis"
            value={edge.note}
            maxLength={500}
            onChange={(e) =>
              setData((d) => ({
                ...d,
                edges: d.edges.map((v, j) => (j === i ? { ...v, note: e.target.value } : v)),
              }))
            }
          />
          <button
            type="button"
            onClick={() => setData((d) => ({ ...d, edges: d.edges.filter((_, j) => j !== i) }))}
          >
            Entfernen
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn-secondary"
        disabled={data.nodes.length < 2 || data.edges.length >= 90}
        onClick={() =>
          setData((d) => ({
            ...d,
            edges: [
              ...d.edges,
              {
                from: d.nodes[0]!.key,
                to: d.nodes[1]!.key,
                kind: 'CAPITAL',
                percentage: null,
                note: '',
              },
            ],
          }))
        }
      >
        Verbindung hinzufügen
      </button>
      <label className="label">
        Erläuterung / Stand
        <textarea
          className="input"
          value={data.note}
          maxLength={3000}
          onChange={(e) => setData((d) => ({ ...d, note: e.target.value }))}
        />
      </label>
      <button className="btn-primary" type="submit">
        Neue Version speichern
      </button>
    </ActionForm>
  );
}
