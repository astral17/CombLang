import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  snippetCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { javascript, typescriptLanguage } from '@codemirror/lang-javascript';
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  foldedRanges,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
  unfoldEffect,
} from '@codemirror/language';
import {
  lintGutter,
  lintKeymap,
  setDiagnostics,
  type Diagnostic as EditorDiagnostic,
} from '@codemirror/lint';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { EditorState } from '@codemirror/state';
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import type { Diagnostic } from '@comblang/shared';
import { tags } from '@lezer/highlight';

const combLangHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: '#c59770' },
  {
    tag: [tags.definition(tags.variableName), tags.definition(tags.propertyName)],
    color: '#d2c39a',
  },
  { tag: tags.function(tags.variableName), color: '#a7bea5' },
  { tag: [tags.typeName, tags.className], color: '#86aaa0' },
  { tag: [tags.variableName, tags.propertyName], color: '#c8d0ca' },
  { tag: [tags.string, tags.character], color: '#c58e7a' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: '#b9aa7d' },
  { tag: [tags.operator, tags.punctuation], color: '#aeb9b2' },
  { tag: [tags.comment, tags.docComment], color: '#687a70', fontStyle: 'italic' },
  { tag: tags.invalid, color: '#df857c', textDecoration: 'underline' },
]);

const dslCompletions: readonly Completion[] = [
  snippetCompletion('new Network<${R}>()', {
    label: 'Network',
    detail: 'create a circuit network',
    type: 'class',
  }),
  snippetCompletion('Signal("${virtual}", "${signal-A}")', {
    label: 'Signal (typed)',
    detail: 'typed Factorio signal identity',
    type: 'function',
  }),
  snippetCompletion('Signal("${iron-plate}")', {
    label: 'Signal (item)',
    detail: 'Factorio item signal with default type',
    type: 'function',
  }),
  snippetCompletion('CC(${1} * ${SIGNAL_A})', {
    label: 'CC',
    detail: 'constant combinator producer',
    type: 'function',
  }),
  snippetCompletion('IF(${condition}, ${output})', {
    label: 'IF',
    detail: 'decider producer',
    type: 'function',
  }),
  snippetCompletion('when(${condition}).then(${output})', {
    label: 'when',
    detail: 'fluent decider producer',
    type: 'function',
  }),
  snippetCompletion('to(${first}, ${second})', {
    label: 'to',
    detail: 'multi-destination attachment',
    type: 'function',
  }),
  { label: 'Each', detail: 'each signal wildcard', type: 'constant' },
  { label: 'Anything', detail: 'anything wildcard', type: 'constant' },
  { label: 'Any', detail: 'alias of Anything', type: 'constant' },
  { label: 'Everything', detail: 'everything wildcard', type: 'constant' },
  { label: 'All', detail: 'alias of Everything', type: 'constant' },
  { label: 'pair', detail: 'read both wire colors', type: 'function' },
  { label: 'Producer', detail: 'unmaterialized combinator handle', type: 'type' },
  { label: 'DeciderCombinator', detail: 'stored decider producer', type: 'type' },
  { label: 'ArithmeticCombinator', detail: 'stored arithmetic producer', type: 'type' },
  { label: 'ConstantCombinator', detail: 'stored constant producer', type: 'type' },
];

function dslCompletionSource(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(/[\w$]*$/);
  if (word === null || (word.from === word.to && !context.explicit)) return null;
  return { from: word.from, options: dslCompletions, validFor: /^[\w$]*$/ };
}

export function toEditorDiagnostics(
  sourceLength: number,
  diagnostics: readonly Diagnostic[],
): readonly EditorDiagnostic[] {
  return diagnostics.map((diagnostic) => {
    const start = diagnostic.span?.start ?? 0;
    const end = diagnostic.span?.end ?? start;
    const from = Math.min(sourceLength, Math.max(0, start));
    const to = Math.min(sourceLength, Math.max(from, end));
    return {
      from,
      to,
      severity: diagnostic.severity,
      message: `${diagnostic.code}: ${diagnostic.message}`,
    };
  });
}

export interface SourceEditor {
  readonly kind: SourceEditorKind;
  getValue(): string;
  insertText(text: string): void;
  revealRange(start: number, end: number): void;
  setDiagnostics(diagnostics: readonly Diagnostic[]): void;
  destroy(): void;
}

export type SourceEditorKind = 'codemirror' | 'native';
export type SourceEditorMode = SourceEditorKind | 'auto';

export function chooseSourceEditorKind(
  mode: SourceEditorMode,
  narrowCoarsePointer: boolean,
): SourceEditorKind {
  return mode === 'auto' ? (narrowCoarsePointer ? 'native' : 'codemirror') : mode;
}

export function createSourceEditor(
  parent: HTMLElement,
  initialValue: string,
  onChange: () => void,
  mode: SourceEditorMode = 'auto',
  ariaLabel = 'CombLang source editor, main.factorio.ts',
): SourceEditor {
  const kind = chooseSourceEditorKind(
    mode,
    window.matchMedia('(max-width: 850px) and (pointer: coarse)').matches,
  );
  if (kind === 'native') {
    const textarea = document.createElement('textarea');
    textarea.className = 'native-source-editor';
    textarea.value = initialValue;
    textarea.setAttribute('aria-label', ariaLabel);
    textarea.autocapitalize = 'off';
    textarea.autocomplete = 'off';
    textarea.setAttribute('autocorrect', 'off');
    textarea.spellcheck = false;
    textarea.wrap = 'off';
    textarea.addEventListener('input', onChange);
    parent.append(textarea);
    return {
      kind,
      getValue: () => textarea.value,
      revealRange: (start, end) => {
        textarea.focus();
        textarea.setSelectionRange(start, end);
        const before = textarea.value.slice(0, start).split('\n');
        const line = before.length - 1;
        const style = getComputedStyle(textarea);
        const lineHeight = Number.parseFloat(style.lineHeight) || 20;
        textarea.scrollTop = Math.max(0, line * lineHeight - textarea.clientHeight / 2);
        const measure = document.createElement('canvas').getContext('2d');
        if (measure !== null) {
          measure.font = `${style.fontSize} ${style.fontFamily}`;
          const tabSize = Number.parseInt(style.tabSize, 10) || 4;
          const prefix = before
            .at(-1)!
            .split('\t')
            .reduce(
              (text, part, index) =>
                text + (index === 0 ? '' : ' '.repeat(tabSize - (text.length % tabSize))) + part,
              '',
            );
          textarea.scrollLeft = Math.max(
            0,
            measure.measureText(prefix).width - textarea.clientWidth / 3,
          );
        }
        textarea.scrollIntoView({ block: 'center' });
      },
      insertText: (text) => {
        const separator = textarea.value.length === 0 || textarea.value.endsWith('\n') ? '' : '\n';
        const insertion = `${separator}${text}`;
        textarea.setRangeText(insertion, textarea.value.length, textarea.value.length, 'end');
        textarea.focus();
        onChange();
      },
      setDiagnostics: (diagnostics) => {
        const errors = diagnostics.filter(({ severity }) => severity === 'error').length;
        textarea.setAttribute('aria-invalid', String(errors > 0));
        textarea.title = diagnostics.map(({ code, message }) => `${code}: ${message}`).join('\n');
      },
      destroy: () => textarea.remove(),
    };
  }

  const state = EditorState.create({
    doc: initialValue,
    extensions: [
      lineNumbers(),
      history(),
      foldGutter(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      syntaxHighlighting(combLangHighlightStyle),
      bracketMatching(),
      closeBrackets(),
      autocompletion(),
      lintGutter(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      highlightSelectionMatches(),
      EditorView.lineWrapping,
      javascript({ typescript: true }),
      typescriptLanguage.data.of({ autocomplete: dslCompletionSource }),
      EditorView.contentAttributes.of({
        'aria-label': ariaLabel,
        autocapitalize: 'off',
        autocomplete: 'off',
        autocorrect: 'off',
        spellcheck: 'false',
      }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChange();
      }),
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...completionKeymap,
        ...lintKeymap,
        indentWithTab,
      ]),
    ],
  });
  const view = new EditorView({ state, parent });
  return {
    kind,
    getValue: () => view.state.doc.toString(),
    revealRange: (start, end) => {
      const effects: ReturnType<typeof unfoldEffect.of>[] = [];
      foldedRanges(view.state).between(start, end, (from, to) => {
        effects.push(unfoldEffect.of({ from, to }));
      });
      view.dispatch({ selection: { anchor: start, head: end }, effects, scrollIntoView: true });
      view.focus();
      view.dom.scrollIntoView({ block: 'center' });
    },
    insertText: (text) => {
      const separator =
        view.state.doc.length === 0 || view.state.doc.toString().endsWith('\n') ? '' : '\n';
      const insertion = `${separator}${text}`;
      const end = view.state.doc.length;
      view.dispatch({
        changes: { from: end, insert: insertion },
        selection: { anchor: end + insertion.length },
        scrollIntoView: true,
      });
      view.focus();
    },
    setDiagnostics: (diagnostics) => {
      view.dispatch(
        setDiagnostics(view.state, toEditorDiagnostics(view.state.doc.length, diagnostics)),
      );
    },
    destroy: () => view.destroy(),
  };
}
