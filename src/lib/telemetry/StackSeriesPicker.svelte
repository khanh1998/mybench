<script lang="ts">
  let {
    options,
    hidden,
    ontoggle
  }: {
    options: { label: string; color: string }[];
    hidden: string[];
    ontoggle: (label: string) => void;
  } = $props();
</script>

<div class="stack-picker" aria-label="Series in stack">
  <span class="stack-picker-label">Stack</span>
  {#each options as option}
    <button
      type="button"
      class="stack-chip"
      class:off={hidden.includes(option.label)}
      aria-pressed={!hidden.includes(option.label)}
      onclick={() => ontoggle(option.label)}
    >
      <span class="swatch" style="background:{option.color}"></span>{option.label}
    </button>
  {/each}
</div>

<style>
  .stack-picker { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .stack-picker-label {
    color: #64748b; font-size: 11px; font-weight: 700; text-transform: uppercase;
  }
  .stack-chip {
    display: inline-flex; align-items: center; gap: 6px;
    border: 1px solid #d7dee8; border-radius: 999px; background: #fff;
    color: #334155; cursor: pointer; font-size: 12px; padding: 3px 10px;
  }
  .stack-chip:hover { border-color: #94a3b8; }
  .stack-chip.off { color: #94a3b8; background: #f8fafc; text-decoration: line-through; }
  .stack-chip.off .swatch { opacity: 0.3; }
  .swatch { width: 9px; height: 9px; border-radius: 2px; }
</style>
