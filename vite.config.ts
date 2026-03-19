import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	resolve: {
		dedupe: [
			'@codemirror/state',
			'@codemirror/view',
			'@codemirror/language',
			'@codemirror/commands',
			'@codemirror/autocomplete',
			'@codemirror/search',
			'@lezer/common',
			'@lezer/highlight',
			'@lezer/lr'
		]
	},
	optimizeDeps: {
		exclude: ['better-sqlite3'],
		include: [
			'svelte-codemirror-editor',
			'@codemirror/state',
			'@codemirror/view',
			'@codemirror/language',
			'@codemirror/commands',
			'@codemirror/autocomplete',
			'@codemirror/search',
			'@codemirror/lang-sql',
			'@codemirror/theme-one-dark',
			'@lezer/common',
			'@lezer/highlight',
			'@lezer/lr'
		]
	}
});
