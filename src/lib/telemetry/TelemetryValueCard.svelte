<script lang="ts">
  import { formatValue } from '$lib/telemetry/format';
  import type { TelemetryCard } from '$lib/telemetry/types';

  let {
    card,
    variant = 'summary'
  }: {
    card: TelemetryCard;
    variant?: 'hero' | 'summary';
  } = $props();
</script>

<div class:hero-card={variant === 'hero'} class:summary-card={variant === 'summary'} class="value-card">
  <div class="metric-card-top">
    <div class:hero-label={variant === 'hero'} class:summary-label={variant === 'summary'}>{card.label}</div>
    {#if card.infoText}
      <details class="metric-info">
        <summary
          class="metric-info-btn"
          aria-label={`Explain ${card.label}`}
          title={`Explain ${card.label}`}
        >i</summary>
        <div class="metric-popover" role="note">
          <div class="metric-popover-title">{card.label}</div>
          <p>{card.infoText}</p>
        </div>
      </details>
    {/if}
  </div>
  <div class:hero-value={variant === 'hero'} class:summary-value={variant === 'summary'}>
    {formatValue(card.value, card.kind)}
  </div>
</div>

<style>
  .value-card {
    border: 1px solid #ececec;
    border-radius: 8px;
    padding: 10px 12px;
    background: #fafafa;
    position: relative;
  }

  .metric-card-top {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    align-items: flex-start;
  }

  .hero-label,
  .summary-label {
    font-size: 11px;
    color: #666;
    text-transform: uppercase;
    font-weight: 700;
    margin-bottom: 4px;
  }

  .metric-info {
    position: relative;
    flex: 0 0 auto;
  }

  .metric-info[open] {
    z-index: 5;
  }

  .metric-info-btn {
    list-style: none;
    width: 20px;
    height: 20px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid #d7deea;
    border-radius: 999px;
    background: #fff;
    color: #49617a;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
    user-select: none;
    line-height: 1;
    padding: 0;
  }

  .metric-info-btn::-webkit-details-marker {
    display: none;
  }

  .metric-info-btn:hover {
    background: #f5f9ff;
    border-color: #b8cee9;
  }

  .metric-info[open] .metric-info-btn {
    background: #edf4ff;
    border-color: #99bbe8;
    color: #174a85;
  }

  .metric-popover {
    position: absolute;
    top: calc(100% + 8px);
    right: 0;
    z-index: 10;
    width: min(280px, calc(100vw - 64px));
    padding: 10px 12px;
    border: 1px solid #dbe4f0;
    border-radius: 10px;
    background: #fff;
    box-shadow: 0 10px 28px rgba(30, 41, 59, 0.16);
  }

  .metric-popover-title {
    font-size: 12px;
    font-weight: 700;
    color: #22324a;
    margin-bottom: 6px;
  }

  .metric-popover p {
    margin: 0;
    font-size: 12px;
    line-height: 1.45;
    color: #4a5565;
    text-transform: none;
  }

  .hero-value {
    font-size: 18px;
    font-weight: 700;
    color: #222;
  }

  .summary-value {
    font-size: 14px;
    font-weight: 700;
    color: #222;
  }
</style>
