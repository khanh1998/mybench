<script lang="ts">
  import { enhance } from '$app/forms';
  import type { ActionData } from './$types';

  let { form }: { form: ActionData } = $props();
</script>

<div class="login-wrap">
  <div class="login-box">
    <h1>mybench</h1>
    <form method="POST" use:enhance>
      <input
        type="password"
        name="password"
        placeholder="Password"
        autofocus
        autocomplete="current-password"
      />
      {#if form?.error}
        <p class="error">{form.error}</p>
      {/if}
      <button type="submit">Sign in</button>
    </form>
  </div>
</div>

<style>
  .login-wrap {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    background: #0f0f0f;
  }

  .login-box {
    width: 320px;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  h1 {
    font-size: 1.4rem;
    font-weight: 600;
    color: #e0e0e0;
    margin: 0;
    text-align: center;
    letter-spacing: 0.05em;
  }

  form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  input {
    width: 100%;
    padding: 0.6rem 0.75rem;
    background: #1a1a1a;
    border: 1px solid #333;
    border-radius: 6px;
    color: #e0e0e0;
    font-size: 0.95rem;
    box-sizing: border-box;
  }

  input:focus {
    outline: none;
    border-color: #555;
  }

  button {
    padding: 0.6rem;
    background: #2a2a2a;
    border: 1px solid #444;
    border-radius: 6px;
    color: #e0e0e0;
    font-size: 0.95rem;
    cursor: pointer;
  }

  button:hover {
    background: #333;
  }

  .error {
    color: #e05555;
    font-size: 0.85rem;
    margin: 0;
    text-align: center;
  }
</style>
