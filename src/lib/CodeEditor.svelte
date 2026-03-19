<script lang="ts">
  import CodeMirror from 'svelte-codemirror-editor';
  import { sql } from '@codemirror/lang-sql';
  import { oneDark } from '@codemirror/theme-one-dark';

  interface Props {
    value: string;
    onchange?: (value: string) => void;
  }

  let { value = $bindable(''), onchange }: Props = $props();
</script>

<div class="editor-root">
  <CodeMirror
    bind:value
    lang={sql()}
    theme={oneDark}
    lineNumbers
    {onchange}
    styles={{
      '&': { height: '100%' },
      '.cm-scroller': { overflow: 'auto' }
    }}
  />
</div>

<style>
  .editor-root {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
  }

  /* svelte-codemirror-editor renders a wrapper div — make it fill the container */
  .editor-root :global(> div) {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .editor-root :global(.cm-editor) {
    flex: 1;
    min-height: 0;
    height: 100%;
  }

  .editor-root :global(.cm-scroller) {
    overflow: auto !important;
    font-family: 'Menlo', 'Monaco', 'Courier New', monospace !important;
    font-size: 13px;
    line-height: 1.6;
  }

  .editor-root :global(.cm-focused) {
    outline: none;
  }
</style>
