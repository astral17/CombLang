import { signalTypes, type SignalId, type SignalType } from '@comblang/factorio';
import type {
  SourceParameterDescriptor,
  SourceParameterOverride,
} from '@comblang/runtime/source-parameter-binding';

export type ParameterDraft =
  | { readonly id: number; readonly kind: 'number'; value: string }
  | {
      readonly id: number;
      readonly kind: 'signal';
      type: SignalType;
      name: string;
      quality: string;
    };

export interface ParameterPanelElements {
  readonly fields: HTMLElement;
  readonly empty: HTMLElement;
  readonly status: HTMLOutputElement;
  readonly apply: HTMLButtonElement;
  readonly reset: HTMLButtonElement;
  readonly recompile: HTMLButtonElement;
}

export type ParameterPanelStatus = 'pending' | 'valid' | 'warning' | 'invalid' | 'none';

export class ParameterPanel {
  #parameters: readonly SourceParameterDescriptor[] | undefined;
  #drafts: ParameterDraft[] = [];
  #available = false;
  #statusMessage = 'Waiting for source compilation.';
  #statusState: ParameterPanelStatus = 'pending';

  constructor(
    private readonly elements: ParameterPanelElements,
    onApply: (overrides: readonly SourceParameterOverride[]) => void,
    onReset: () => void,
    onRecompile: () => void,
  ) {
    elements.apply.addEventListener('click', () => {
      if (this.#parameters === undefined || !this.#available) return;
      onApply(parameterDraftOverrides(this.#parameters, this.#drafts));
    });
    elements.reset.addEventListener('click', () => {
      if (this.#parameters === undefined || !this.#available) return;
      this.#drafts = createParameterDrafts(this.#parameters);
      this.#renderFields();
      onReset();
    });
    elements.recompile.addEventListener('click', onRecompile);
    this.#render();
  }

  setParameters(parameters: readonly SourceParameterDescriptor[] | undefined): void {
    this.#parameters = parameters;
    this.#drafts = parameters === undefined ? [] : createParameterDrafts(parameters);
    this.#available = false;
    this.#renderFields();
    this.#render();
  }

  setAvailability(available: boolean, message: string, state: ParameterPanelStatus): void {
    this.#available = available;
    this.#statusMessage = message;
    this.#statusState = state;
    this.#render();
  }

  setPending(message = 'Binding the latest parameter values…'): void {
    this.#statusMessage = message;
    this.#statusState = 'pending';
    this.#render();
  }

  setStatus(message: string, state: ParameterPanelStatus): void {
    this.#statusMessage = message;
    this.#statusState = state;
    this.#render();
  }

  #render(): void {
    const hasParameters = (this.#parameters?.length ?? 0) > 0;
    this.elements.empty.hidden = this.#parameters === undefined || hasParameters;
    this.elements.empty.textContent =
      this.#parameters === undefined ? '' : 'This source declares no editable parameters.';
    this.elements.status.textContent = this.#statusMessage;
    this.elements.status.dataset.state = this.#statusState;
    this.elements.apply.disabled = !hasParameters || !this.#available;
    this.elements.reset.disabled = !hasParameters || !this.#available;
  }

  #renderFields(): void {
    if (this.#parameters === undefined) {
      this.elements.fields.replaceChildren();
      return;
    }
    const rows = this.#parameters.map((parameter, index) => {
      const draft = this.#drafts[index]!;
      const fieldset = document.createElement('fieldset');
      fieldset.className = 'parameter-row';
      const legend = document.createElement('legend');
      legend.textContent = parameter.label;
      fieldset.append(legend);
      if (draft.kind === 'number') {
        const label = document.createElement('label');
        const caption = document.createElement('span');
        caption.textContent = 'Value';
        const input = document.createElement('input');
        input.id = `source-parameter-${parameter.id}-number`;
        input.type = 'number';
        input.step = 'any';
        input.autocomplete = 'off';
        input.value = draft.value;
        input.addEventListener('input', () => {
          draft.value = input.value;
        });
        label.append(caption, input);
        fieldset.append(label);
      } else {
        const typeLabel = document.createElement('label');
        const typeCaption = document.createElement('span');
        typeCaption.textContent = 'Namespace';
        const type = document.createElement('select');
        type.id = `source-parameter-${parameter.id}-type`;
        for (const signalType of signalTypes) {
          const option = document.createElement('option');
          option.value = signalType;
          option.textContent = signalType;
          type.append(option);
        }
        type.value = draft.type;
        type.addEventListener('change', () => {
          draft.type = type.value as SignalType;
        });
        typeLabel.append(typeCaption, type);

        const nameLabel = document.createElement('label');
        const nameCaption = document.createElement('span');
        nameCaption.textContent = 'Signal name';
        const name = document.createElement('input');
        name.id = `source-parameter-${parameter.id}-name`;
        name.type = 'text';
        name.autocomplete = 'off';
        name.spellcheck = false;
        name.value = draft.name;
        name.addEventListener('input', () => {
          draft.name = name.value;
        });
        nameLabel.append(nameCaption, name);

        const qualityLabel = document.createElement('label');
        const qualityCaption = document.createElement('span');
        qualityCaption.textContent = 'Quality (optional)';
        const quality = document.createElement('input');
        quality.id = `source-parameter-${parameter.id}-quality`;
        quality.type = 'text';
        quality.autocomplete = 'off';
        quality.spellcheck = false;
        quality.value = draft.quality;
        quality.addEventListener('input', () => {
          draft.quality = quality.value;
        });
        qualityLabel.append(qualityCaption, quality);
        fieldset.append(typeLabel, nameLabel, qualityLabel);
      }
      return fieldset;
    });
    this.elements.fields.replaceChildren(...rows);
  }
}

function signalDefault(parameter: SourceParameterDescriptor): SignalId {
  if (parameter.kind !== 'signal' || typeof parameter.defaultValue !== 'object') {
    throw new TypeError(`Signal parameter ${parameter.id} has an invalid default descriptor.`);
  }
  return parameter.defaultValue;
}

export function createParameterDrafts(
  parameters: readonly SourceParameterDescriptor[],
): ParameterDraft[] {
  return parameters.map((parameter) => {
    if (parameter.kind === 'number') {
      if (typeof parameter.defaultValue !== 'number') {
        throw new TypeError(`Number parameter ${parameter.id} has an invalid default descriptor.`);
      }
      return { id: parameter.id, kind: 'number', value: String(parameter.defaultValue) };
    }
    const value = signalDefault(parameter);
    return {
      id: parameter.id,
      kind: 'signal',
      type: value.type,
      name: value.name,
      quality: value.quality ?? '',
    };
  });
}

function assertAlignedDrafts(
  parameters: readonly SourceParameterDescriptor[],
  drafts: readonly ParameterDraft[],
): void {
  if (parameters.length !== drafts.length) {
    throw new TypeError('Parameter drafts must align with the descriptor list.');
  }
  for (let index = 0; index < parameters.length; index += 1) {
    const parameter = parameters[index]!;
    const draft = drafts[index]!;
    if (parameter.id !== draft.id || parameter.kind !== draft.kind) {
      throw new TypeError(`Parameter draft at index ${index} does not align with its descriptor.`);
    }
  }
}

function qualityForEquality(quality: string | undefined): string | undefined {
  return quality === undefined || quality === '' || quality === 'normal' ? undefined : quality;
}

export function parameterDraftOverrides(
  parameters: readonly SourceParameterDescriptor[],
  drafts: readonly ParameterDraft[],
): SourceParameterOverride[] {
  assertAlignedDrafts(parameters, drafts);
  const overrides: SourceParameterOverride[] = [];
  for (let index = 0; index < parameters.length; index += 1) {
    const parameter = parameters[index]!;
    const draft = drafts[index]!;
    if (parameter.kind === 'number' && draft.kind === 'number') {
      const value = draft.value.trim() === '' ? Number.NaN : Number(draft.value);
      if (value !== parameter.defaultValue) overrides.push({ id: parameter.id, value });
      continue;
    }
    if (parameter.kind !== 'signal' || draft.kind !== 'signal') {
      throw new TypeError(`Parameter draft at index ${index} has an incompatible kind.`);
    }
    const original = signalDefault(parameter);
    if (
      draft.type === original.type &&
      draft.name === original.name &&
      qualityForEquality(draft.quality) === qualityForEquality(original.quality)
    ) {
      continue;
    }
    overrides.push({
      id: parameter.id,
      value: {
        type: draft.type,
        name: draft.name,
        ...(draft.quality === '' ? {} : { quality: draft.quality }),
      },
    });
  }
  return overrides;
}
