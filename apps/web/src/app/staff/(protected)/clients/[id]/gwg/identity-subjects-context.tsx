'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { IdentitySubjectOption } from '@/server/gwg/identity-subject';
import type { InvalidatedIdentitySet } from './actions';
import {
  acknowledgeIdentityInvalidation,
  type IdentityInvalidationState,
} from './identity-invalidation';

export interface EditableRepresentative {
  id: string;
  fullName: string;
  position: number;
  linkedBeneficialOwnerId?: string | null;
}

interface IdentitySubjectsContextValue {
  subjectOptions: IdentitySubjectOption[];
  invalidatedIdentitySets: Readonly<IdentityInvalidationState>;
  replaceRepresentatives: (representatives: EditableRepresentative[]) => void;
  updateBeneficialOwner: (owner: { id: string; fullName: string; birthDate: string }) => void;
  removeBeneficialOwner: (ownerId: string) => void;
  registerIdentityInvalidations: (sets: InvalidatedIdentitySet[]) => void;
  acknowledgeIdentitySet: (documentSetId: string, consumedGeneration: number) => void;
}

const IdentitySubjectsContext = createContext<IdentitySubjectsContextValue | null>(null);

function birthDateLabel(value: string): string | undefined {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return undefined;
  return new Intl.DateTimeFormat('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

export function GwgIdentitySubjectsProvider({
  initialOptions,
  children,
}: {
  initialOptions: IdentitySubjectOption[];
  children: ReactNode;
}) {
  const [subjectOptions, setSubjectOptions] = useState(initialOptions);
  const invalidationGeneration = useRef(0);
  const [invalidatedIdentitySets, setInvalidatedIdentitySets] = useState<IdentityInvalidationState>(
    {},
  );

  // Neue Server-Props übernehmen (Muster wie GwgEditStateProvider): nach
  // einem RSC-Refresh — insbesondere nach dem Start eines neuen Prüfzyklus,
  // der alle Personen mit FRISCHEN IDs kopiert — hielt der Provider sonst die
  // alten Optionen fest. Eine unveränderte Bestätigung submittete dann
  // `owner:<alte-id>` und scheiterte serverseitig mit „Die identifizierte
  // Person gehört nicht mehr zu den erfassten …".
  const lastServerOptions = useRef(initialOptions);
  useEffect(() => {
    if (lastServerOptions.current === initialOptions) return;
    lastServerOptions.current = initialOptions;
    setSubjectOptions(initialOptions);
  }, [initialOptions]);

  const replaceRepresentatives = useCallback((representatives: EditableRepresentative[]) => {
    setSubjectOptions((current) => {
      const representativeByOwnerId = new Map(
        representatives.flatMap((representative) =>
          representative.linkedBeneficialOwnerId
            ? [[representative.linkedBeneficialOwnerId, representative.id] as const]
            : [],
        ),
      );
      const owners = current
        .filter((option) => option.kind === 'BENEFICIAL_OWNER')
        .map((option) => ({
          ...option,
          linkedRepresentativeId: representativeByOwnerId.get(option.id),
        }));
      const naturalClients = current.filter((option) => option.kind === 'NATURAL_CLIENT');
      const nextRepresentatives: IdentitySubjectOption[] = representatives.map((representative) => {
        const linkedOwner = representative.linkedBeneficialOwnerId
          ? owners.find((owner) => owner.id === representative.linkedBeneficialOwnerId)
          : null;
        return {
          key: `representative:${representative.id}`,
          id: representative.id,
          kind: 'REPRESENTATIVE',
          name: linkedOwner?.name ?? representative.fullName,
          roles: linkedOwner
            ? ['VERTRETUNGSBERECHTIGT', 'WIRTSCHAFTLICH_BERECHTIGT']
            : ['VERTRETUNGSBERECHTIGT'],
          position: representative.position,
          birthDateLabel: linkedOwner?.birthDateLabel,
          linkedBeneficialOwnerId: linkedOwner?.id,
        };
      });
      return [...naturalClients, ...nextRepresentatives, ...owners];
    });
  }, []);

  const updateBeneficialOwner = useCallback(
    (owner: { id: string; fullName: string; birthDate: string }) => {
      setSubjectOptions((current) =>
        current.map((option) =>
          (option.kind === 'BENEFICIAL_OWNER' && option.id === owner.id) ||
          (option.kind === 'REPRESENTATIVE' && option.linkedBeneficialOwnerId === owner.id)
            ? {
                ...option,
                name: owner.fullName,
                birthDateLabel: birthDateLabel(owner.birthDate),
              }
            : option,
        ),
      );
    },
    [],
  );

  const removeBeneficialOwner = useCallback((ownerId: string) => {
    setSubjectOptions((current) =>
      current
        .filter((option) => !(option.kind === 'BENEFICIAL_OWNER' && option.id === ownerId))
        .map((option) =>
          option.kind === 'REPRESENTATIVE' && option.linkedBeneficialOwnerId === ownerId
            ? {
                ...option,
                roles: ['VERTRETUNGSBERECHTIGT'],
                linkedBeneficialOwnerId: undefined,
                birthDateLabel: undefined,
              }
            : option,
        ),
    );
  }, []);

  const registerIdentityInvalidations = useCallback((sets: InvalidatedIdentitySet[]) => {
    if (sets.length === 0) return;
    setInvalidatedIdentitySets((current) => {
      const next = { ...current };
      for (const set of sets) {
        invalidationGeneration.current += 1;
        next[set.documentSetId] = {
          revision: set.revision,
          generation: invalidationGeneration.current,
        };
      }
      return next;
    });
  }, []);

  const acknowledgeIdentitySet = useCallback(
    (documentSetId: string, consumedGeneration: number) => {
      setInvalidatedIdentitySets((current) => {
        // Eine waehrend des Ausweis-Saves eingetroffene neuere Personen-
        // Aenderung darf durch dessen aeltere Success-Effect nicht geloescht
        // werden. Nur exakt die beim Submit konsumierte Generation bestaetigen.
        return acknowledgeIdentityInvalidation(current, documentSetId, consumedGeneration);
      });
    },
    [],
  );

  const value = useMemo(
    () => ({
      subjectOptions,
      invalidatedIdentitySets,
      replaceRepresentatives,
      updateBeneficialOwner,
      removeBeneficialOwner,
      registerIdentityInvalidations,
      acknowledgeIdentitySet,
    }),
    [
      acknowledgeIdentitySet,
      invalidatedIdentitySets,
      registerIdentityInvalidations,
      replaceRepresentatives,
      removeBeneficialOwner,
      subjectOptions,
      updateBeneficialOwner,
    ],
  );

  return (
    <IdentitySubjectsContext.Provider value={value}>{children}</IdentitySubjectsContext.Provider>
  );
}

export function useGwgIdentitySubjects(
  fallback: IdentitySubjectOption[] = [],
): IdentitySubjectsContextValue {
  const value = useContext(IdentitySubjectsContext);
  return (
    value ?? {
      subjectOptions: fallback,
      invalidatedIdentitySets: {},
      replaceRepresentatives: () => undefined,
      updateBeneficialOwner: () => undefined,
      removeBeneficialOwner: () => undefined,
      registerIdentityInvalidations: () => undefined,
      acknowledgeIdentitySet: () => undefined,
    }
  );
}
