<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from '@codemirror/view';
  import { EditorState } from '@codemirror/state';
  import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
  import { indentOnInput, bracketMatching, foldGutter, foldKeymap } from '@codemirror/language';
  import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from '@codemirror/autocomplete';
  import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
  import { sql } from '@codemirror/lang-sql';
  import { oneDark } from '@codemirror/theme-one-dark';

  interface Props {
    value: string;
    onchange?: (value: string) => void;
  }

  let { value = $bindable(''), onchange }: Props = $props();

  let container: HTMLDivElement;
  let view: EditorView | null = null;
  let skipEffect = false;

  onMount(() => {
    view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          foldGutter(),
          drawSelection(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          sql(),
          oneDark,
          history(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion(),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          keymap.of([
            indentWithTab as any,
            ...closeBracketsKeymap as any[],
            ...defaultKeymap as any[],
            ...historyKeymap as any[],
            ...foldKeymap as any[],
            ...completionKeymap as any[],
            ...searchKeymap as any[],
          ]),
          EditorView.theme({
            '&': { height: '100%' },
            '.cm-scroller': { overflow: 'auto' },
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              skipEffect = true;
              value = update.state.doc.toString();
              onchange?.(value);
              skipEffect = false;
            }
          }),
        ],
      }),
      parent: container,
    });
  });

  $effect(() => {
    if (!view || skipEffect) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  });

  onDestroy(() => view?.destroy());
</script>

<div bind:this={container} class="editor-root"></div>

<style>
  .editor-root {
    position: absolute;
    inset: 0;
  }
  .editor-root :global(.cm-scroller) {
    font-family: 'Menlo', 'Monaco', 'Courier New', monospace !important;
    font-size: 13px;
    line-height: 1.6;
  }
  .editor-root :global(.cm-focused) {
    outline: none;
  }
</style>
