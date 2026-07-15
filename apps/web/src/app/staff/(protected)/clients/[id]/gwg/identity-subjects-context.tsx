'use client';

import {
  createContext,
  useCallback,
  useContext,
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
}

interface IdentitySubjectsContextValue {
  subjectOptions: IdentitySubjectOption[];
  invalidatedIdentitySets: Readonly<IdentityInvalidationState>;
  replaceRepresentatives: (representatives: EditableRepresentative[]) => void;
  updateBeneficialOwner: (owner: { id: string; fullName: string; birthDate: string }) => void;
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

  const replaceRepresentatives = useCallback((representatives: EditableRepresentative[]) => {
    setSubjectOptions((current) => {
      const owners = current.filter((option) => option.kind === 'BENEFICIAL_OWNER');
      const naturalClients = current.filter((option) => option.kind === 'NATURAL_CLIENT');
      const nextRepresentatives: IdentitySubjectOption[] = representatives.map(
        (representative) => ({
          key: `representative:${representative.id}`,
          id: representative.id,
          kind: 'REPRESENTATIVE',
          name: representative.fullName,
          roles: ['VERTRETUNGSBERECHTIGT'],
          position: representative.position,
        }),
      );
      return [...naturalClients, ...nextRepresentatives, ...owners];
    });
  }, []);

  const updateBeneficialOwner = useCallback(
    (owner: { id: string; fullName: string; birthDate: string }) => {
      setSubjectOptions((current) =>
        current.map((option) =>
          option.kind === 'BENEFICIAL_OWNER' && option.id === owner.id
            ? { ...option, name: owner.fullName, birthDateLabel: birthDateLabel(owner.birthDate) }
            : option,
        ),
      );
    },
    [],
  );

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
      registerIdentityInvalidations,
      acknowledgeIdentitySet,
    }),
    [
      acknowledgeIdentitySet,
      invalidatedIdentitySets,
      registerIdentityInvalidations,
      replaceRepresentatives,
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
      registerIdentityInvalidations: () => undefined,
      acknowledgeIdentitySet: () => undefined,
    }
  );
}
