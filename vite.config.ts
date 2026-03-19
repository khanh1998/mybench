import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	resolve: {
		dedupe: ['@codemirror/view', '@codemirror/state']
	},
	optimizeDeps: {
		exclude: ['better-sqlite3'],
		include: [
			'@codemirror/state',
			'@codemirror/view',
			'@codemirror/commands',
			'@codemirror/language',
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
