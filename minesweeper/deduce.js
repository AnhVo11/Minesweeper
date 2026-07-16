/* ==================================================================
   deduce.js — the single source of truth for logical deduction.

   The live assistant is built in layers, each strictly stronger than the last,
   and each only runs when the cheaper one below it has stalled:

     0. confirmFlags — proof by contradiction on the player's own flags.
     1. basicPass    — the two counting rules every player uses.
     2. smartPass    — set-difference between overlapping numbers (1-2-1).
     3. exactPass    — enumerate every legal mine arrangement and keep only what
                       is true in all of them. This is certainty, not pattern
                       matching: it finds everything short of a real 50/50.

   The assistant reasons ONLY from revealed numbers and flags it has proved
   itself. Manual flags carry no proof, so it never builds on one until
   confirmFlags earns it.
   ================================================================== */

export const neighborsOf = (i, rows, cols) => {
  const r = Math.floor(i / cols);
  const c = i % cols;
  const out = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = r + dr;
      const nc = c + dc;
      if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) out.push(nr * cols + nc);
    }
  }
  return out;
};

/* Enumeration is 2^n in the worst case, so it needs a leash.
   FULL_CAP   — a whole frontier component small enough to solve outright,
                which also unlocks global mine counting.
   WINDOW_CAP — the local pocket size when the frontier is too big for that,
                which on a real board is nearly always.                        */
const FULL_CAP = 22;
const WINDOW_CAP = 18;
const STEP_CAP = 120000;

/**
 * Enumerate every legal mine arrangement over a set of cells and constraints.
 *
 * Returns a Map: mines-in-this-set -> { solutions, mineCount[] }, where
 * mineCount[j] counts how many of those arrangements put a mine on cell j.
 * mineCount === solutions means "a mine in every arrangement". mineCount === 0
 * means "safe in every arrangement".
 *
 * Keyed by total because the global mine count can later rule out entire totals.
 * Returns null if it blows the step budget.
 */
function enumerate(cells, constraints) {
  const k = cells.length;
  const pos = new Map(cells.map((c, i) => [c, i]));

  const cs = constraints.map((c) => ({ idx: c.cells.map((x) => pos.get(x)), n: c.n }));
  const byCell = Array.from({ length: k }, () => []);
  cs.forEach((c, ci) => c.idx.forEach((i) => byCell[i].push(ci)));

  const assign = new Int8Array(k);
  const mines = new Int32Array(cs.length);
  const seen = new Int32Array(cs.length);

  const byTotal = new Map();
  let steps = 0;
  let overflow = false;

  // Still satisfiable: hasn't overshot, and can still reach its count.
  const alive = (ci) => {
    const left = cs[ci].idx.length - seen[ci];
    return mines[ci] <= cs[ci].n && mines[ci] + left >= cs[ci].n;
  };

  const rec = (i, total) => {
    if (overflow) return;
    if (++steps > STEP_CAP) { overflow = true; return; }

    if (i === k) {
      for (let ci = 0; ci < cs.length; ci++) if (mines[ci] !== cs[ci].n) return;
      let e = byTotal.get(total);
      if (!e) { e = { solutions: 0, mineCount: new Int32Array(k) }; byTotal.set(total, e); }
      e.solutions++;
      for (let j = 0; j < k; j++) if (assign[j]) e.mineCount[j]++;
      return;
    }

    for (let v = 0; v <= 1; v++) {
      assign[i] = v;
      for (const ci of byCell[i]) { seen[ci]++; if (v) mines[ci]++; }

      let ok = true;
      for (const ci of byCell[i]) if (!alive(ci)) { ok = false; break; }
      if (ok) rec(i + 1, total + v);

      for (const ci of byCell[i]) { seen[ci]--; if (v) mines[ci]--; }
      assign[i] = 0;
    }
  };

  rec(0, 0);
  return overflow ? null : byTotal;
}

/** Cells that are a mine in every arrangement, and cells that are safe in every one. */
function certainties(cells, byTotal, totals) {
  const k = cells.length;
  const alwaysMine = new Array(k).fill(true);
  const alwaysSafe = new Array(k).fill(true);

  for (const t of totals) {
    const e = byTotal.get(t);
    if (!e) continue;
    for (let j = 0; j < k; j++) {
      if (e.mineCount[j] !== e.solutions) alwaysMine[j] = false;
      if (e.mineCount[j] !== 0) alwaysSafe[j] = false;
    }
  }
  return { alwaysMine, alwaysSafe };
}

/**
 * The live assistant.
 *
 * @param sweep      may it open squares, or only flag?
 * @param smart      may it use set-difference and exact enumeration?
 * @param totalMines the board's mine count — without it, no global counting.
 */
export function applyAssist(board, rows, cols, sweep = true, smart = false, totalMines = null, record = false) {
  let next = board;
  let flagsAdded = 0;
  let opened = 0;
const steps = [];
  const clone = () => { if (next === board) next = board.map((c) => ({ ...c })); };
  const proven = (i) => next[i].flagged && next[i].auto;

  const flagMine = (i) => {
    if (proven(i) || next[i].revealed) return false;
    clone();
    next[i] = { ...next[i], flagged: true, auto: true };
    flagsAdded++;
    if (record) steps.push({ t: "flag", i });
    return true;
  };

  const open = (start) => {
    if (next[start].revealed || next[start].mine || proven(start)) return false;
    clone();
    const stack = [start];
    let did = false;
    while (stack.length) {
      const i = stack.pop();
      const c = next[i];
      if (c.revealed || c.mine || proven(i)) continue; // c.mine: it can never detonate
      c.revealed = true;
      c.flagged = false;
      opened++;
      if (record) steps.push({ t: "open", i });
      did = true;
      if (c.adj === 0) {
        neighborsOf(i, rows, cols).forEach((n) => {
          if (!next[n].revealed && !proven(n)) stack.push(n);
        });
      }
    }
    return did;
  };

  /** "n mines hide among these squares" — one revealed number's worth of truth. */
  const constraintAt = (i) => {
    const cell = next[i];
    if (!cell.revealed || cell.mine || cell.adj === 0) return null;
    const ns = neighborsOf(i, rows, cols);
    const set = ns.filter((n) => !next[n].revealed && !proven(n));
    if (set.length === 0) return null;
    const found = ns.filter((n) => proven(n)).length;
    return { at: i, set, n: cell.adj - found };
  };

  const allConstraints = () => {
    const out = [];
    for (let i = 0; i < next.length; i++) {
      const c = constraintAt(i);
      if (c) out.push(c);
    }
    return out;
  };

  /* ---------- Layer 0: earn the player's flags ----------
     A manual flag carries no proof. This gives it one: assume the square is NOT
     a mine and propagate the numbers. If some number ends up needing more mines
     than it has squares left, the assumption was impossible — the square must be
     a mine, and the flag becomes as trustworthy as one the assistant planted.

     Only the confirming direction is ever tested. If a flag is wrong, that is
     the player's mistake to find; we never volunteer it.                       */
  const contradicts = (cell) => {
    const state = new Int8Array(next.length).fill(-1); // -1 unknown, 0 safe, 1 mine
    for (let i = 0; i < next.length; i++) {
      if (next[i].revealed) state[i] = 0;
      else if (proven(i)) state[i] = 1;
    }
    state[cell] = 0; // the assumption: this square is safe

    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < next.length; i++) {
        const c = next[i];
        if (!c.revealed || c.mine || c.adj === 0) continue;

        const ns = neighborsOf(i, rows, cols);
        let mines = 0;
        const unknown = [];
        for (const x of ns) {
          if (state[x] === 1) mines++;
          else if (state[x] === -1) unknown.push(x);
        }

        if (mines > c.adj) return true;                   // too many mines
        if (mines + unknown.length < c.adj) return true;  // not enough squares left
        if (unknown.length === 0) continue;

        if (mines === c.adj) {
          unknown.forEach((x) => { state[x] = 0; });
          changed = true;
        } else if (mines + unknown.length === c.adj) {
          unknown.forEach((x) => { state[x] = 1; });
          changed = true;
        }
      }
    }
    return false;
  };

  const confirmFlags = () => {
    let changed = false;
    for (let i = 0; i < next.length; i++) {
      const c = next[i];
      if (!c.flagged || c.auto || c.revealed) continue;
      if (contradicts(i)) {
        clone();
        next[i] = { ...next[i], auto: true, confirmed: true };
        changed = true;
      }
    }
    return changed;
  };

  /* ---------- Layer 1: the two counting rules ---------- */
  const basicPass = () => {
    let changed = false;
    for (const c of allConstraints()) {
      if (c.n === c.set.length) c.set.forEach((x) => { if (flagMine(x)) changed = true; });
      else if (sweep && c.n === 0) c.set.forEach((x) => { if (open(x)) changed = true; });
    }
    return changed;
  };

  /* ---------- Layer 2: set difference ----------
     SUBTRACTION — if P's squares sit inside Q's, then (Q \ P) holds (Q.n - P.n)
     mines: a constraint matching no number on the board, which is what lets
     deductions chain.
     DIFFERENCE — if Q.n - P.n equals |Q \ P|, every square in Q \ P is a mine and
     every square in P \ Q is safe.                                              */
  const smartPass = () => {
    const pool = [];
    const seenKeys = new Set();
    const keyOf = (s) => s.slice().sort((a, b) => a - b).join(",");

    const add = (set, n) => {
      if (set.length === 0 || n < 0 || n > set.length) return false;
      const k = keyOf(set);
      if (seenKeys.has(k)) return false;
      seenKeys.add(k);
      pool.push({ set, n });
      return true;
    };

    allConstraints().forEach((c) => add(c.set, c.n));

    const CAP = 700;
    for (let round = 0; round < 3 && pool.length < CAP; round++) {
      const snap = pool.slice();
      let grew = false;
      for (let a = 0; a < snap.length && pool.length < CAP; a++) {
        for (let b = 0; b < snap.length && pool.length < CAP; b++) {
          const P = snap[a];
          const Q = snap[b];
          if (P === Q || P.set.length >= Q.set.length) continue;
          if (!P.set.every((x) => Q.set.includes(x))) continue;
          if (add(Q.set.filter((x) => !P.set.includes(x)), Q.n - P.n)) grew = true;
        }
      }
      if (!grew) break;
    }

    for (const c of pool) {
      let changed = false;
      if (c.n === c.set.length) c.set.forEach((x) => { if (flagMine(x)) changed = true; });
      else if (sweep && c.n === 0) c.set.forEach((x) => { if (open(x)) changed = true; });
      if (changed) return true; // board moved; every cached constraint is stale
    }

    for (const P of pool) {
      for (const Q of pool) {
        if (P === Q) continue;
        const onlyQ = Q.set.filter((x) => !P.set.includes(x));
        if (onlyQ.length === 0 || Q.n - P.n !== onlyQ.length) continue;

        let changed = false;
        onlyQ.forEach((x) => { if (flagMine(x)) changed = true; });
        if (sweep) P.set.filter((x) => !Q.set.includes(x)).forEach((x) => { if (open(x)) changed = true; });
        if (changed) return true;
      }
    }
    return false;
  };

  const applyCertainties = (cells, alwaysMine, alwaysSafe) => {
    let changed = false;
    for (let j = 0; j < cells.length; j++) {
      if (alwaysMine[j]) { if (flagMine(cells[j])) changed = true; }
      else if (alwaysSafe[j] && sweep) { if (open(cells[j])) changed = true; }
    }
    return changed;
  };

  /* ---------- Layer 3a: whole frontier, with global mine counting ----------
     Only possible when every component is small. When it is, feeding in the mine
     count buys two extra deductions for free:

       • if every surviving arrangement leaves 0 mines for the "outside" — the
         unknown squares no number touches — the entire outside is safe;
       • if it leaves exactly as many mines as there are outside squares, every
         one of them is a mine.                                                  */
  const fullPass = () => {
    const cons = allConstraints();
    if (cons.length === 0) return false;

    const frontier = new Set();
    cons.forEach((c) => c.set.forEach((x) => frontier.add(x)));

    const parent = new Map();
    const find = (x) => {
      while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); }
      return x;
    };
    frontier.forEach((x) => parent.set(x, x));
    cons.forEach((c) => {
      const root = find(c.set[0]);
      c.set.forEach((x) => { const r = find(x); if (r !== root) parent.set(r, root); });
    });

    const comps = new Map();
    frontier.forEach((x) => {
      const r = find(x);
      if (!comps.has(r)) comps.set(r, { cells: [], cons: [] });
      comps.get(r).cells.push(x);
    });
    cons.forEach((c) => comps.get(find(c.set[0])).cons.push({ cells: c.set, n: c.n }));

    const parts = [];
    for (const comp of comps.values()) {
      if (comp.cells.length > FULL_CAP) return false; // too big — the window pass handles it
      const byTotal = enumerate(comp.cells, comp.cons);
      if (!byTotal || byTotal.size === 0) return false;
      parts.push({ cells: comp.cells, byTotal, totals: new Set(byTotal.keys()) });
    }
    if (parts.length === 0) return false;

    /* --- global mine counting --- */
    const outside = [];
    let provenFlags = 0;
    for (let i = 0; i < next.length; i++) {
      if (proven(i)) { provenFlags++; continue; }
      if (!next[i].revealed && !frontier.has(i)) outside.push(i);
    }
    const minesLeft = totalMines == null ? null : totalMines - provenFlags;

    if (minesLeft != null && minesLeft >= 0) {
      const fits = (T) => minesLeft - T >= 0 && minesLeft - T <= outside.length;
      const sums = (list) => {
        let acc = new Set([0]);
        for (const s of list) {
          const nx = new Set();
          acc.forEach((a) => s.forEach((b) => nx.add(a + b)));
          acc = nx;
        }
        return acc;
      };

      // Drop any component total no combination of the others can support.
      for (let i = 0; i < parts.length; i++) {
        const others = sums(parts.filter((_, j) => j !== i).map((p) => p.totals));
        const keep = new Set();
        parts[i].totals.forEach((t) => {
          for (const s of others) if (fits(t + s)) { keep.add(t); break; }
        });
        parts[i].totals = keep;
      }

      const outsideCounts = new Set();
      sums(parts.map((p) => p.totals)).forEach((T) => { if (fits(T)) outsideCounts.add(minesLeft - T); });

      if (outsideCounts.size === 1 && outside.length > 0) {
        const m = [...outsideCounts][0];
        let changed = false;
        if (m === 0 && sweep) outside.forEach((x) => { if (open(x)) changed = true; });
        else if (m === outside.length) outside.forEach((x) => { if (flagMine(x)) changed = true; });
        if (changed) return true;
      }
    }

    let changed = false;
    for (const p of parts) {
      const { alwaysMine, alwaysSafe } = certainties(p.cells, p.byTotal, [...p.totals]);
      if (applyCertainties(p.cells, alwaysMine, alwaysSafe)) changed = true;
    }
    return changed;
  };

  /* ---------- Layer 3b: local windows ----------
     On a real board the frontier is one long connected blob — far too wide to
     enumerate whole. So don't. Grab a number, pull in its overlapping neighbours
     until the pocket hits a cell budget, and brute-force just that.

     This is still sound. Dropping constraints only ever ADDS possible
     arrangements, so anything true across all of them stays true across the
     full board. It's weaker than the whole-frontier pass, never wrong.

     Three numbers whose sets overlap — a 1 above, a 1 beside, a 3 in the corner —
     land in one window together, and their combined force falls straight out.   */
  const windowPass = () => {
    const cons = allConstraints();
    if (cons.length < 2) return false;

    const cellToCons = new Map();
    cons.forEach((c, ci) => c.set.forEach((x) => {
      if (!cellToCons.has(x)) cellToCons.set(x, []);
      cellToCons.get(x).push(ci);
    }));

    const tried = new Set();

    for (let seed = 0; seed < cons.length; seed++) {
      const inWindow = new Set([seed]);
      const cellSet = new Set(cons[seed].set);
      const queue = [seed];

      // Grow outward through shared cells, refusing anything that overflows the budget.
      while (queue.length) {
        const ci = queue.shift();
        for (const x of cons[ci].set) {
          for (const cj of cellToCons.get(x)) {
            if (inWindow.has(cj)) continue;
            const merged = new Set(cellSet);
            cons[cj].set.forEach((y) => merged.add(y));
            if (merged.size > WINDOW_CAP) continue;
            inWindow.add(cj);
            merged.forEach((y) => cellSet.add(y));
            queue.push(cj);
          }
        }
      }

      if (inWindow.size < 2) continue;

      const key = [...inWindow].sort((a, b) => a - b).join(",");
      if (tried.has(key)) continue;
      tried.add(key);

      const cells = [...cellSet];
      const byTotal = enumerate(
        cells,
        [...inWindow].map((ci) => ({ cells: cons[ci].set, n: cons[ci].n }))
      );
      if (!byTotal || byTotal.size === 0) continue;

      const { alwaysMine, alwaysSafe } = certainties(cells, byTotal, [...byTotal.keys()]);
      if (applyCertainties(cells, alwaysMine, alwaysSafe)) return true; // board moved
    }
    return false;
  };

  /* ---------- drive the layers ---------- */
  let progress = true;
  while (progress) {
    progress = confirmFlags();
    if (!progress) progress = basicPass();
    if (!progress && smart) progress = smartPass();
    if (!progress && smart) progress = fullPass();
    if (!progress && smart) progress = windowPass();
  }

  return { board: next, flagsAdded, opened, steps };
}

/* ==================================================================
   The referee.

   Runs at full strength on every move, for every player, no matter what
   assistance they have switched on. Your toggles decide what the game shows
   you; they never decide what a mine is worth.

   It strips the player's flags and reasons purely from revealed numbers, then
   pushes logic as far as it will go. Two things fall out:

     provenMines — the mines logic can force from what has been opened. A flag
                   banks a bomb only if its square is in here. An unproven flag
                   is a guess, and guesses do not pay — not even correct ones.

     undeducible — when logic stalls with the board unfinished, the unknown
                   squares still touching opened ground are exactly the ones it
                   could not resolve: the coastline of the island. Mines sitting
                   there are Unexploded Ordnance. Nothing could have found them.
                   The only way to claim one is to dig its neighbour and live —
                   which is precisely what turns the guess into a proof.

   Mines buried deep in unopened territory are NOT undeducible. They are merely
   untouched. Only the coastline counts.
   ================================================================== */
export function referee(board, rows, cols, totalMines) {
  const shadow = board.map((c) => ({ ...c, flagged: false, auto: false }));
  const { board: solved } = applyAssist(shadow, rows, cols, true, true, totalMines);

  const provenMines = new Set();
  const coastline = new Set();
  let unresolved = 0;

  for (let i = 0; i < solved.length; i++) {
    if (solved[i].flagged && solved[i].auto) { provenMines.add(i); continue; }
    if (solved[i].revealed) continue;

    unresolved++;
    if (neighborsOf(i, rows, cols).some((n) => solved[n].revealed)) coastline.add(i);
  }

  const stalled = unresolved > 0;
  const undeducible = new Set();
  if (stalled) coastline.forEach((i) => { if (board[i].mine) undeducible.add(i); });

  return { provenMines, coastline, undeducible, stalled };
}