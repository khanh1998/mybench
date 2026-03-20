<script lang="ts">
  import CodeMirror from 'svelte-codemirror-editor';
  import { sql } from '@codemirror/lang-sql';
  import { oneDark } from '@codemirror/theme-one-dark';
  import { vim } from '@replit/codemirror-vim';
  import { paramAutocomplete, paramLinter } from '$lib/codemirror-params';
  import type { Extension } from '@codemirror/state';
  import { browser } from '$app/environment';

  interface Props {
    value: string;
    onchange?: (value: string) => void;
    params?: string[];
  }

  let { value = $bindable(''), onchange, params }: Props = $props();

  let vimMode = $state(browser ? localStorage.getItem('editor-vim') === '1' : false);

  function toggleVim() {
    vimMode = !vimMode;
    if (browser) localStorage.setItem('editor-vim', vimMode ? '1' : '0');
  }

  const extensions: Extension[] = $derived([
    ...(vimMode ? [vim()] : []),
    ...(params ? [paramAutocomplete(params), paramLinter(params)] : [])
  ]);
</script>

<div class="editor-root">
  <div class="editor-toolbar">
    <button class="vim-btn" class:active={vimMode} onclick={toggleVim} title="Toggle Vim mode">VIM</button>
  </div>
  <div class="editor-body">
    <CodeMirror
      bind:value
      lang={sql()}
      theme={oneDark}
      lineNumbers
      {onchange}
      {extensions}
      styles={{
        '&': { height: '100%' },
        '.cm-scroller': { overflow: 'auto' }
      }}
    />
  </div>
</div>

<style>
  .editor-root {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
  }

  .editor-toolbar {
    display: flex;
    justify-content: flex-end;
    padding: 2px 4px;
    background: #282c34;
    border-bottom: 1px solid #3a3f4b;
    flex-shrink: 0;
  }

  .vim-btn {
    font-size: 10px;
    font-weight: 700;
    padding: 1px 6px;
    background: transparent;
    border: 1px solid #555;
    border-radius: 3px;
    color: #888;
    cursor: pointer;
    letter-spacing: 0.05em;
  }
  .vim-btn:hover { border-color: #999; color: #ccc; }
  .vim-btn.active { background: #4a6fa5; border-color: #4a6fa5; color: #fff; }

  .editor-body {
    flex: 1;
    min-height: 0;
    position: relative;
  }

  /* svelte-codemirror-editor renders a wrapper div — make it fill the container */
  .editor-body :global(> div) {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
  }

  .editor-body :global(.cm-editor) {
    flex: 1;
    min-height: 0;
    height: 100%;
  }

  .editor-body :global(.cm-scroller) {
    overflow: auto !important;
    font-family: 'Menlo', 'Monaco', 'Courier New', monospace !important;
    font-size: 13px;
    line-height: 1.6;
  }

  .editor-body :global(.cm-focused) {
    outline: none;
  }
</style>
