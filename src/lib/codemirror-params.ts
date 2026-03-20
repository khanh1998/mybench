import { autocompletion } from '@codemirror/autocomplete';
import { linter, type Diagnostic } from '@codemirror/lint';
import type { Extension } from '@codemirror/state';

export function paramAutocomplete(paramNames: string[]): Extension {
	return autocompletion({
		override: [
			(ctx) => {
				const match = ctx.matchBefore(/\{\{[\w]*/);
				if (!match) return null;
				return {
					from: match.from + 2,
					options: paramNames.map(name => ({
						label: name,
						apply: (view: import('@codemirror/view').EditorView, _completion: unknown, from: number, to: number) => {
							// If }} already exists right after the cursor (auto-inserted by bracket matcher),
							// extend the replacement range to cover them — avoids producing {{NAME}}}}
							const after = view.state.doc.sliceString(to, to + 2);
							const insertTo = after === '}}' ? to + 2 : to;
							view.dispatch({ changes: { from, to: insertTo, insert: name + '}}' } });
						},
						type: 'variable'
					})),
					filter: true
				};
			}
		]
	});
}

export function paramLinter(paramNames: string[]): Extension {
	const nameSet = new Set(paramNames);
	return linter((view) => {
		const diagnostics: Diagnostic[] = [];
		const text = view.state.doc.toString();
		const pattern = /\{\{([\w]+)\}\}/g;
		let match;
		while ((match = pattern.exec(text)) !== null) {
			if (!nameSet.has(match[1])) {
				diagnostics.push({
					from: match.index,
					to: match.index + match[0].length,
					severity: 'error',
					message: `Unknown parameter: ${match[1]}`
				});
			}
		}
		return diagnostics;
	});
}
