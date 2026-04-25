<script lang="ts">
  import { page } from '$app/stores';
  let { children } = $props();
</script>

<nav class="navbar">
  <a href="/" class="brand">mybench</a>
  <a href="/decisions" class:active={$page.url.pathname.startsWith('/decisions')}>Decisions</a>
  <a href="/metrics" class:active={$page.url.pathname.startsWith('/metrics')}>Metrics</a>
  <a href="/onboard" class:active={$page.url.pathname.startsWith('/onboard')}>Onboard</a>
  <a href="/settings" class:active={$page.url.pathname.startsWith('/settings')}>Settings</a>
</nav>

<main class="container">
  {@render children()}
</main>

<style>
  :global(*, *::before, *::after) { box-sizing: border-box; }
  :global(body) {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 14px;
    background: #f5f5f5;
    color: #333;
  }
  :global(h1, h2, h3) { margin: 0 0 0.5rem; }
  :global(button) {
    cursor: pointer;
    font-size: 13px;
    padding: 6px 12px;
    border: 1px solid #ccc;
    border-radius: 4px;
    background: #fff;
  }
  :global(button:hover) { background: #f0f0f0; }
  :global(button.primary) { background: #0066cc; color: #fff; border-color: #0066cc; }
  :global(button.primary:hover) { background: #0055aa; }
  :global(button.danger) { background: #cc2200; color: #fff; border-color: #cc2200; }
  :global(button.danger:hover) { background: #aa1100; }
  :global(input, select, textarea) {
    font-size: 13px;
    padding: 6px 8px;
    border: 1px solid #ccc;
    border-radius: 4px;
    width: 100%;
  }
  :global(input:focus, select:focus, textarea:focus) {
    outline: none;
    border-color: #0066cc;
    box-shadow: 0 0 0 2px rgba(0,102,204,0.2);
  }
  :global(label) { display: block; font-weight: 600; margin-bottom: 4px; font-size: 12px; color: #555; }
  :global(.form-group) { margin-bottom: 12px; }
  :global(.card) {
    background: #fff;
    border: 1px solid #e0e0e0;
    border-radius: 6px;
    padding: 16px;
    margin-bottom: 12px;
  }
  :global(table) { width: 100%; border-collapse: collapse; font-size: 13px; }
  :global(th, td) { padding: 8px 10px; text-align: left; border-bottom: 1px solid #e8e8e8; }
  :global(th) { background: #f8f8f8; font-weight: 600; font-size: 12px; color: #666; }
  :global(.badge) {
    display: inline-block;
    padding: 2px 6px;
    border-radius: 3px;
    font-size: 11px;
    font-weight: 600;
  }
  :global(.badge-sql) { background: #e8f4fd; color: #0066cc; }
  :global(.badge-pgbench) { background: #fef3e8; color: #cc6600; }
  :global(.badge-sysbench) { background: #e8fef3; color: #006633; }
  :global(.badge-collect) { background: #f0e8ff; color: #6600cc; }
  :global(.badge-pg_stat_statements_reset) { background: #e8f7f1; color: #0b6b50; }
  :global(.badge-pg_stat_statements_collect) { background: #fff1e8; color: #9a4d00; }
  :global(.badge-running) { background: #fff3cd; color: #856404; }
  :global(.badge-completed) { background: #d4edda; color: #155724; }
  :global(.badge-failed) { background: #f8d7da; color: #721c24; }
  :global(.badge-stopped) { background: #e2e3e5; color: #383d41; }
  :global(pre.output) {
    background: #1e1e1e;
    color: #d4d4d4;
    padding: 12px;
    border-radius: 4px;
    overflow: auto;
    font-size: 12px;
    font-family: 'Menlo', 'Monaco', 'Courier New', monospace;
    max-height: 400px;
    white-space: pre-wrap;
    word-break: break-all;
  }
  :global(textarea.code) {
    font-family: 'Menlo', 'Monaco', 'Courier New', monospace;
    font-size: 12px;
    resize: vertical;
  }
  :global(.error) { color: #cc2200; font-size: 12px; }
  :global(.success) { color: #155724; font-size: 12px; }
  :global(.row) { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  :global(.spacer) { flex: 1; }

  .navbar {
    background: #1a1a2e;
    padding: 0 20px;
    display: flex;
    align-items: center;
    gap: 20px;
    height: 48px;
  }
  .navbar a {
    color: #aaa;
    text-decoration: none;
    font-size: 14px;
    padding: 4px 0;
    border-bottom: 2px solid transparent;
  }
  .navbar a:hover { color: #fff; }
  .navbar a.active { color: #fff; border-bottom-color: #0066cc; }
  .brand {
    color: #fff !important;
    font-weight: 700;
    font-size: 16px !important;
    margin-right: 12px;
    border-bottom: none !important;
  }
  .container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 24px 20px;
  }
</style>
