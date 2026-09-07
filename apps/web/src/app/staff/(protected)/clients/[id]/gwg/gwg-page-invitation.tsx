import { Stage } from '@/components/stage';
import { fmtDateTimeShort } from '@/lib/fmt';
import { InviteSection } from './invite-section';
import type { GwgPageModel } from './gwg-page-model';
import type { GwgPageData } from './gwg-page-data';
export function GwgInvitation({ model, data }: { model: GwgPageModel; data: GwgPageData }) {
  const { client, check, gwgSteps, eingereicht, openInvites, latestInvite } = model;
  const { contacts, invites } = data;
  return (
    <div className="mb-6">
      <Stage
        num={1}
        state={check ? gwgSteps[0]!.state : 'active'}
        title="Einladung an den Mandanten"
        sub="Mandant füllt Stammdaten und Ausweis-Fotos selbst aus — ohne Login."
        badge={
          eingereicht ? (
            <span className="badge badge-green">Eingereicht</span>
          ) : openInvites > 0 ? (
            <span className="badge badge-yellow">
              {openInvites} {openInvites === 1 ? 'Einladung' : 'Einladungen'} offen
            </span>
          ) : (
            <span className="badge badge-gray">Keine Einladung</span>
          )
        }
      >
        {latestInvite && (
          <dl className="mb-4 grid grid-cols-1 gap-3 rounded-md border border-default bg-surface-raised p-3 md:grid-cols-3">
            <div>
              <dt className="text-xs text-muted">Eingeladen</dt>
              <dd className="text-sm font-medium text-primary">
                {latestInvite.inviteName} · {latestInvite.inviteEmail}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Gültig bis</dt>
              <dd className="text-sm font-medium text-primary">
                {latestInvite.expiresAt ? fmtDateTimeShort(new Date(latestInvite.expiresAt)) : '—'}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Übermittelt</dt>
              <dd className="text-sm font-medium text-primary">
                {latestInvite.submittedAt
                  ? fmtDateTimeShort(new Date(latestInvite.submittedAt))
                  : '—'}
              </dd>
            </div>
          </dl>
        )}
        <InviteSection
          clientId={client.id}
          clientName={client.name}
          gwgCheckId={check?.status === 'DRAFT' ? check.id : undefined}
          disabledReason={
            check && check.status !== 'DRAFT'
              ? check.status === 'IN_REVIEW'
                ? 'Die Prüfung ist bereits eingereicht. Änderungen müssen sie zuerst wieder in den Entwurf zurücksetzen.'
                : 'Starten Sie zuerst unten einen neuen Änderungs- oder Wiederholungszyklus; die Einladung wird anschließend exakt an dessen Entwurf gebunden.'
              : undefined
          }
          contacts={contacts}
          invites={invites.map((i) => ({
            id: i.id,
            inviteName: i.inviteName,
            inviteEmail: i.inviteEmail,
            status: i.status,
            createdAt: i.createdAt.toISOString(),
            expiresAt: i.expiresAt.toISOString(),
            submittedAt: i.submittedAt?.toISOString() ?? null,
          }))}
        />
      </Stage>
    </div>
  );
}
