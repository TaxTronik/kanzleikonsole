// =============================================================================
// Belegung des Cockpit-Grids (Review-Befund K-04): je Blockschlüssel die Karte
// samt Modul-Gate. Gestreamte Blöcke stehen in einer eigenen <Suspense>-Grenze
// mit Platzhalter und warten nur auf ihr eigenes Daten-Promise; die Karten aus
// den Kopfdaten rendern sofort. `null` blendet eine Karte aus (CockpitGrid
// lässt ihre Zelle weg). Position und Reihenfolge bestimmt das Layout.
// =============================================================================

import { Suspense, type ReactNode } from 'react';
import type { TenantContext } from '@taxtronik/db';
import type { StaffSession } from '@/server/auth/staff';
import type { ClientBlockKey } from '@/server/settings/client-layout-shared';
import { ClientDocumentsBlock, ClientDocumentsSkeleton } from './client-documents-block';
import {
  BindersCockpitBlock,
  CockpitBlockSkeleton,
  HandoversCockpitBlock,
  PhoneNotesCockpitBlock,
  RemindersCockpitBlock,
  RequestsCockpitBlock,
  UpcomingCockpitBlock,
  WorkflowsCockpitBlock,
} from './cockpit-blocks';
import {
  ContactsCockpitCard,
  CustomFieldsCockpitCard,
  GwgStatusCockpitCard,
  MasterDataCockpitCard,
  customFieldsForKind,
} from './cockpit-cards';
import type {
  ClientCockpitBlockLoads,
  ClientCockpitHeaderData,
  ClientDocumentsQuery,
  CockpitModules,
} from './_data';

export interface CockpitBlockNodesInput {
  header: ClientCockpitHeaderData;
  modules: CockpitModules;
  /** Ein Promise je gestreamtem Block (startClientCockpitBlocks). */
  blocks: ClientCockpitBlockLoads;
  ctx: TenantContext;
  session: StaffSession;
  documentsQuery: ClientDocumentsQuery;
  staffId: string;
  isAdmin: boolean;
  now: Date;
}

export function cockpitBlockNodes({
  header,
  modules,
  blocks,
  ctx,
  session,
  documentsQuery,
  staffId,
  isAdmin,
  now,
}: CockpitBlockNodesInput): Record<ClientBlockKey, ReactNode> {
  const { client } = header;
  const clientRef = { id: client.id, name: client.name };
  const customDefs = customFieldsForKind(header.customDefs, client.kind);
  return {
    upcoming:
      modules.taxNotices || modules.appointments ? (
        <Suspense fallback={<CockpitBlockSkeleton title="Anstehende Termine" />}>
          <UpcomingCockpitBlock
            data={blocks.upcoming}
            client={clientRef}
            showTax={modules.taxNotices}
            showAppts={modules.appointments}
            staffId={staffId}
            now={now}
          />
        </Suspense>
      ) : null,
    workflows: !modules.workflows ? null : (
      <Suspense fallback={<CockpitBlockSkeleton title="Aktive Workflows" />}>
        <WorkflowsCockpitBlock data={blocks.workflows} clientId={client.id} now={now} />
      </Suspense>
    ),
    reminders: !modules.reminders ? null : (
      <Suspense fallback={<CockpitBlockSkeleton title="Wiedervorlagen" />}>
        <RemindersCockpitBlock
          data={blocks.reminders}
          clientId={client.id}
          staffId={staffId}
          isAdmin={isAdmin}
        />
      </Suspense>
    ),
    binders: !modules.binders ? null : (
      <Suspense fallback={<CockpitBlockSkeleton title="Pendelordner" />}>
        <BindersCockpitBlock data={blocks.binders} clientId={client.id} />
      </Suspense>
    ),
    handovers: !modules.handovers ? null : (
      <Suspense fallback={<CockpitBlockSkeleton title="Anlieferungen" />}>
        <HandoversCockpitBlock data={blocks.handovers} clientId={client.id} />
      </Suspense>
    ),
    phone_notes: !modules.phoneNotes ? null : (
      <Suspense fallback={<CockpitBlockSkeleton title="Telefonzettel" />}>
        <PhoneNotesCockpitBlock
          data={blocks.phoneNotes}
          clientId={client.id}
          contacts={client.contacts.map((c) => ({ fullName: c.fullName, phone: c.phone }))}
          staffId={staffId}
        />
      </Suspense>
    ),
    contacts: <ContactsCockpitCard clientId={client.id} contacts={client.contacts} />,
    master_data: <MasterDataCockpitCard client={client} />,
    custom_fields:
      customDefs.length === 0 ? null : (
        <CustomFieldsCockpitCard defs={customDefs} values={header.customValues} />
      ),
    gwg_status: (
      <GwgStatusCockpitCard clientId={client.id} latest={client.gwgChecks[0]} now={now} />
    ),
    requests: (
      <Suspense fallback={<CockpitBlockSkeleton title="Anforderungen" />}>
        <RequestsCockpitBlock data={blocks.requests} client={clientRef} />
      </Suspense>
    ),
    documents: (
      <Suspense
        key={`client-documents-${JSON.stringify(documentsQuery)}`}
        fallback={<ClientDocumentsSkeleton />}
      >
        <ClientDocumentsBlock
          ctx={ctx}
          session={session}
          client={{ id: client.id, name: client.name, allowActive: client.allowActive }}
          query={documentsQuery}
        />
      </Suspense>
    ),
  };
}
