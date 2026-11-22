// sokoban-solver-01: a push-optimal Sokoban solver for make.fun's generated levels.
//
// A level is a hallway with small rooms off it, and each room's boxes belong to that room's goals alone, so the
// level's push optimum is the sum of its rooms' optima. This solver finds the rooms (the parts of the floor cut off
// from the player once the dead squares of the player's row are removed), then solves each room in turn with an A*
// search over pushes: a state is the boxes' squares plus the player's reachable region, a step is one push, and the
// estimate is a minimum-cost assignment of boxes to goals over precomputed push distances, which never overstates
// the pushes still needed, so the first solution the search settles is push-optimal. Dead squares (a box there can
// reach no goal), frozen 2 x 2 blocks and boxes frozen against walls prune states no push can save. When a level
// does not split into rooms the
// same search runs on the whole board. Everything is decided by work done, never by the clock, and every tie breaks
// by square and direction order, so two runs write the same bytes.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The four directions: [dx, dy, the walk letter, the push letter]. */
const DIRS: [number, number, string, string][] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

/** States one push search may create before it gives up: a budget of work, never of time. */
const STATE_CAP = 2_000_000;

interface Board {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

/** A level in XSB text: width, height, walls (short rows and the outer frame padded as walls), goals, boxes, player. */
function parseLevel(text: string): Board {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/**
 * Push distances: dist[g][s] is the fewest pushes that bring a box from square s to goal g with the other boxes
 * ignored (a reverse breadth-first search over pushes from the goal), or -1 when no push sequence does. A square
 * with a finite distance to some goal is live; a box on any other square can never be solved.
 */
function pushDistances(board: Board): { dist: Int32Array[]; live: Uint8Array } {
  const { w, wall, goals } = board;
  const size = wall.length;
  const live = new Uint8Array(size);
  const dist: Int32Array[] = [];
  for (const g of goals) {
    const d = new Int32Array(size).fill(-1);
    d[g] = 0;
    live[g] = 1;
    const queue = [g];
    for (let qi = 0; qi < queue.length; qi++) {
      const x = queue[qi];
      for (const [dx, dy] of DIRS) {
        const step = dy * w + dx;
        const y = x - step;
        const stand = y - step;
        if (y < 0 || stand < 0 || wall[y] || wall[stand] || d[y] >= 0) continue;
        d[y] = d[x] + 1;
        live[y] = 1;
        queue.push(y);
      }
    }
    dist.push(d);
  }
  return { dist, live };
}

const BIG = 1_000_000;

/** The cost of a cheapest assignment of rows to columns (the Hungarian method); costs are finite, BIG stands for never. */
function assignmentCost(cost: number[][]): number {
  const n = cost.length;
  if (n === 0) return 0;
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(n + 1).fill(0);
  const p = new Array<number>(n + 1).fill(0);
  const way = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(n + 1).fill(Infinity);
    const used = new Array<boolean>(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }
  let total = 0;
  for (let j = 1; j <= n; j++) {
    if (p[j] > 0) total += cost[p[j] - 1][j - 1];
  }
  return total;
}

/** Flood fill from `from` over open squares: marks them with `stamp` in `seen` and returns the region's lowest square. */
function flood(
  board: Board,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { w, wall } = board;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    const qs = [p - w, p + w, p - 1, p + 1];
    for (const q of qs) {
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** Whether the box just pushed to `t` sits in a frozen 2 x 2 block of walls and boxes with a box off its goal. */
function frozenBlock(board: Board, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = board;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/**
 * Whether some box can never move again and is off its goal. A box hemmed in on one horizontal side and one vertical
 * side by walls or by boxes already known frozen can never move: along each axis one side is the square a push would
 * enter and the other is the square the player would stand on, and a blocker on either side closes both directions.
 * Frozen boxes are blockers themselves, so the test runs to a fixpoint; the earliest frozen box to move would need a
 * blocker to move first, so none of them ever moves, and a frozen box off its goal makes the state a deadlock.
 */
function hasFrozenBox(board: Board, occupied: Uint8Array, goal: Uint8Array): boolean {
  const { w, wall } = board;
  const frozen = new Uint8Array(wall.length);
  const blocker = (q: number): boolean => wall[q] === 1 || (occupied[q] === 1 && frozen[q] === 1);
  let changed = true;
  while (changed) {
    changed = false;
    for (let s = 0; s < wall.length; s++) {
      if (!occupied[s] || frozen[s]) continue;
      const across = blocker(s - 1) || blocker(s + 1);
      const along = blocker(s - w) || blocker(s + w);
      if (across && along) {
        frozen[s] = 1;
        changed = true;
      }
    }
  }
  for (let s = 0; s < wall.length; s++) {
    if (occupied[s] && frozen[s] && !goal[s]) return true;
  }
  return false;
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters (the first direction first on ties). */
function walkTo(board: Board, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = board;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

interface Solution {
  pushes: number;
  moves: string;
}

/**
 * The push-optimal solution of one board (a room, or a whole level that does not split) by A* over pushes, or null
 * when the state budget runs out or the board cannot be solved. The estimate is the assignment of the boxes to the
 * goals over the push distances; one push moves one box by one square, so the estimate never overstates what is
 * left, and the first solved state settled is push-optimal.
 */
function solvePush(board: Board, cap: number): Solution | null {
  const { w, wall, goals } = board;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const { dist, live } = pushDistances(board);
  if (board.boxes.some((b) => !live[b])) return null;
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);
  if (solved(board.boxes)) return { pushes: 0, moves: '' };

  const estimate = (boxes: number[]): number => {
    const cost = boxes.map((b) => goals.map((_, gi) => (dist[gi][b] < 0 ? BIG : dist[gi][b])));
    return assignmentCost(cost);
  };

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const keyOf = (boxes: number[], low: number): string => String.fromCharCode(low, ...boxes);

  // The states in the order made: their boxes, the square the player stands on, the state that made them, their pushes.
  const sBoxes: number[][] = [board.boxes];
  const sPlayer: number[] = [board.player];
  const sParent: number[] = [-1];
  const sG: number[] = [0];
  const best = new Map<string, number>();
  for (const b of board.boxes) occupied[b] = 1;
  const startLow = flood(board, occupied, board.player, seen, ++stamp, stack);
  for (const b of board.boxes) occupied[b] = 0;
  best.set(keyOf(board.boxes, startLow), 0);

  // The open list: a heap on (pushes + estimate, estimate, order made), so ties settle the same way on every run.
  const heap: [number, number, number, number][] = [];
  let order = 0;
  const less = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i], heap[p])) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number] => {
    const top = heap[0];
    const last = heap.pop() as [number, number, number, number];
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1], heap[c])) c++;
        if (!less(heap[c], heap[i])) break;
        [heap[i], heap[c]] = [heap[c], heap[i]];
        i = c;
      }
    }
    return top;
  };
  const h0 = estimate(board.boxes);
  if (h0 >= BIG) return null;
  heapPush([h0, h0, order++, 0]);

  let found = -1;
  while (heap.length > 0) {
    const [, , , s] = heapPop();
    const boxes = sBoxes[s];
    const g = sG[s];
    for (const b of boxes) occupied[b] = 1;
    const low = flood(board, occupied, sPlayer[s], seen, ++stamp, stack);
    if (best.get(keyOf(boxes, low)) !== g) {
      for (const b of boxes) occupied[b] = 0;
      continue;
    }
    if (solved(boxes)) {
      found = s;
      for (const b of boxes) occupied[b] = 0;
      break;
    }
    const here = stamp;
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi];
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(board, occupied, goal, t) || hasFrozenBox(board, occupied, goal);
        let child = -1;
        if (!frozen) {
          const next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          const childLow = flood(board, occupied, b, mark, ++stamp, stack);
          const key = keyOf(next, childLow);
          const known = best.get(key);
          if (known === undefined || g + 1 < known) {
            const h = estimate(next);
            if (h < BIG) {
              best.set(key, g + 1);
              child = sBoxes.length;
              sBoxes.push(next);
              sPlayer.push(b);
              sParent.push(s);
              sG.push(g + 1);
              heapPush([g + 1 + h, h, order++, child]);
            }
          }
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (sBoxes.length >= cap) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  if (found < 0) return null;

  // The path of states, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = sParent[s]) path.push(s);
  path.reverse();
  let moves = '';
  let player = board.player;
  let boxes = board.boxes;
  for (const s of path) {
    const nextBoxes = sBoxes[s];
    const from = boxes.find((b) => !nextBoxes.includes(b)) as number;
    const to = nextBoxes.find((b) => !boxes.includes(b)) as number;
    const d = to - from;
    const dir = DIRS.find(([dx, dy]) => dy * w + dx === d) as [number, number, string, string];
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(board, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += dir[3];
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway: a box there reaches no goal) out of the
 * floor, and each part left that holds a box is a room, its squares, boxes and goals. Null when some part holds more
 * or fewer boxes than goals, or a box starts in the hallway: then the level is no set of rooms.
 */
function roomsOf(level: Board): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const { live } = pushDistances(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i] + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) rooms[part[b]].boxes.push(b);
  for (const g of goals) {
    if (part[g] >= 0) rooms[part[g]].goals.push(g);
  }
  if (goals.some((g) => part[g] < 0) || rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** The square the player stands on after `moves` (LURD, the case aside) from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) {
    p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  }
  return p;
}

/**
 * A level solved room by room: each room's push-optimal solution in turn, the other rooms' boxes standing as walls
 * where they stand (on their goals once their room is done), the player walking on from where the last room left it.
 * A box never leaves its room (a push through a door lands it in the hallway, where it reaches no goal), so the
 * rooms' optima add up to the level's. A level that is no set of rooms, or whose room search gives up, falls back to
 * the same search over the whole board; a level that still gives up is answered with no moves.
 */
function solveLevel(level: Board): string {
  const rooms = roomsOf(level);
  if (rooms === null) {
    const whole = solvePush(level, STATE_CAP);
    return whole === null ? '' : whole.moves;
  }
  let player = level.player;
  let moves = '';
  const standing = new Set(level.boxes);
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const b of standing) {
      if (!room.boxes.includes(b)) wall[b] = 1;
    }
    const sub: Board = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solvedRoom = solvePush(sub, STATE_CAP);
    if (solvedRoom === null) {
      const whole = solvePush(level, STATE_CAP);
      return whole === null ? '' : whole.moves;
    }
    moves += solvedRoom.moves;
    player = endOf(level.w, player, solvedRoom.moves);
    for (const b of room.boxes) standing.delete(b);
    for (const g of room.goals) standing.add(g);
  }
  return moves;
}

/** The moves for a level in XSB: a string of u, d, l and r (an upper letter marks a push; case is not checked). */
const solve = (levelText: string): string => solveLevel(parseLevel(levelText));

for (const id of readdirSync(I).sort()) {
  const moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
