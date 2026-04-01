import { describe, expect, it } from 'vitest';
import { getRunnablePgbenchScripts, validateDesignParams, validateScriptWeights } from './params';

describe('pgbench script weight helpers', () => {
	it('treats zero-weight scripts as ignored', () => {
		const runnable = getRunnablePgbenchScripts([
			{ name: 'disabled', weight: 0, script: 'SELECT {{IGNORED}};' },
			{ name: 'enabled', weight: 25, script: 'SELECT {{USED}};' },
			{ name: 'defaulted', script: 'SELECT 1;' }
		]);

		expect(runnable.map((script) => script.name)).toEqual(['enabled', 'defaulted']);
	});

	it('ignores zero-weight scripts during placeholder validation', () => {
		const errors = validateDesignParams({
			params: [{ name: 'USED' }],
			steps: [
				{
					name: 'Bench',
					type: 'pgbench',
					script: '',
					pgbench_options: '',
					pgbench_scripts: [
						{ name: 'disabled', weight: 0, script: 'SELECT {{IGNORED}};' },
						{ name: 'enabled', weight: 100, script: 'SELECT {{USED}};' }
					]
				}
			]
		});

		expect(errors).toEqual([]);
	});

	it('only sums active script weights', () => {
		const errors = validateScriptWeights({
			steps: [
				{
					name: 'Bench',
					type: 'pgbench',
					script: '',
					pgbench_scripts: [
						{ name: 'disabled', weight: 0, script: 'SELECT 1;' },
						{ name: 'hot', weight: 80, script: 'SELECT 2;' },
						{ name: 'warm', weight: 30, script: 'SELECT 3;' }
					]
				}
			]
		});

		expect(errors).toEqual([{ step: 'Bench', totalWeight: 110 }]);
	});
});
