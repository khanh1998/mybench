import { json } from '@sveltejs/kit';
import getDb from '$lib/server/db';
import type { RequestHandler } from './$types';

const DEFAULT_STEPS = [
	{ position: 0, name: 'Setup', type: 'sql', script: '', pgbench_options: '', enabled: 1 },
	{ position: 1, name: 'Seed Data', type: 'sql', script: '', pgbench_options: '', enabled: 1 },
	{ position: 2, name: 'Post Seed', type: 'sql', script: '', pgbench_options: '', enabled: 1 },
	{ position: 3, name: 'Benchmark', type: 'pgbench', script: '\\set aid random(1, 100000)\nSELECT * FROM pgbench_accounts WHERE aid = :aid;', pgbench_options: '-c 10 -T 60', enabled: 1 },
	{ position: 4, name: 'Teardown', type: 'sql', script: '', pgbench_options: '', enabled: 0 }
];

export const GET: RequestHandler = ({ url }) => {
	const db = getDb();
	const decisionId = url.searchParams.get('decision_id');
	let designs;
	if (decisionId) {
		designs = db.prepare('SELECT * FROM designs WHERE decision_id = ? ORDER BY id').all(Number(decisionId));
	} else {
		designs = db.prepare('SELECT * FROM designs ORDER BY id').all();
	}
	return json(designs);
};

export const POST: RequestHandler = async ({ request }) => {
	const db = getDb();
	const body = await request.json();
	const result = db.prepare(
		'INSERT INTO designs (decision_id, name, description, server_id, database) VALUES (?, ?, ?, ?, ?)'
	).run(body.decision_id, body.name, body.description ?? '', body.server_id ?? null, body.database ?? '');

	const designId = result.lastInsertRowid as number;

	// Insert default steps
	const insertStep = db.prepare(
		'INSERT INTO design_steps (design_id, position, name, type, script, pgbench_options, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)'
	);
	const doInsert = db.transaction(() => {
		for (const s of DEFAULT_STEPS) {
			insertStep.run(designId, s.position, s.name, s.type, s.script, s.pgbench_options, s.enabled);
		}
	});
	doInsert();

	const design = db.prepare('SELECT * FROM designs WHERE id = ?').get(designId);
	return json(design, { status: 201 });
};
