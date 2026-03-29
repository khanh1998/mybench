<script lang="ts">
  import CodeMirror from 'svelte-codemirror-editor';
  import { markdown } from '@codemirror/lang-markdown';
  import { vim } from '@replit/codemirror-vim';
  import { browser } from '$app/environment';
  import type { Extension } from '@codemirror/state';

  interface Props {
    value: string;
    onchange?: (value: string) => void;
    minHeight?: string;
  }

  let { value = $bindable(''), onchange, minHeight = '200px' }: Props = $props();

  // Share vim preference with the SQL CodeEditor
  let vimMode = $state(browser ? localStorage.getItem('editor-vim') === '1' : false);

  function toggleVim() {
    vimMode = !vimMode;
    if (browser) localStorage.setItem('editor-vim', vimMode ? '1' : '0');
  }

  const extensions: Extension[] = $derived([
    ...(vimMode ? [vim()] : []),
  ]);
</script>

<div class="md-editor-root">
  <div class="md-toolbar">
    <span class="md-hint">Markdown</span>
    <button class="vim-btn" class:active={vimMode} onclick={toggleVim} title="Toggle Vim mode">VIM</button>
  </div>
  <div class="md-body" style="min-height: {minHeight}">
    <CodeMirror
      bind:value
      lang={markdown()}
      lineNumbers
      {onchange}
      {extensions}
      styles={{
        '&': { minHeight, height: '100%' },
        '.cm-scroller': { overflow: 'auto' }
      }}
    />
  </div>
</div>

<style>
  .md-editor-root {
    display: flex;
    flex-direction: column;
    border: 1px solid #ddd;
    border-radius: 4px;
    overflow: hidden;
    background: #fff;
    height: 100%;
  }

  .md-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 3px 8px;
    background: #f5f5f5;
    border-bottom: 1px solid #e0e0e0;
    flex-shrink: 0;
  }

  .md-hint {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #aaa;
  }

  .vim-btn {
    font-size: 10px;
    font-weight: 700;
    padding: 1px 6px;
    background: transparent;
    border: 1px solid #ccc;
    border-radius: 3px;
    color: #999;
    cursor: pointer;
    letter-spacing: 0.05em;
  }
  .vim-btn:hover { border-color: #999; color: #555; }
  .vim-btn.active { background: #0066cc; border-color: #0066cc; color: #fff; }

  .md-body {
    flex: 1;
    min-height: 0;
    position: relative;
  }

  .md-body :global(> div) {
    height: 100%;
    display: flex;
    flex-direction: column;
  }

  .md-body :global(.cm-editor) {
    flex: 1;
    min-height: inherit;
    height: 100%;
  }

  .md-body :global(.cm-focused) {
    outline: none;
  }

  .md-body :global(.cm-scroller) {
    font-family: ui-monospace, 'Cascadia Code', 'Menlo', monospace !important;
    font-size: 13px;
    line-height: 1.6;
    overflow: auto !important;
  }

  .md-body :global(.cm-gutters) {
    background: #f9f9f9;
    border-right: 1px solid #e8e8e8;
    color: #bbb;
  }

  .md-body :global(.cm-content) {
    padding: 8px 0;
  }
</style>
