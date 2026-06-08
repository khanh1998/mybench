<script lang="ts">
  let { getMarkdown }: { getMarkdown: () => string } = $props();

  let copied = $state(false);
  let timer: ReturnType<typeof setTimeout> | null = null;

  function copy() {
    navigator.clipboard.writeText(getMarkdown());
    copied = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { copied = false; }, 1600);
  }
</script>

<button type="button" class="copy-table-btn" class:copied title="Copy as Markdown table" onclick={copy}>
  {#if copied}
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0z"/></svg>
  {:else}
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>
  {/if}
  MD
</button>

<style>
  .copy-table-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
    font-size: 11px;
    color: #888;
    background: none;
    border: 1px solid #e3e3e3;
    border-radius: 4px;
    padding: 2px 7px;
    cursor: pointer;
    line-height: 1.4;
    min-height: 22px;
  }
  .copy-table-btn:hover {
    color: #333;
    border-color: #bbb;
    background: #f7f7f7;
  }
  .copy-table-btn.copied {
    color: #16a34a;
    border-color: #86efac;
    background: #f0fdf4;
  }
</style>
