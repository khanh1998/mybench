// Client-safe param utilities (no server imports)

export function findPlaceholders(text: string): string[] {
	return [...text.matchAll(/\{\{([\w]+)\}\}/g)].map(m => m[1]);
}

export interface ValidationError {
	step: string;
	script: string;
	placeholder: string;
}

export interface DesignLike {
	params?: { name: string }[];
	steps?: {
		name: string;
		type: string;
		script: string;
		pgbench_options?: string;
		pgbench_scripts?: { name: string; script: string }[];
	}[];
}

export function validateDesignParams(design: DesignLike): ValidationError[] {
	const defined = new Set((design.params ?? []).map(p => p.name).filter(Boolean));
	const errors: ValidationError[] = [];
	for (const step of design.steps ?? []) {
		const scripts =
			step.type === 'pgbench'
				? (step.pgbench_scripts ?? []).map(ps => ({ name: ps.name, text: ps.script }))
				: [{ name: step.name, text: step.script }];
		for (const s of scripts) {
			for (const ph of findPlaceholders(s.text)) {
				if (!defined.has(ph)) errors.push({ step: step.name, script: s.name, placeholder: ph });
			}
		}
		if (step.pgbench_options) {
			for (const ph of findPlaceholders(step.pgbench_options)) {
				if (!defined.has(ph)) errors.push({ step: step.name, script: 'options', placeholder: ph });
			}
		}
	}
	return errors;
}
