// Client-safe param utilities (no server imports)

export function findPlaceholders(text: string): string[] {
	return [...text.matchAll(/\{\{([\w]+)\}\}/g)].map(m => m[1]);
}

export interface ValidationError {
	step: string;
	script: string;
	placeholder: string;
}

export interface WeightError {
	step: string;
	totalWeight: number;
	hasUnresolved?: boolean;
}

export interface DesignLike {
	params?: { name: string }[];
	steps?: {
		name: string;
		type: string;
		script: string;
		pgbench_options?: string;
		perf_duration?: string;
		pgbench_scripts?: { name: string; weight?: number; weight_expr?: string | null; script: string }[];
	}[];
}

export function getRunnablePgbenchScripts<T extends { weight?: number; weight_expr?: string | null }>(scripts: T[]): T[] {
	return scripts.filter((script) => (script.weight_expr != null || (script.weight ?? 1) > 0));
}

/**
 * Resolves the effective integer weight for a script.
 * If weight_expr is set and params are provided, substitutes the expression and parses it.
 * Falls back to the integer weight field.
 */
export function resolveScriptWeight(
	ps: { weight?: number; weight_expr?: string | null },
	params?: { name: string; value: string }[]
): number {
	if (ps.weight_expr && params) {
		let expr = ps.weight_expr;
		for (const p of params) {
			if (p.name) expr = expr.replaceAll(`{{${p.name}}}`, p.value);
		}
		const parsed = parseInt(expr.trim(), 10);
		if (!isNaN(parsed)) return Math.max(0, parsed);
	}
	return ps.weight ?? 1;
}

export function validateScriptWeights(
	design: DesignLike,
	resolvedParams?: { name: string; value: string }[]
): WeightError[] {
	const errors: WeightError[] = [];
	for (const step of design.steps ?? []) {
		if (step.type === 'pgbench' && (step.pgbench_scripts ?? []).length > 0) {
			let total = 0;
			let hasUnresolved = false;
			for (const ps of getRunnablePgbenchScripts(step.pgbench_scripts ?? [])) {
				if (ps.weight_expr && !resolvedParams) {
					hasUnresolved = true;
					continue;
				}
				const w = resolveScriptWeight(ps, resolvedParams);
				if (w > 0) total += w;
			}
			if (total > 100) errors.push({ step: step.name, totalWeight: total, hasUnresolved });
		}
	}
	return errors;
}

export function validateDesignParams(design: DesignLike): ValidationError[] {
	const defined = new Set((design.params ?? []).map(p => p.name).filter(Boolean));
	const errors: ValidationError[] = [];
	for (const step of design.steps ?? []) {
		const scripts =
			step.type === 'pgbench'
				? getRunnablePgbenchScripts(step.pgbench_scripts ?? []).map(ps => ({ name: ps.name, text: ps.script }))
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
		if (step.perf_duration) {
			for (const ph of findPlaceholders(step.perf_duration)) {
				if (!defined.has(ph)) errors.push({ step: step.name, script: 'perf duration', placeholder: ph });
			}
		}
		// Also validate placeholders in weight expressions
		for (const ps of (step.pgbench_scripts ?? [])) {
			if (ps.weight_expr) {
				for (const ph of findPlaceholders(ps.weight_expr)) {
					if (!defined.has(ph)) errors.push({ step: step.name, script: `${ps.name} (weight)`, placeholder: ph });
				}
			}
		}
	}
	return errors;
}
