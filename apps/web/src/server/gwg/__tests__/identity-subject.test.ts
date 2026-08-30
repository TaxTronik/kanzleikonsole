import { describe, expect, it } from 'vitest';
import {
  displaySubjectKeyForAssignment,
  identityAssignmentForSubject,
  identitySubjectRoleLabel,
  identitySubjectOptions,
  resolveIdentitySubject,
  selectableIdentitySubjectOptions,
  subjectKeyForAssignment,
} from '../identity-subject';

const source = {
  clientId: '22222222-2222-4222-8222-222222222222',
  clientName: 'Muster GbR',
  clientKind: 'PERSGES' as const,
  representatives: [
    { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', fullName: ' Rey   Koxha ', position: 0 },
    { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', fullName: 'Rey Koxha', position: 1 },
  ],
  beneficialOwners: [
    {
      id: '33333333-3333-4333-8333-333333333333',
      fullName: 'Rey Koxha',
      birthDate: new Date('1988-05-06T00:00:00.000Z'),
    },
    {
      id: '44444444-4444-4444-8444-444444444444',
      fullName: 'Rey Koxha',
      birthDate: new Date('1992-07-08T00:00:00.000Z'),
    },
  ],
};

describe('GwG-Identitaetspersonen', () => {
  it('behaelt gleichnamige Personen und Rollen als getrennte UUID-Auswahlen', () => {
    const options = identitySubjectOptions(source);

    expect(options).toHaveLength(4);
    expect(options.map((option) => option.key)).toEqual([
      'representative:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'representative:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'owner:33333333-3333-4333-8333-333333333333',
      'owner:44444444-4444-4444-8444-444444444444',
    ]);
    expect(options.slice(2).map((option) => identitySubjectRoleLabel(option))).toEqual([
      'wirtschaftlich berechtigt · geb. 06.05.1988 · Eintrag 1',
      'wirtschaftlich berechtigt · geb. 08.07.1992 · Eintrag 2',
    ]);
  });

  it('akzeptiert keinen frei erfundenen oder veralteten Browserwert', () => {
    expect(resolveIdentitySubject(source, 'owner:55555555-5555-4555-8555-555555555555')).toBeNull();
  });

  it('bildet eine ausdrücklich verknüpfte Doppelrolle als genau eine auswählbare Identität ab', () => {
    const linkedSource = {
      ...source,
      representatives: [
        {
          ...source.representatives[0]!,
          linkedBeneficialOwnerId: source.beneficialOwners[0]!.id,
        },
        source.representatives[1]!,
      ],
    };
    const allOptions = identitySubjectOptions(linkedSource);
    const selectable = selectableIdentitySubjectOptions(allOptions);
    const linkedRepresentative = selectable.find(
      (option) => option.key === `representative:${source.representatives[0]!.id}`,
    );

    expect(allOptions).toHaveLength(4);
    expect(selectable).toHaveLength(3);
    expect(linkedRepresentative).toMatchObject({
      name: 'Rey Koxha',
      roles: ['VERTRETUNGSBERECHTIGT', 'WIRTSCHAFTLICH_BERECHTIGT'],
      linkedBeneficialOwnerId: source.beneficialOwners[0]!.id,
      birthDateLabel: '06.05.1988',
    });
    expect(
      resolveIdentitySubject(linkedSource, `owner:${source.beneficialOwners[0]!.id}`),
    ).toBeNull();
    expect(
      resolveIdentitySubject(linkedSource, `representative:${source.representatives[0]!.id}`),
    ).toMatchObject({ linkedBeneficialOwnerId: source.beneficialOwners[0]!.id });
    expect(
      displaySubjectKeyForAssignment(
        {
          naturalClientSubjectId: null,
          beneficialOwnerSubjectId: source.beneficialOwners[0]!.id,
          representativeSubjectId: null,
        },
        allOptions,
      ),
    ).toBe(`representative:${source.representatives[0]!.id}`);
    expect(
      displaySubjectKeyForAssignment(
        {
          naturalClientSubjectId: null,
          beneficialOwnerSubjectId: source.beneficialOwners[1]!.id,
          representativeSubjectId: null,
        },
        allOptions,
      ),
    ).toBe(`owner:${source.beneficialOwners[1]!.id}`);
  });

  it('bietet bei natuerlichen Personen ausschliesslich den Mandanten selbst an', () => {
    expect(
      identitySubjectOptions({
        ...source,
        clientName: 'Rey Koxha',
        clientKind: 'NATPERS',
      }),
    ).toEqual([
      {
        key: 'client:22222222-2222-4222-8222-222222222222',
        id: '22222222-2222-4222-8222-222222222222',
        kind: 'NATURAL_CLIENT',
        name: 'Rey Koxha',
        roles: ['MANDANT'],
      },
    ]);
  });

  it('uebersetzt die Auswahl in genau einen persistierten Fremdschluessel', () => {
    const representative = resolveIdentitySubject(
      source,
      'representative:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    )!;
    const assignment = identityAssignmentForSubject(representative);

    expect(assignment).toEqual({
      naturalClientSubjectId: null,
      beneficialOwnerSubjectId: null,
      representativeSubjectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    expect(subjectKeyForAssignment(assignment)).toBe(
      'representative:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
  });
});
