export interface LockPairRow {
  blocked_pid: number; blocked_query: string | null; blocked_state: string | null;
  blocking_pid: number; blocking_query: string | null; blocking_state: string | null;
  locktype: string; resource: string; object_key: string;
  requested_mode: string; held_mode: string; times_seen: number;
}

export interface LockWaitInfo {
  locktype: string; resource: string; requested_mode: string; held_mode: string; times_seen: number;
}

export interface LockNode {
  pid: number; query: string; state: string;
  waitInfo: LockWaitInfo | null;
  children: LockNode[];
  /** True when this node's children were flattened from deeper levels. */
  flattened?: boolean;
}

export const MAX_LOCK_DEPTH = 5;
/** Stop expanding the tree after this many nodes to prevent exponential blowup on dense graphs. */
const MAX_TREE_NODES = 500;

type Edge = {
  pid: number;
  locktype: string;
  resource: string;
  object_key: string;
  requested_mode: string;
  held_mode: string;
  times_seen: number;
};

export function buildLockTree(pairs: LockPairRow[]): LockNode[] {
  const pidInfo = new Map<number, { query: string; state: string }>();
  for (const p of pairs) {
    if (!pidInfo.has(p.blocking_pid))
      pidInfo.set(p.blocking_pid, { query: p.blocking_query ?? '(unknown)', state: p.blocking_state ?? '—' });
    if (!pidInfo.has(p.blocked_pid))
      pidInfo.set(p.blocked_pid, { query: p.blocked_query ?? '(unknown)', state: p.blocked_state ?? 'waiting' });
  }

  const edges = new Map<number, Edge[]>();
  for (const p of pairs) {
    if (!edges.has(p.blocking_pid)) edges.set(p.blocking_pid, []);
    const arr = edges.get(p.blocking_pid)!;
    if (!arr.some(e =>
      e.pid === p.blocked_pid &&
      e.locktype === p.locktype &&
      e.object_key === p.object_key &&
      e.requested_mode === p.requested_mode &&
      e.held_mode === p.held_mode
    )) {
      arr.push({
        pid: p.blocked_pid,
        locktype: p.locktype,
        resource: p.resource,
        object_key: p.object_key,
        requested_mode: p.requested_mode,
        held_mode: p.held_mode,
        times_seen: p.times_seen
      });
    }
  }

  let nodeCount = 0;

  function buildNode(pid: number, waitInfo: LockWaitInfo | null, visited: Set<number>, depth: number): LockNode {
    nodeCount++;
    const info = pidInfo.get(pid) ?? { query: '(unknown)', state: '—' };
    const node: LockNode = { pid, query: info.query, state: info.state, waitInfo, children: [] };
    if (visited.has(pid) || nodeCount >= MAX_TREE_NODES) return node;
    const nextVisited = new Set(visited);
    nextVisited.add(pid);

    if (depth >= MAX_LOCK_DEPTH) {
      // Flatten all deeper descendants into one level using BFS
      const queue: { pid: number; edge: Edge }[] = [];
      for (const e of (edges.get(pid) ?? [])) queue.push({ pid: e.pid, edge: e });
      const seen = new Set(nextVisited);
      while (queue.length > 0 && nodeCount < MAX_TREE_NODES) {
        const { pid: cPid, edge } = queue.shift()!;
        if (seen.has(cPid)) continue;
        seen.add(cPid);
        nodeCount++;
        const cInfo = pidInfo.get(cPid) ?? { query: '(unknown)', state: '—' };
        node.children.push({
          pid: cPid,
          query: cInfo.query,
          state: cInfo.state,
          waitInfo: {
            locktype: edge.locktype,
            resource: edge.resource,
            requested_mode: edge.requested_mode,
            held_mode: edge.held_mode,
            times_seen: edge.times_seen
          },
          children: []
        });
        for (const e of (edges.get(cPid) ?? [])) {
          if (!seen.has(e.pid)) queue.push({ pid: e.pid, edge: e });
        }
      }
      if (node.children.length > 0) node.flattened = true;
      return node;
    }

    for (const edge of (edges.get(pid) ?? [])) {
      if (nodeCount >= MAX_TREE_NODES) break;
      node.children.push(buildNode(edge.pid,
        {
          locktype: edge.locktype,
          resource: edge.resource,
          requested_mode: edge.requested_mode,
          held_mode: edge.held_mode,
          times_seen: edge.times_seen
        },
        nextVisited, depth + 1));
    }
    return node;
  }

  const blockedPids = new Set(pairs.map(p => p.blocked_pid));
  const rootPids = [...pidInfo.keys()].filter(pid => !blockedPids.has(pid));
  if (rootPids.length > 0) {
    return rootPids.map(pid => {
      if (nodeCount >= MAX_TREE_NODES) return null;
      return buildNode(pid, null, new Set(), 0);
    }).filter((n): n is LockNode => n !== null);
  }

  // Fallback: full cycle — no pure root exists (every blocker is also blocked).
  // Build roots greedily by descending out-degree so that the most impactful
  // blocker comes first. Once a PID appears in a root's subtree, skip it as
  // a candidate root to avoid showing the same node as multiple roots.
  function collectPids(node: LockNode, seen: Set<number>): void {
    seen.add(node.pid);
    for (const c of node.children) collectPids(c, seen);
  }

  const byOutDegree = [...pidInfo.keys()]
    .sort((a, b) => (edges.get(b)?.length ?? 0) - (edges.get(a)?.length ?? 0));

  const covered = new Set<number>();
  const fallbackRoots: LockNode[] = [];
  for (const pid of byOutDegree) {
    if (covered.has(pid) || nodeCount >= MAX_TREE_NODES) continue;
    const node = buildNode(pid, null, new Set(), 0);
    collectPids(node, covered);
    fallbackRoots.push(node);
  }
  return fallbackRoots;
}
