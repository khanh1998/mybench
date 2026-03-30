export interface LockPairRow {
  blocked_pid: number; blocked_query: string | null; blocked_state: string | null;
  blocking_pid: number; blocking_query: string | null; blocking_state: string | null;
  locktype: string; requested_mode: string; held_mode: string; times_seen: number;
}

export interface LockWaitInfo {
  locktype: string; requested_mode: string; held_mode: string; times_seen: number;
}

export interface LockNode {
  pid: number; query: string; state: string;
  waitInfo: LockWaitInfo | null;
  children: LockNode[];
}

export const MAX_LOCK_DEPTH = 10;

type Edge = { pid: number; locktype: string; requested_mode: string; held_mode: string; times_seen: number };

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
    if (!arr.some(e => e.pid === p.blocked_pid && e.locktype === p.locktype))
      arr.push({ pid: p.blocked_pid, locktype: p.locktype, requested_mode: p.requested_mode, held_mode: p.held_mode, times_seen: p.times_seen });
  }

  function buildNode(pid: number, waitInfo: LockWaitInfo | null, visited: Set<number>, depth: number): LockNode {
    const info = pidInfo.get(pid) ?? { query: '(unknown)', state: '—' };
    const node: LockNode = { pid, query: info.query, state: info.state, waitInfo, children: [] };
    if (depth >= MAX_LOCK_DEPTH || visited.has(pid)) return node;
    const nextVisited = new Set(visited);
    nextVisited.add(pid);
    for (const edge of (edges.get(pid) ?? [])) {
      node.children.push(buildNode(edge.pid,
        { locktype: edge.locktype, requested_mode: edge.requested_mode, held_mode: edge.held_mode, times_seen: edge.times_seen },
        nextVisited, depth + 1));
    }
    return node;
  }

  const blockedPids = new Set(pairs.map(p => p.blocked_pid));
  const rootPids = [...pidInfo.keys()].filter(pid => !blockedPids.has(pid));
  if (rootPids.length > 0) {
    return rootPids.map(pid => buildNode(pid, null, new Set(), 0));
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
    if (covered.has(pid)) continue;
    const node = buildNode(pid, null, new Set(), 0);
    collectPids(node, covered);
    fallbackRoots.push(node);
  }
  return fallbackRoots;
}
