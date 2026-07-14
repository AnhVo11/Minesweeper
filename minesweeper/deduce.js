/* ==================================================================
   deduce.js — the single source of truth for logical deduction.

   Two callers, one implementation:

     • The live assistant calls applyAutoFlags() after every dig, planting
       flags on mines that are already proven.
     • The reward engine calls solveFromFirstClick() at game end to work out
       which mines logic could never have found (those become UXO), and at
       generation time to enforce the guess budget.

   These MUST share code. If they ever drift, the game will happily flag a
   mine that the solver later insists was undeducible.
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

/* ------------------------------------------------------------------
   RULE 1 — the counting rule.

   A revealed number knows how many mines surround it. Subtract the flags
   already placed around it, and if the number of squares still unaccounted
   for exactly equals the mines still missing, then every one of those
   squares is a mine. No ambiguity, no choice.

     "3" with 1 flag placed and exactly 2 unknown squares left
      -> both unknowns are mines.

   This is the ONLY rule the live assistant is allowed to use. It marks;
   it never opens. The player still chooses every square they dig.
   ------------------------------------------------------------------ */

/**
 * Plant every flag that Rule 1 proves, repeating until nothing new appears —
 * one flag often unlocks the next.
 * Returns a new board plus how many flags were added (0 means nothing changed).
 */
/**
 * The live assistant: flag what's proven, then open what's proven safe, and
 * repeat until nothing new falls out.
 *
 * It deliberately IGNORES the player's manual flags and reasons only from
 * revealed numbers plus flags it proved itself. That guarantees it can never
 * open a mine: a wrong manual flag would otherwise let Rule 2 "prove" a mine
 * was safe and detonate it for you, which would be an unforgivable way to lose.
 * If the player manually flagged a square the assistant can prove is safe, the
 * flag is simply wrong — it gets cleared and the square opened.
 */
export function applyAssist(board, rows, cols, sweep = true) {
  let next = board;
  let flagsAdded = 0;
  let opened = 0;

  const clone = () => { if (next === board) next = board.map((c) => ({ ...c })); };
  const proven = (i) => next[i].flagged && next[i].auto;

  const open = (start) => {
    const stack = [start];
    while (stack.length) {
      const i = stack.pop();
      const c = next[i];
      if (c.revealed || c.mine || c.flagged) continue; // any flag, manual or auto, is left alone
      c.revealed = true;
      opened++;
      if (c.adj === 0) {
        neighborsOf(i, rows, cols).forEach((n) => {
          if (!next[n].revealed && !proven(n)) stack.push(n);
        });
      }
    }
  };

  let changed = true;
  while (changed) {
    changed = false;

    for (let i = 0; i < next.length; i++) {
      const cell = next[i];
      if (!cell.revealed || cell.mine || cell.adj === 0) continue;

      const ns = neighborsOf(i, rows, cols);
      const unknown = ns.filter((n) => !next[n].revealed && !proven(n));
      if (unknown.length === 0) continue;

      const found = ns.filter((n) => proven(n)).length;

      // RULE 1 — the squares left over must all be mines.
      if (cell.adj - found === unknown.length) {
        clone();
        unknown.forEach((n) => { next[n] = { ...next[n], flagged: true, auto: true }; });
        flagsAdded += unknown.length;
        changed = true;
        continue;
      }

      // RULE 2 — every mine here is accounted for, so the rest is safe.
      if (sweep && cell.adj === found) {
        clone();
        unknown.forEach(open);
        changed = true;
      }
    }
  }

  return { board: next, flagsAdded, opened };
}

/* ------------------------------------------------------------------
   The offline solver — Rule 1 plus RULE 2, the completion rule:
   a number whose mines are all found tells you everything else around it
   is safe. Together they replay the board from the first click as a
   perfect logician would.

   Any mine this cannot force could not have been found by deduction. Note
   it must run from the FIRST CLICK, not the finished board: once you've
   won, every remaining square is trivially a mine and nothing would ever
   qualify.
   ------------------------------------------------------------------ */

const UNKNOWN = 0;
const SAFE = 1;
const MINE = 2;

/** Returns the `known` array: 0 unknown, 1 proven safe, 2 proven mine. */
export function solveFromFirstClick(board, rows, cols, firstClick) {
  const n = rows * cols;
  const known = new Array(n).fill(UNKNOWN);

  const open = (start) => {
    const stack = [start];
    while (stack.length) {
      const i = stack.pop();
      if (known[i] === SAFE || board[i].mine) continue;
      known[i] = SAFE;
      if (board[i].adj === 0) {
        neighborsOf(i, rows, cols).forEach((x) => {
          if (known[x] === UNKNOWN && !board[x].mine) stack.push(x);
        });
      }
    }
  };

  open(firstClick);

  let changed = true;
  while (changed) {
    changed = false;

    for (let i = 0; i < n; i++) {
      if (known[i] !== SAFE || board[i].adj === 0) continue;

      const ns = neighborsOf(i, rows, cols);
      const unknown = ns.filter((x) => known[x] === UNKNOWN);
      if (unknown.length === 0) continue;

      const found = ns.filter((x) => known[x] === MINE).length;

      // Rule 1 — everything left must be a mine.
      if (board[i].adj - found === unknown.length) {
        unknown.forEach((x) => { known[x] = MINE; });
        changed = true;
        continue;
      }

      // Rule 2 — all mines accounted for, so the rest is safe.
      if (board[i].adj === found) {
        unknown.forEach(open);
        changed = true;
      }
    }
  }

  return known;
}

/** Mines that logic could never force from this opening click. */
export function findUndeducibleMines(board, rows, cols, firstClick) {
  const known = solveFromFirstClick(board, rows, cols, firstClick);
  const out = new Set();
  for (let i = 0; i < board.length; i++) {
    if (board[i].mine && known[i] !== MINE) out.add(i);
  }
  return out;
}