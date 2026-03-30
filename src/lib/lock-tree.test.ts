import { describe, it, expect } from 'vitest';
import { buildLockTree, MAX_LOCK_DEPTH, type LockPairRow, type LockNode } from './lock-tree';

// Helper to build a minimal LockPairRow
function pair(blocking: number, blocked: number, locktype = 'relation'): LockPairRow {
  return {
    blocking_pid: blocking, blocking_query: `query-${blocking}`, blocking_state: 'active',
    blocked_pid: blocked,   blocked_query:  `query-${blocked}`,  blocked_state:  'waiting',
    locktype, requested_mode: 'ExclusiveLock', held_mode: 'ExclusiveLock', times_seen: 1,
  };
}

function pids(nodes: LockNode[]): number[] {
  return nodes.map(n => n.pid);
}

describe('buildLockTree', () => {
  it('linear chain A→B→C produces exactly one root (A) with nested children', () => {
    const tree = buildLockTree([pair(1, 2), pair(2, 3)]);

    expect(tree).toHaveLength(1);
    expect(tree[0].pid).toBe(1);
    expect(tree[0].waitInfo).toBeNull();

    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].pid).toBe(2);
    expect(tree[0].children[0].waitInfo).not.toBeNull();

    expect(tree[0].children[0].children).toHaveLength(1);
    expect(tree[0].children[0].children[0].pid).toBe(3);
    expect(tree[0].children[0].children[0].children).toHaveLength(0);
  });

  it('reversed pair order still produces one root', () => {
    // pairs arrive B→C first, then A→B
    const tree = buildLockTree([pair(2, 3), pair(1, 2)]);
    expect(tree).toHaveLength(1);
    expect(tree[0].pid).toBe(1);
    expect(tree[0].children[0].pid).toBe(2);
    expect(tree[0].children[0].children[0].pid).toBe(3);
  });

  it('single pair A→B produces one root with one child', () => {
    const tree = buildLockTree([pair(1, 2)]);
    expect(tree).toHaveLength(1);
    expect(tree[0].pid).toBe(1);
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].pid).toBe(2);
  });

  it('two independent trees A→B and C→D produces two roots', () => {
    const tree = buildLockTree([pair(1, 2), pair(3, 4)]);
    expect(tree).toHaveLength(2);
    expect(pids(tree).sort()).toEqual([1, 3]);
    const a = tree.find(n => n.pid === 1)!;
    const c = tree.find(n => n.pid === 3)!;
    expect(a.children).toHaveLength(1);
    expect(c.children).toHaveLength(1);
  });

  it('fan-out: A blocks B and C produces one root with two children', () => {
    const tree = buildLockTree([pair(1, 2), pair(1, 3)]);
    expect(tree).toHaveLength(1);
    expect(tree[0].pid).toBe(1);
    expect(pids(tree[0].children).sort()).toEqual([2, 3]);
  });

  it('diamond: A→B, A→C, B→D, C→D — D appears under both B and C', () => {
    const tree = buildLockTree([pair(1, 2), pair(1, 3), pair(2, 4), pair(3, 4)]);
    expect(tree).toHaveLength(1);
    expect(tree[0].pid).toBe(1);
    const b = tree[0].children.find(n => n.pid === 2)!;
    const c = tree[0].children.find(n => n.pid === 3)!;
    expect(b.children[0].pid).toBe(4);
    expect(c.children[0].pid).toBe(4);
  });

  it('simple A↔B cycle: fallback produces ONE root (higher out-degree wins), cycle cut at second hop', () => {
    // pair(1,2) = 1 blocked by 2 (2 has out-degree 1)
    // pair(2,1) = 2 blocked by 1 (1 has out-degree 1)
    // Both have equal out-degree so whichever comes first in iteration order wins.
    // Key: only ONE root, and the cycle is cut at depth 2 (cycle leaf has no children).
    const tree = buildLockTree([pair(1, 2), pair(2, 1)]);
    expect(tree).toHaveLength(1);
    const child = tree[0].children[0];
    const cycleLeaf = child.children[0];  // cycle cut here
    expect(cycleLeaf.children).toHaveLength(0);
  });

  it('dense cycle: all block each other — fallback produces ONE root (highest out-degree)', () => {
    // pid 1 blocks 2, 3, 4  (out-degree 3)
    // pid 2 blocks 1         (creates cycle, out-degree 1)
    // pid 3 blocks 1, 2, 4  (out-degree 3, tied with 1)
    const pairs: LockPairRow[] = [
      pair(1, 2), pair(1, 3), pair(1, 4), // 1 blocks 2, 3, 4
      pair(2, 1),                          // 2 blocks 1 (cycle)
      pair(3, 1), pair(3, 2), pair(3, 4), // 3 blocks 1, 2, 4
    ];
    // blockedPids = {2,3,4,1} → all blocked → fallback fires
    // pid 1 and 3 tied at out-degree 3; 1 inserted first → 1 is root[0]
    const tree = buildLockTree(pairs);
    expect(tree[0].pid).toBe(1);
    expect(tree.length).toBeLessThanOrEqual(2);
  });

  it('real-world pgbench pattern: many workers blocked by same few pids — few roots', () => {
    const pairs: LockPairRow[] = [];
    // pid 100 blocks workers 1..20
    for (let w = 1; w <= 20; w++) pairs.push(pair(100, w));
    // pid 101 also blocks workers 1..18
    for (let w = 1; w <= 18; w++) pairs.push(pair(101, w));
    // mutual cycle: 100 ↔ 101
    pairs.push(pair(100, 101)); // 100 blocks 101
    pairs.push(pair(101, 100)); // 101 blocks 100

    // blockedPids = {1..20, 101, 100} = all → fallback fires
    // out-degrees: 100 → 21 (workers 1-20 + 101), 101 → 19 (workers 1-18 + 100)
    const tree = buildLockTree(pairs);
    // pid 100 has highest out-degree → root[0]
    expect(tree[0].pid).toBe(100);
    // 100's subtree covers 101 and all workers → just 1 root
    expect(tree.length).toBe(1);
  });

  it('respects MAX_LOCK_DEPTH cap and flattens deeper nodes', () => {
    // Build chain 1→2→3→...→9 (8 hops, well past MAX_LOCK_DEPTH=5)
    const pairs: LockPairRow[] = [];
    for (let i = 1; i <= 8; i++) pairs.push(pair(i, i + 1));
    const tree = buildLockTree(pairs);

    function depth(node: LockNode): number {
      if (node.children.length === 0) return 0;
      return 1 + Math.max(...node.children.map(depth));
    }
    // depth 5 node flattens all remaining descendants as direct children (+1 level)
    expect(depth(tree[0])).toBe(MAX_LOCK_DEPTH + 1);

    // Find the flattened node at depth MAX_LOCK_DEPTH
    let n = tree[0];
    for (let i = 0; i < MAX_LOCK_DEPTH; i++) n = n.children[0];
    expect(n.flattened).toBe(true);
    // All remaining deeper nodes are flat children (no nesting)
    for (const c of n.children) expect(c.children).toHaveLength(0);
  });

  it('dense fully-connected graph stays within node budget', () => {
    // 30 PIDs all blocking each other — exponential without budget cap
    const pairs: LockPairRow[] = [];
    for (let a = 1; a <= 30; a++)
      for (let b = 1; b <= 30; b++)
        if (a !== b) pairs.push(pair(a, b));

    const tree = buildLockTree(pairs);
    function countNodes(nodes: LockNode[]): number {
      return nodes.reduce((s, n) => s + 1 + countNodes(n.children), 0);
    }
    // Must complete quickly and stay under a reasonable limit
    expect(countNodes(tree)).toBeLessThanOrEqual(500);
  });

  it('empty pairs returns empty tree', () => {
    expect(buildLockTree([])).toEqual([]);
  });

  it('waitInfo is null on root nodes and populated on children', () => {
    const tree = buildLockTree([pair(1, 2, 'tuple')]);
    expect(tree[0].waitInfo).toBeNull();
    expect(tree[0].children[0].waitInfo).toMatchObject({
      locktype: 'tuple',
      requested_mode: 'ExclusiveLock',
      held_mode: 'ExclusiveLock',
    });
  });
});
