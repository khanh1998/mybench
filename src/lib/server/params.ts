import type { DesignParam } from '$lib/types';

export function substituteParams(text: string, params: DesignParam[]): string {
	let result = text;
	for (const p of params) {
		if (!p.name) continue;
		result = result.replaceAll(`{{${p.name}}}`, p.value);
	}
	return result;
}
