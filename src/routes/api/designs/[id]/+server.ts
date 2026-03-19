import { json, error } from '@sveltejs/kit';
import getDb from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params }) => {
	const db = getDb();
	const design = db.prepare('SELECT * FROM designs WHERE id = ?').get(Number(params.id));
	if (!design) throw error(404, 'Not found');
	const steps = db.prepare('SELECT * FROM design_steps WHERE design_id = ? ORDER BY position').all(Number(params.id));
	return json({ ...design as object, steps });
};

export const PUT: RequestHandler = async ({ params, request }) => {
	const db = getDb();
	const body = await request.json();
	db.prepare(
		'UPDATE designs SET name=?, description=?, server_id=?, database=? WHERE id=?'
	).run(body.name, body.description ?? '', body.server_id ?? null, body.database ?? '', Number(params.id));

	if (body.steps) {
		const upsert = db.prepare(
			`INSERT INTO design_steps (id, design_id, position, name, type, script, pgbench_options, enabled)
       VALUES (@id, @design_id, @position, @name, @type, @script, @pgbench_options, @enabled)
       ON CONFLICT(id) DO UPDATE SET
         position=excluded.position, name=excluded.name, type=excluded.type,
         script=excluded.script, pgbench_options=excluded.pgbench_options, enabled=excluded.enabled`
		);
		const doUpsert = db.transaction(() => {
			for (const s of body.steps) {
				upsert.run({ ...s, design_id: Number(params.id) });
			}
		});
		doUpsert();
	}

	const design = db.prepare('SELECT * FROM designs WHERE id = ?').get(Number(params.id));
	const steps = db.prepare('SELECT * FROM design_steps WHERE design_id = ? ORDER BY position').all(Number(params.id));
	return json({ ...design as object, steps });
};

export const DELETE: RequestHandler = ({ params }) => {
	const db = getDb();
	db.prepare('DELETE FROM designs WHERE id = ?').run(Number(params.id));
	return json({ ok: true });
};
