<script lang="ts">
  let { value = $bindable(10), idPrefix = 'runner-interval' }: { value: number; idPrefix?: string } = $props();
</script>

<details class="form-group">
  <summary style="cursor:pointer; font-size:12px; color:#888">Advanced</summary>
  <div style="margin-top:8px">
    <label for="{idPrefix}">Runner metrics interval (seconds)</label>
    <input id={idPrefix} type="number" bind:value min="1" max="300" />
    <p style="font-size:12px; color:#888; margin:4px 0 0">
      How often the runner (client) host is sampled. Independent of the DB snapshot interval. Only used when the design has a proc step with runner collection on.
    </p>
  </div>
</details>
