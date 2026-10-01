import { describe, expect, test } from 'vitest';
import {
  createTrustedEntityReplayContext,
  syntheticZeroPortEntityProfile,
  transformElaborationModule,
} from '@comblang/compiler';
import type { EntityProfile } from '@comblang/compiler/entity';
import type { EntityPrototype } from '@comblang/prototypes';
import { parseFile } from '@comblang/language';
import { executeElaborationProgram } from './elaboration-program.js';
import { ElaborationExecutionError } from './elaboration-errors.js';

const families = ['Arithmetic', 'Decider', 'Selector', 'Constant'] as const;
type Family = (typeof families)[number];
const calls: Record<Family, string> = {
  Arithmetic: "Arithmetic({ left: input[A], operation: 'add', right: 2, output: A })",
  Decider: 'Decider({ condition: input[A] > 0, outputs: [input[A]] })',
  Selector: "Selector({ input, operation: 'count', output: A })",
  Constant: 'Constant({ sections: [{ filters: [{ signal: A, value: 2 }] }] })',
};

function profile(
  family: Family,
  suffix = '',
  assertedType = `${family.toLowerCase()}-combinator`,
): EntityProfile {
  return {
    ...structuredClone(syntheticZeroPortEntityProfile),
    ref: {
      ...syntheticZeroPortEntityProfile.ref,
      prototypeKey:
        `entity:${family.toLowerCase()}-combinator${suffix}` as EntityProfile['ref']['prototypeKey'],
      profileId: `profile:authority-${family}${suffix}` as EntityProfile['ref']['profileId'],
    },
    prototypeType: assertedType,
  };
}

function host(
  profiles: readonly EntityProfile[],
  lookup?: (key: string) => EntityPrototype | undefined,
) {
  const context = createTrustedEntityReplayContext({
    database: syntheticZeroPortEntityProfile.ref.database,
    source: 'synthetic',
    evidenceIdentity: 'profile-authority-evidence',
    policyIdentity: 'profile-authority-policy',
    profiles,
  });
  const keys: string[] = [];
  return {
    keys,
    environment: {
      trustedEntityReplayContext: context,
      entityPrototypeResolver: {
        database: context.database,
        getEntity(key: string): EntityPrototype | undefined {
          keys.push(key);
          if (lookup !== undefined) return lookup(key);
          const found = profiles.find(({ ref }) => ref.prototypeKey === key);
          return found === undefined
            ? undefined
            : {
                key: found.ref.prototypeKey as EntityPrototype['key'],
                name: key.slice('entity:'.length),
                type: found.prototypeType!,
                tileWidth: 1,
                tileHeight: 1,
              };
        },
      },
    },
  };
}

function program(family: Family, call = calls[family]) {
  const text = `const A = Signal('virtual', 'signal-A');\nconst input = new Network();\nconst output = new Network();\noutput += ${call};`;
  return {
    text,
    transformed: transformElaborationModule(
      parseFile({ path: 'profile-authority.factorio.ts', text }),
    ),
  };
}

function failure(
  family: Family,
  environment: Parameters<typeof executeElaborationProgram>[1],
  message: string,
  expectedCause?: unknown,
) {
  const { text, transformed } = program(family);
  try {
    executeElaborationProgram(transformed, environment);
  } catch (error) {
    expect(error).toBeInstanceOf(ElaborationExecutionError);
    const failure = error as ElaborationExecutionError;
    expect(failure.code).toBe('RT2027');
    expect(failure.message).toBe(message);
    expect(failure.span.start).toBe(text.indexOf(`${family}(`));
    expect(failure.span.end).toBe(text.lastIndexOf(';'));
    expect(failure.cause).toBeInstanceOf(ElaborationExecutionError);
    const primary = failure.cause as ElaborationExecutionError;
    expect(primary.code).toBe(failure.code);
    expect(primary.message).toBe(failure.message);
    expect(primary.span).toEqual(failure.span);
    expect(primary.cause).toBe(expectedCause);
    return;
  }
  throw new Error('Expected a located profile authority failure.');
}

describe.each(families)('%s canonical profile authority', (family) => {
  const baseName = `${family.toLowerCase()}-combinator`;
  const baseKey = `entity:${baseName}`;
  const missing = `Exact ${family} configuration requires a trusted base ${baseKey} Entity profile.`;
  test('selects the base with unchanged lookup sequence even beside a modded profile', () => {
    const environment = host([profile(family, '-modded'), profile(family)]);
    const plan = executeElaborationProgram(program(family).transformed, environment.environment);
    expect(plan.entities).toHaveLength(1);
    expect(plan.entities[0]!.profile.prototypeKey).toBe(baseKey);
    expect(environment.keys).toEqual(
      Array(family === 'Arithmetic' || family === 'Decider' ? 3 : 2).fill(baseKey),
    );
  });
  test('does not fall back to a modded profile when the base is absent', () => {
    const environment = host([profile(family, '-modded')]);
    failure(family, environment.environment, missing);
    expect(environment.keys).toEqual([]);
  });
  if (family !== 'Selector') {
    test('retains ergonomic construction without a canonical base', () => {
      const call =
        family === 'Arithmetic'
          ? 'input + 1'
          : family === 'Decider'
            ? 'when(input[A] > 0).then(input[A])'
            : 'CC(2 * A)';
      const environment = host([profile(family, '-modded')]);
      const plan = executeElaborationProgram(
        program(family, call).transformed,
        environment.environment,
      );
      expect(plan.producers).toHaveLength(1);
      expect(plan.entities).toHaveLength(0);
      expect(environment.keys).toEqual([]);
    });
  }
  test('retains missing-context and missing-resolver policy', () => {
    const environment = host([profile(family)]).environment;
    failure(
      family,
      { trustedEntityReplayContext: environment.trustedEntityReplayContext },
      missing,
    );
    if (family === 'Selector')
      expect(executeElaborationProgram(program(family).transformed).producers).toHaveLength(1);
    else failure(family, undefined, missing);
  });
  if (family === 'Arithmetic' || family === 'Decider') {
    test('retains the second canonical lookup and its stateful failure', () => {
      const cause = new Error('second canonical lookup failed');
      let lookups = 0;
      const environment = host([profile(family)], () => {
        if (++lookups === 2) throw cause;
        return {
          key: baseKey as EntityPrototype['key'],
          name: baseName,
          type: baseName,
          tileWidth: 1,
          tileHeight: 1,
        };
      });
      failure(family, environment.environment, cause.message, cause);
      expect(environment.keys).toEqual([baseKey, baseKey]);
    });
  }
  test('rejects duplicate base candidates before lookup', () => {
    const first = profile(family);
    const second = {
      ...first,
      ref: {
        ...first.ref,
        profileId: `${first.ref.profileId}-second` as EntityProfile['ref']['profileId'],
      },
    };
    const environment = host([first, second]);
    failure(
      family,
      environment.environment,
      `The trusted provider exposes ambiguous base ${baseName} profiles.`,
    );
    expect(environment.keys).toEqual([]);
  });
  test('rejects an incorrect asserted prototypeType before lookup', () => {
    const environment = host([profile(family, '', 'wrong-combinator')]);
    failure(
      family,
      environment.environment,
      `The trusted base ${baseName} profile does not assert prototypeType "${baseName}".`,
    );
    expect(environment.keys).toEqual([]);
  });
  test('rejects an unavailable prototype', () => {
    const environment = host([profile(family)], () => undefined);
    failure(
      family,
      environment.environment,
      `Trusted ${family} profile "${baseKey}" is not available in the selected provider.`,
    );
    expect(environment.keys).toEqual([baseKey]);
  });
  test.each(['key', 'name', 'type'] as const)('rejects a mismatching prototype %s', (field) => {
    const environment = host(
      [profile(family)],
      () =>
        ({
          key: baseKey as EntityPrototype['key'],
          name: baseName,
          type: baseName,
          tileWidth: 1,
          tileHeight: 1,
          [field]: 'wrong',
        }) as EntityPrototype,
    );
    failure(
      family,
      environment.environment,
      `Trusted ${family} profile "${baseKey}" does not match base provider prototype data.`,
    );
    expect(environment.keys).toEqual([baseKey]);
  });
  test.each([new Error('provider lookup error'), 'non-Error provider failure'])(
    'retains resolver cause %s',
    (cause) => {
      const environment = host([profile(family)], () => {
        throw cause;
      });
      failure(
        family,
        environment.environment,
        cause instanceof Error ? cause.message : `${family} prototype lookup failed.`,
        cause,
      );
      expect(environment.keys).toEqual([baseKey]);
    },
  );
});
