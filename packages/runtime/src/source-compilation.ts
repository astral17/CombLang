import { transformElaborationModule } from '@comblang/compiler/elaboration-transform';
import type { DirectElaborationPlan } from '@comblang/compiler/direct-plan-schema';
import type { LogicalDeciderCondition, NativeCircuitIr } from '@comblang/compiler/ir';
import type { SignalId } from '@comblang/factorio';
import {
  cloneEntityReplayContextTransport,
  entityReplayContextIdentity,
  entityReplayContextTransport,
  EntityReplayContextError,
  type EntityReplayContextTransport,
  type TrustedEntityReplayContext,
} from '@comblang/compiler/entity-replay-context';
import {
  classifyDslSemantics,
  parseFile,
  summarizeTopLevel,
  validateDslSemantics,
  type ParsedSourceFile,
  type ParseWorkerResult,
  type SourceFileSnapshot,
} from '@comblang/language';
import type { PrototypeProvider } from '@comblang/prototypes';
import {
  parseDiagnosticPolicy,
  resolveDiagnostics,
  type Diagnostic,
  type DiagnosticPolicy,
} from '@comblang/shared';

import type { ExecutedDirectPlan } from './direct-plan.js';
import { tryElaborateDirectPlan as tryCanonicalDirectPlan } from './direct-plan.js';
import { executeElaborationProgram } from './elaboration-program.js';
import type { EntityPrototypeResolver } from './entity-registry.js';
import { executionFailureDiagnostic } from './execution-diagnostic.js';
import type { ResolvedCircuit } from '@comblang/compiler/resolved-circuit';
import {
  canonicalDirectPlan,
  canonicalResolvedCircuit,
  canonicalizeCompilationArtifacts,
} from './canonical-circuit.js';
import {
  bindCapturedSourceConfigurationTemplates,
  bindCapturedSourceConfigurationTemplatesWithRelations,
} from './executed-blueprint-configuration-binding.js';
import { materializeCapturedPlan } from './source-configuration-materialization.js';
import { executeResolvedDirectPlan } from './direct-plan.js';
import type { BlueprintParameterBinding } from '../../compiler/src/blueprint-parameter-validation.js';
import {
  executeElaborationProgramWithParameters,
  type ExecutedElaborationWithBlueprintParameters,
} from './elaboration-program.js';
import {
  BlueprintParameterError,
  canonicalBlueprintParameterHandle,
  type BlueprintParameterHandle,
  type BlueprintParameterKind,
  type BlueprintNumberParameterMetadata,
} from '../../compiler/src/blueprint-parameters.js';
import { inspectConstantConfigurationTemplate } from '../../compiler/src/constant-configuration-template.js';
import { inspectArithmeticConfigurationTemplate } from '../../compiler/src/arithmetic-configuration-template.js';
import {
  inspectDeciderConfigurationTemplate,
  type DeciderTemplateCondition,
} from '../../compiler/src/decider-configuration-template.js';
import { nativeDeciderConditionGroups } from '../../compiler/src/native-decider-conditions.js';
import { inspectSelectorConfigurationTemplate } from '../../compiler/src/selector-configuration-template.js';
import { isRegisteredBlueprintNumericExpression } from '../../compiler/src/blueprint-numeric-expression-bridge.js';
import {
  buildNativeBlueprintFcir,
  type NativeBlueprintProjectionOptions,
} from '../../compiler/src/native-blueprint-projector.js';
import {
  validateNativeBlueprintFcir,
  type NativeBlueprintFcir,
  type NativeBlueprintParameter,
} from '../../compiler/src/native-blueprint-ir.js';
import type { SourceSpan } from '@comblang/shared';

export interface SourceCompilationEnvironment {
  /** Normalized project policy applied only to the final returned diagnostics. */
  readonly diagnosticPolicy?: DiagnosticPolicy;
  readonly prototypes?: PrototypeProvider;
  /** Identity-only, cloneable replay context; host providers and Entity handles stay local. */
  readonly entityReplayContext?: EntityReplayContextTransport;
  /** Host-only profile set used to validate a provider context before transport. */
  readonly trustedEntityReplayContext?: TrustedEntityReplayContext;
  /** Host-only resolver used by synthetic or otherwise injected Entity environments. */
  readonly entityPrototypeResolver?: EntityPrototypeResolver;
}

/** Serializable result safe to send through a browser Worker boundary. */
export interface SourceCompilationArtifact extends ParseWorkerResult {
  /** Every compilation-stage diagnostic in stable execution order. */
  readonly pipelineDiagnostics: readonly Diagnostic[];
  /** Non-parser diagnostics retained for compatibility with parser clients. */
  readonly compilerDiagnostics: readonly Diagnostic[];
  readonly executionMode: 'executed-javascript';
  readonly prototypeIdentity?: string;
  readonly entityReplayContext?: EntityReplayContextTransport;
  /** Future result-cache identity; no compilation-result cache consumes it yet. */
  readonly entityReplayIdentity?: string;
  readonly elaborationJavaScript?: string;
  readonly plan?: DirectElaborationPlan;
  /** Detached physical IR; present only after host-authorized lowering succeeds. */
  readonly resolvedCircuit?: ResolvedCircuit;
}

/** Host-local compilation state. Runtime handles never enter the transport artifact. */
export interface LocalSourceCompilation extends SourceCompilationArtifact {
  readonly execution?: ExecutedDirectPlan;
}

/** A source declaration exposed only to the host that owns this compilation result. */
export interface SourceCompilationParameter {
  readonly parameter: BlueprintParameterHandle;
  readonly kind: BlueprintParameterKind;
  readonly label: string;
  readonly defaultValue: number | SignalId;
  readonly source: SourceSpan;
  readonly metadata?: BlueprintNumberParameterMetadata;
}

const capturedParametersByCompilation = new WeakMap<
  object,
  {
    readonly source: ExecutedElaborationWithBlueprintParameters;
    readonly execution?: ExecutedDirectPlan;
  }
>();
const parameterSourceArtifacts = new WeakSet<object>();

export type SourceCompilationStage = 'parse' | 'semantic' | 'transform' | 'execute' | 'lower';

export type SourceCompilationObserver = (stage: SourceCompilationStage) => void;

function replayTransport(
  environment: SourceCompilationEnvironment,
): EntityReplayContextTransport | undefined {
  const transport =
    environment.entityReplayContext === undefined
      ? environment.trustedEntityReplayContext === undefined
        ? undefined
        : entityReplayContextTransport(environment.trustedEntityReplayContext)
      : cloneEntityReplayContextTransport(environment.entityReplayContext);
  if (transport === undefined) return undefined;

  if (environment.trustedEntityReplayContext !== undefined) {
    const expected = entityReplayContextTransport(environment.trustedEntityReplayContext);
    if (entityReplayContextIdentity(transport) !== entityReplayContextIdentity(expected)) {
      throw new EntityReplayContextError(
        'ER1001',
        '$.entityReplayContext',
        'transport does not match the trusted profile-set context.',
      );
    }
  }
  if (transport.source === 'provider' && environment.trustedEntityReplayContext === undefined) {
    throw new EntityReplayContextError(
      'ER1001',
      '$.entityReplayContext.profileSetIdentity',
      'provider replay contexts require a host-bound trusted profile set.',
    );
  }
  if (environment.prototypes !== undefined) {
    if (
      environment.prototypes.schemaVersion !== transport.database.schemaVersion ||
      environment.prototypes.identity !== transport.database.identity
    ) {
      throw new EntityReplayContextError(
        'ER1001',
        '$.entityReplayContext.database',
        'transport database does not match the selected prototype provider.',
      );
    }
  }
  return transport;
}

function compileParsedSource(
  parsed: ParsedSourceFile,
  environment: SourceCompilationEnvironment,
  preflightDiagnostics: readonly Diagnostic[],
  observe?: SourceCompilationObserver,
): LocalSourceCompilation {
  // Public JavaScript callers are not made trustworthy by the TypeScript type.
  // Validate before semantic analysis or source execution, just like CLI/Worker ingress.
  const diagnosticPolicy = parseDiagnosticPolicy(environment.diagnosticPolicy);
  const entityReplayContext = replayTransport(environment);
  let plan: DirectElaborationPlan | undefined;
  let execution: ExecutedDirectPlan | undefined;
  let parameterPairedExecution: ExecutedDirectPlan | undefined;
  let resolvedCircuit: ResolvedCircuit | undefined;
  let elaborationJavaScript: string | undefined;
  let hasSourceParameterDeclarations = false;
  let capturedParameters: ExecutedElaborationWithBlueprintParameters | undefined;
  observe?.('semantic');
  const semanticDiagnostics = validateDslSemantics(parsed);
  const compilerDiagnostics: Diagnostic[] = [...preflightDiagnostics, ...semanticDiagnostics];
  const pipelineDiagnostics: Diagnostic[] = [
    ...preflightDiagnostics,
    ...parsed.diagnostics,
    ...semanticDiagnostics,
  ];
  const appendCompilerDiagnostics = (diagnostics: readonly Diagnostic[]): void => {
    compilerDiagnostics.push(...diagnostics);
    pipelineDiagnostics.push(...diagnostics);
  };

  if (parsed.diagnostics.length === 0) {
    try {
      observe?.('transform');
      const program = transformElaborationModule(parsed);
      elaborationJavaScript = program.code;
      hasSourceParameterDeclarations = program.containsBlueprintParameterDeclarations === true;
      if (!compilerDiagnostics.some(({ severity }) => severity === 'error')) {
        observe?.('execute');
        const parameterExecution = hasSourceParameterDeclarations
          ? executeElaborationProgramWithParameters(program, environment)
          : undefined;
        const executedPlan =
          parameterExecution?.plan ?? executeElaborationProgram(program, environment);
        const canonicalPlan = canonicalDirectPlan(executedPlan);
        if (parameterExecution !== undefined) {
          capturedParameters = Object.freeze({ ...parameterExecution, plan: canonicalPlan });
        }
        plan = canonicalPlan;
        observe?.('lower');
        const lowered = tryCanonicalDirectPlan(
          canonicalPlan,
          environment.trustedEntityReplayContext,
        );
        execution = lowered.execution;
        parameterPairedExecution = lowered.execution;
        resolvedCircuit = lowered.resolvedCircuit;
        appendCompilerDiagnostics(executedPlan.diagnostics ?? []);
        appendCompilerDiagnostics(lowered.diagnostics);
      }
    } catch (error) {
      plan = undefined;
      execution = undefined;
      appendCompilerDiagnostics([executionFailureDiagnostic(error)]);
    }
  }

  const compilation = canonicalizeCompilationArtifacts({
    fileId: parsed.id,
    diagnostics: parsed.diagnostics,
    topLevel: summarizeTopLevel(parsed),
    semantics: classifyDslSemantics(parsed),
    pipelineDiagnostics: resolveDiagnostics(pipelineDiagnostics, diagnosticPolicy),
    compilerDiagnostics: resolveDiagnostics(compilerDiagnostics, diagnosticPolicy),
    executionMode: 'executed-javascript',
    ...(environment.prototypes === undefined
      ? {}
      : { prototypeIdentity: environment.prototypes.identity }),
    ...(entityReplayContext === undefined
      ? {}
      : {
          entityReplayContext,
          entityReplayIdentity: entityReplayContextIdentity(entityReplayContext),
        }),
    ...(elaborationJavaScript === undefined ? {} : { elaborationJavaScript }),
    ...(plan === undefined ? {} : { plan }),
    ...(resolvedCircuit === undefined ? {} : { resolvedCircuit }),
    ...(execution === undefined ? {} : { execution }),
  } as unknown as Record<string, any>) as unknown as LocalSourceCompilation;
  if (capturedParameters !== undefined) {
    capturedParametersByCompilation.set(compilation, {
      source: capturedParameters,
      ...(parameterPairedExecution === undefined ? {} : { execution: parameterPairedExecution }),
    });
  }
  if (hasSourceParameterDeclarations) parameterSourceArtifacts.add(compilation);
  return compilation;
}

/** Lists nominal declarations for the owning host without adding them to the transport artifact. */
export function listSourceCompilationParameters(
  compilation: LocalSourceCompilation,
): readonly SourceCompilationParameter[] {
  const state = capturedParametersByCompilation.get(compilation);
  if (state === undefined) return Object.freeze([]);
  return Object.freeze(
    state.source.parameters.map(({ handle, registration }) => {
      const defaultValue = registration.defaultValue;
      const source = registration.source;
      if (defaultValue === undefined || source === undefined) {
        throw new Error('Captured source parameters must have a concrete default and source span.');
      }
      return Object.freeze({
        parameter: handle,
        kind: registration.kind,
        label: registration.label,
        defaultValue,
        source,
        ...(registration.metadata === undefined ? {} : { metadata: registration.metadata }),
      });
    }),
  );
}

/** Binds this exact compilation's declarations into a fresh concrete NCIR. */
export function bindSourceCompilationParameters(
  compilation: LocalSourceCompilation,
  bindings: readonly BlueprintParameterBinding[] = [],
): NativeCircuitIr {
  const state = capturedParametersByCompilation.get(compilation);
  if (state === undefined) {
    throw new TypeError('Compilation has no host-local source parameter declarations.');
  }
  if (state.execution === undefined) {
    throw new TypeError('Compilation has no canonical execution available for parameter binding.');
  }
  return bindCapturedSourceConfigurationTemplates(state.source, state.execution, bindings);
}

function containsNativeUnsupportedExpression(value: unknown): boolean {
  if (isRegisteredBlueprintNumericExpression(value)) return true;
  return (
    value !== null &&
    typeof value === 'object' &&
    Object.values(value).some(containsNativeUnsupportedExpression)
  );
}

/** Projects this exact compilation's direct numeric configuration slots into native metadata. */
export function exportSourceCompilationNativeBlueprint(
  compilation: LocalSourceCompilation,
  options: NativeBlueprintProjectionOptions,
): NativeBlueprintFcir {
  const state = capturedParametersByCompilation.get(compilation);
  if (state === undefined) {
    throw new TypeError('Compilation has no host-local source parameter declarations.');
  }
  if (state.execution === undefined) {
    throw new TypeError('Compilation has no canonical execution available for parameter binding.');
  }
  if (compilation.resolvedCircuit === undefined) {
    throw new TypeError('Compilation has no resolved circuit available for parameter binding.');
  }
  function reject(path: string, message: string, source?: SourceSpan): never {
    throw new BlueprintParameterError('CP1002', path, message, source);
  }
  const declarations = listSourceCompilationParameters(compilation);
  for (const [index, declaration] of declarations.entries()) {
    if (declaration.kind !== 'number') {
      reject(
        `$.parameters[${index}]`,
        'native source export supports only number declarations.',
        declaration.source,
      );
    }
    const original = declaration.defaultValue;
    if (
      typeof original !== 'number' ||
      !Number.isInteger(original) ||
      original < -2147483648 ||
      original > 2147483647
    ) {
      reject(
        `$.parameters[${index}].defaultValue`,
        'native original must be an explicit signed int32 integer.',
        declaration.source,
      );
    }
  }
  const used = new Set<BlueprintParameterHandle>();
  const occurrences: ({
    captureId: string;
    parameter: BlueprintParameterHandle;
    path: string;
    source: SourceSpan;
  } & (
    | { kind: 'constant-count'; sectionIndex: number; filterIndex: number }
    | { kind: 'arithmetic-operand'; side: 'first' | 'second' }
    | { kind: 'selector-index' }
    | { kind: 'decider-threshold'; conditionPath: readonly number[] }
  ))[] = [];
  state.source.selectorTemplates.forEach((capture, captureIndex) => {
    const path = `$.selectorTemplates[${captureIndex}]`;
    const registration = inspectSelectorConfigurationTemplate(capture.template, path);
    const accepted = new Set<BlueprintParameterHandle>();
    if (containsNativeUnsupportedExpression(capture.template)) {
      reject(path, 'native source export does not support Selector expressions.', capture.source);
    }
    if (capture.template.operation === 'select') {
      const parameter = canonicalBlueprintParameterHandle(capture.template.index);
      if (parameter !== undefined && parameter.kind === 'number') {
        accepted.add(parameter);
        used.add(parameter);
        occurrences.push({
          kind: 'selector-index',
          captureId: capture.captureId,
          parameter,
          path: `${path}.index`,
          source: capture.source,
        });
      }
    }
    if (registration.usedParameters.some((parameter) => !accepted.has(parameter))) {
      reject(
        `${path}.${capture.template.operation === 'select' ? 'index' : 'output'}`,
        'native source export supports only direct numeric Selector select indices.',
        capture.source,
      );
    }
  });
  state.source.deciderTemplates.forEach((capture, captureIndex) => {
    const path = `$.deciderTemplates[${captureIndex}]`;
    const registration = inspectDeciderConfigurationTemplate(capture.template, path);
    const accepted = new Set<BlueprintParameterHandle>();
    for (const key of ['outputs', 'elseOutputs'] as const) {
      capture.template[key]?.forEach((output, index) => {
        if (
          output.signal.kind === 'signal' &&
          canonicalBlueprintParameterHandle(output.signal.signal) !== undefined
        ) {
          reject(
            `${path}.${key}[${index}].signal`,
            'native source export does not support symbolic Decider outputs.',
            capture.source,
          );
        }
        if (output.mode === 'constant' && typeof output.value !== 'number') {
          reject(
            `${path}.${key}[${index}].value`,
            'native source export does not support symbolic Decider output constants.',
            capture.source,
          );
        }
      });
    }
    const collectThresholds = (
      condition: DeciderTemplateCondition,
      conditionPath: readonly number[],
      conditionSourcePath: string,
    ): void => {
      if (condition.kind !== 'compare') {
        condition.conditions.forEach((child, index) =>
          collectThresholds(
            child,
            [...conditionPath, index],
            `${conditionSourcePath}.conditions[${index}]`,
          ),
        );
        return;
      }
      if (condition.right.kind !== 'constant') return;
      const operandPath = `${conditionSourcePath}.right.value`;
      if (isRegisteredBlueprintNumericExpression(condition.right.value)) {
        reject(
          operandPath,
          'native source export does not support expression thresholds.',
          capture.source,
        );
      }
      const parameter = canonicalBlueprintParameterHandle(condition.right.value);
      if (parameter !== undefined && parameter.kind === 'number') {
        accepted.add(parameter);
        used.add(parameter);
        occurrences.push({
          kind: 'decider-threshold',
          conditionPath,
          captureId: capture.captureId,
          parameter,
          path: operandPath,
          source: capture.source,
        });
      }
    };
    collectThresholds(capture.template.condition, [], `${path}.condition`);
    if (registration.usedParameters.some((parameter) => !accepted.has(parameter))) {
      reject(
        `${path}.condition`,
        'native source export supports only direct numeric Decider right thresholds.',
        capture.source,
      );
    }
  });
  state.source.arithmeticTemplates.forEach((capture, captureIndex) => {
    const path = `$.arithmeticTemplates[${captureIndex}]`;
    inspectArithmeticConfigurationTemplate(capture.template, path);
    for (const [key, side] of [
      ['left', 'first'],
      ['right', 'second'],
    ] as const) {
      const operand = capture.template[key];
      if (operand.kind !== 'constant') continue;
      const operandPath = `${path}.${key}.value`;
      if (isRegisteredBlueprintNumericExpression(operand.value)) {
        reject(
          operandPath,
          'native source export does not support expression operands.',
          capture.source,
        );
      }
      const parameter = canonicalBlueprintParameterHandle(operand.value);
      if (parameter === undefined) continue;
      used.add(parameter);
      occurrences.push({
        kind: 'arithmetic-operand',
        captureId: capture.captureId,
        side,
        parameter,
        path: operandPath,
        source: capture.source,
      });
    }
  });
  state.source.constantTemplates.forEach((capture, captureIndex) => {
    const path = `$.constantTemplates[${captureIndex}]`;
    inspectConstantConfigurationTemplate(capture.template, path);
    capture.template.sections.forEach((section, sectionIndex) => {
      const sectionPath = `${path}.sections[${sectionIndex}]`;
      if (typeof section.multiplier !== 'number') {
        reject(
          `${sectionPath}.multiplier`,
          'native source export does not support symbolic multipliers.',
          capture.source,
        );
      }
      section.filters.forEach((filter, filterIndex) => {
        const filterPath = `${sectionPath}.filters[${filterIndex}]`;
        if (canonicalBlueprintParameterHandle(filter.signal) !== undefined) {
          reject(
            `${filterPath}.signal`,
            'native source export does not support signal parameters.',
            capture.source,
          );
        }
        if (isRegisteredBlueprintNumericExpression(filter.value)) {
          reject(
            `${filterPath}.value`,
            'native source export does not support expression counts.',
            capture.source,
          );
        }
        const parameter = canonicalBlueprintParameterHandle(filter.value);
        if (parameter === undefined) return;
        used.add(parameter);
        occurrences.push({
          kind: 'constant-count',
          captureId: capture.captureId,
          sectionIndex,
          filterIndex,
          parameter,
          path: `${filterPath}.value`,
          source: capture.source,
        });
      });
    });
  });
  const originals = new Map<number, SourceCompilationParameter>();
  const parameters: NativeBlueprintParameter[] = declarations.map((declaration, index) => {
    if (!used.has(declaration.parameter)) {
      reject(
        `$.parameters[${index}]`,
        'native source export does not support unused declarations.',
        declaration.source,
      );
    }
    const original = declaration.defaultValue as number;
    const first = originals.get(original);
    if (first !== undefined) {
      reject(
        `$.parameters[${index}].defaultValue`,
        `original ${String(original)} is already used by declaration ${JSON.stringify(first.label)} at ${first.source.fileId}:${first.source.start}-${first.source.end}.`,
        declaration.source,
      );
    }
    originals.set(original, declaration);
    return Object.freeze({
      type: 'number',
      number: String(original),
      name: declaration.label,
      ...declaration.metadata,
    });
  });

  // The binder authenticates templates, their session and their exact physical producer relation.
  const replacement = bindCapturedSourceConfigurationTemplatesWithRelations(
    state.source,
    state.execution,
  );
  const projected = buildNativeBlueprintFcir(replacement.circuit, options);
  const relations = new Map(
    replacement.captureRelations.map((relation) => [relation.captureId, relation]),
  );
  const entities = new Map(projected.entities.map((entity) => [entity.entityNumber, entity]));
  const defaults = new Map(
    declarations.map((declaration) => [declaration.parameter, declaration.defaultValue]),
  );
  type Comparison = Extract<LogicalDeciderCondition, { kind: 'compare' }>;
  const deciderRowIndices = new Map<number, Map<Comparison, number[]>>();
  for (const occurrence of occurrences) {
    const relation = relations.get(occurrence.captureId);
    const family =
      occurrence.kind === 'constant-count'
        ? 'constant'
        : occurrence.kind === 'arithmetic-operand'
          ? 'arithmetic'
          : occurrence.kind === 'selector-index'
            ? 'selector'
            : 'decider';
    if (
      relation === undefined ||
      relation.kind !== family ||
      replacement.circuit.producers[relation.producerIndex]?.id !== relation.producerId
    ) {
      reject(
        occurrence.path,
        'missing authenticated numeric configuration producer relation.',
        occurrence.source,
      );
    }
    // The canonical projector assigns producer entity numbers in NCIR producer order.
    const entity = entities.get(relation.producerIndex + 1);
    if (occurrence.kind === 'selector-index') {
      const behavior = entity?.native.control_behavior as
        { readonly operation?: string; readonly index_constant?: number } | undefined;
      if (
        behavior?.operation !== 'select' ||
        behavior.index_constant !== defaults.get(occurrence.parameter)
      ) {
        reject(
          occurrence.path,
          'marked Selector index did not survive native projection unchanged.',
          occurrence.source,
        );
      }
      continue;
    }
    if (occurrence.kind === 'decider-threshold') {
      const behavior = entity?.native.control_behavior as
        | {
            readonly decider_conditions?: {
              readonly conditions?: readonly { readonly constant?: number }[];
            };
          }
        | undefined;
      const conditions = behavior?.decider_conditions?.conditions;
      const producer = replacement.circuit.producers[relation.producerIndex];
      if (producer?.kind !== 'decider') {
        reject(occurrence.path, 'marked Decider producer is unavailable.', occurrence.source);
      }
      let indices = deciderRowIndices.get(relation.producerIndex);
      if (indices === undefined) {
        const rowsByLeaf = new Map<Comparison, number[]>();
        const leaves = nativeDeciderConditionGroups(
          producer.config.condition,
          options.maxDeciderConditionRows,
        ).flat();
        if (conditions?.length !== leaves.length) {
          reject(
            occurrence.path,
            'marked Decider condition rows changed during native projection.',
            occurrence.source,
          );
        }
        leaves.forEach((leaf, index) => {
          const rows = rowsByLeaf.get(leaf) ?? [];
          rows.push(index);
          rowsByLeaf.set(leaf, rows);
        });
        indices = rowsByLeaf;
        deciderRowIndices.set(relation.producerIndex, indices);
      }
      let leaf: LogicalDeciderCondition | undefined = producer.config.condition;
      for (const index of occurrence.conditionPath) {
        leaf = leaf?.kind === 'compare' ? undefined : leaf?.conditions[index];
      }
      const rows = leaf?.kind === 'compare' ? indices.get(leaf) : undefined;
      if (
        rows === undefined ||
        rows.length === 0 ||
        rows.some((index) => conditions?.[index]?.constant !== defaults.get(occurrence.parameter))
      ) {
        reject(
          occurrence.path,
          'marked Decider threshold did not survive native row projection unchanged.',
          occurrence.source,
        );
      }
      continue;
    }
    if (occurrence.kind === 'arithmetic-operand') {
      const behavior = entity?.native.control_behavior as
        | {
            readonly arithmetic_conditions?: {
              readonly first_constant?: number;
              readonly second_constant?: number;
            };
          }
        | undefined;
      const field = occurrence.side === 'first' ? 'first_constant' : 'second_constant';
      if (behavior?.arithmetic_conditions?.[field] !== defaults.get(occurrence.parameter)) {
        reject(
          occurrence.path,
          'marked Arithmetic operand did not survive native projection unchanged.',
          occurrence.source,
        );
      }
      continue;
    }
    const behavior = entity?.native.control_behavior as
      | {
          readonly sections?: {
            readonly sections?: readonly {
              readonly index?: number;
              readonly filters?: readonly { readonly index?: number; readonly count?: number }[];
            }[];
          };
        }
      | undefined;
    const section = behavior?.sections?.sections?.[occurrence.sectionIndex];
    const filter = section?.filters?.[occurrence.filterIndex];
    if (
      section?.index !== occurrence.sectionIndex + 1 ||
      filter?.index !== occurrence.filterIndex + 1 ||
      filter.count !== defaults.get(occurrence.parameter)
    ) {
      reject(
        occurrence.path,
        'marked Constant count did not survive native projection unchanged.',
        occurrence.source,
      );
    }
  }
  const native = Object.freeze({ ...projected, parameters: Object.freeze(parameters) });
  validateNativeBlueprintFcir(native);
  return native;
}

/** Immutable host-local pair of one compilation's concrete Plan and physical circuit. */
export interface BoundSourceCompilationCircuit {
  readonly plan: DirectElaborationPlan;
  readonly resolvedCircuit: ResolvedCircuit;
}

/** Binds this exact compilation into a matching, strictly replayable concrete pair. */
export function bindSourceCompilationCircuit(
  compilation: LocalSourceCompilation,
  bindings: readonly BlueprintParameterBinding[] = [],
): BoundSourceCompilationCircuit {
  const state = capturedParametersByCompilation.get(compilation);
  if (state === undefined) {
    throw new TypeError('Compilation has no host-local source parameter declarations.');
  }
  if (state.execution === undefined || compilation.plan === undefined) {
    throw new TypeError('Compilation has no canonical execution available for parameter binding.');
  }
  if (compilation.resolvedCircuit === undefined) {
    throw new TypeError('Compilation has no resolved circuit available for parameter binding.');
  }

  const replacement = bindCapturedSourceConfigurationTemplatesWithRelations(
    state.source,
    state.execution,
    bindings,
  );
  const plan = materializeCapturedPlan(
    compilation.plan,
    replacement.captureRelations,
    replacement.circuit,
  );
  const resolvedCircuit = canonicalResolvedCircuit(
    compilation.resolvedCircuit,
    plan,
    replacement.circuit,
  ) as ResolvedCircuit;
  executeResolvedDirectPlan(plan, resolvedCircuit);
  return Object.freeze({ plan, resolvedCircuit });
}

/** Runs the complete browser/Node-neutral compilation pipeline once. */
export function compileSourceProgram(
  file: SourceFileSnapshot,
  environment: SourceCompilationEnvironment = {},
  preflightDiagnostics: readonly Diagnostic[] = [],
  observe?: SourceCompilationObserver,
): LocalSourceCompilation {
  observe?.('parse');
  return compileParsedSource(parseFile(file), environment, preflightDiagnostics, observe);
}

/** Compiles an already project-parsed file without repeating parser work. */
export function compileParsedSourceProgram(
  file: ParsedSourceFile,
  environment: SourceCompilationEnvironment = {},
  preflightDiagnostics: readonly Diagnostic[] = [],
  observe?: SourceCompilationObserver,
): LocalSourceCompilation {
  return compileParsedSource(file, environment, preflightDiagnostics, observe);
}

/** Removes every host-local value before a result crosses a process/Worker boundary. */
export function sourceCompilationArtifact(
  compilation: LocalSourceCompilation,
): SourceCompilationArtifact {
  if (parameterSourceArtifacts.has(compilation)) {
    const {
      execution: _execution,
      elaborationJavaScript: _internalLowering,
      ...artifact
    } = compilation;
    return artifact;
  }
  const { execution: _execution, ...artifact } = compilation;
  return artifact;
}
