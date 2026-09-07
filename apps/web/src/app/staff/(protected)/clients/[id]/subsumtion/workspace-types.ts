import type { ReactNode } from 'react';
import type { AnalysisDTO, ResearchResultDTO, ResearchRequestDTO } from './_ui';

export interface SubsumtionWorkspaceProps {
  clientId: string;
  staffOptions: Array<{ id: string; fullName: string }>;
  clientDocuments: Array<{ id: string; title: string; mimeType: string; typeName: string }>;
  researchResults?: ResearchResultDTO[];
  archivedResearchResults?: ResearchResultDTO[];
  researchRequests?: ResearchRequestDTO[];
  /** Server-gerenderter Inhalt des „Aufgaben"-Tabs (Workflows dieses Sachverhalts). */
  aufgaben?: ReactNode;
  /** Server-gerenderter Inhalt des „Aktenregal"-Tabs (Dokumente dieses Sachverhalts). */
  aktenregal?: ReactNode;
  engineConfigured: boolean;
  floatingToolbarDefault?: boolean;
  initial: AnalysisDTO | null;
  /**
   * Volle Bearbeitungsrechte. Ohne sie sieht der Space lesend aus; recherchiert
   * werden darf nur an zugewiesenen Markierungen. Reine Anzeige-Logik — die
   * Durchsetzung liegt in den Server Actions.
   */
  canWrite?: boolean;
  /** Eigene Staff-ID — entscheidet, ob eine Markierung „mir zugewiesen" ist. */
  currentStaffId?: string;
}
