import type { ConstantConfiguration, SignalId } from '@comblang/factorio';

export type NativeBlueprintComparator = '>' | '<' | '=' | '>=' | '<=' | '!=';

export function signalJson(signal: SignalId): Record<string, string> {
  return {
    ...(signal.type === 'item' ? {} : { type: signal.type }),
    name: signal.name,
    ...(signal.quality === undefined ? {} : { quality: signal.quality }),
  };
}

export function comparatorJson(comparator: NativeBlueprintComparator): string {
  return comparator === '>='
    ? '≥'
    : comparator === '<='
      ? '≤'
      : comparator === '!='
        ? '≠'
        : comparator;
}

export function constantEntityControlBehavior(
  configuration: ConstantConfiguration,
): Record<string, unknown> {
  return {
    is_on: configuration.isOn,
    sections: {
      sections: configuration.sections.map((section, sectionIndex) => ({
        index: sectionIndex + 1,
        active: section.active,
        multiplier: section.multiplier,
        ...(section.group === undefined ? {} : { group: section.group }),
        filters: section.filters.map((filter, filterIndex) => ({
          index: filterIndex + 1,
          ...signalJson(filter.signal),
          // BlueprintLogisticFilter uses an omitted quality to mean "any",
          // unlike SignalID where omission defaults to normal.
          quality: filter.signal.quality ?? 'normal',
          comparator: '=',
          count: filter.value,
        })),
      })),
    },
  };
}
