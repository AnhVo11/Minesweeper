import AsyncStorage from "@react-native-async-storage/async-storage";
import { neighborsOf, findUndeducibleMines } from "./deduce";
export { findUndeducibleMines };
/* ==================================================================
   TUNING — every balance knob lives here.
   ================================================================== */

// Coins paid per opened safe square, indexed by its number.
// Index 0 = a blank square, which pays nothing: coins come from
// working in dangerous territory, not from farming empty corners.
export const COIN_TABLE = [0, 1, 4, 9, 16, 25, 40, 60, 70];

export const PAYOUT = {
  win: 1.0,        // cleared the board
  surrender: 1.0,  // banked voluntarily
  loss: 0.75,      // hit a mine — lower this toward 0.5 to make surrender bite
};

export const BLIND_MULTIPLIER = 2;

// The auto-flag assistant plants every flag logic proves.
export const ASSIST_MULTIPLIER = 0.80;

// Auto-sweep rides on top: it opens what the proven flags make safe.
export const SWEEP_MULTIPLIER = 0.65;

// Smart sweep adds set-difference and exact enumeration — a near-complete solver.
export const SMART_MULTIPLIER = 0.55;

// Once the assistant is opening squares for you, ordinary bombs stop paying.
// Mines and Broken Arrows bank nothing. Only Unexploded Ordnance survives —
// it is, by definition, the one thing the solver could not have found for you.
export const SWEEP_VOIDS_BOMBS = ["mine", "brokenArrow"];

// A mine with at least this many mines touching it is a Broken Arrow.
export const BROKEN_ARROW_MIN_NEIGHBORS = 6;

export const BOMB_TYPES = {
  mine: { key: "mine", label: "Mine" },
  uxo: { key: "uxo", label: "Unexploded Ordnance" },
  brokenArrow: { key: "brokenArrow", label: "Broken Arrow" },
};


/* ==================================================================
   Coins
   ================================================================== */

export const coinsForBoard = (board) =>
  board.reduce(
    (sum, cell) => sum + (cell.revealed && !cell.mine ? COIN_TABLE[cell.adj] || 0 : 0),
    0
  );

/* ==================================================================
   The logical solver — this is what defines a UXO.

   Replays the board from the player's first click the way a perfect
   logician would, using only the two rules a human actually uses:

     1. A number whose unknown neighbors equal its count  -> all are mines.
     2. A number whose mines are all found                -> the rest are safe.

   Iterate to a fixpoint. Any mine it never manages to force could not
   have been found by logic alone — you had to read the board, count
   globally, or call a 50/50. Those are the Unexploded Ordnance.

   Note this must run from the FIRST CLICK, not the finished board. On a
   won board every safe square is open, so every mine becomes trivially
   deducible and nothing would ever qualify.
   

export function findUndeducibleMines(board, rows, cols, firstClick) {
  const n = rows * cols;
  const known = new Array(n).fill(0); // 0 = unknown, 1 = known safe, 2 = known mine

  // Open the first click, flooding through blanks exactly as the game does.
  const stack = [firstClick];
  while (stack.length) {
    const i = stack.pop();
    if (known[i] === 1 || board[i].mine) continue;
    known[i] = 1;
    if (board[i].adj === 0) {
      neighborsOf(i, rows, cols).forEach((x) => {
        if (known[x] === 0 && !board[x].mine) stack.push(x);
      });
    }
  }

  let changed = true;
  while (changed) {
    changed = false;

    for (let i = 0; i < n; i++) {
      if (known[i] !== 1 || board[i].adj === 0) continue;

      const ns = neighborsOf(i, rows, cols);
      const unknowns = ns.filter((x) => known[x] === 0);
      if (unknowns.length === 0) continue;

      const flagged = ns.filter((x) => known[x] === 2).length;

      // Rule 1 — every remaining unknown must be a mine.
      if (board[i].adj - flagged === unknowns.length) {
        unknowns.forEach((x) => { known[x] = 2; });
        changed = true;
        continue;
      }

      // Rule 2 — all this number's mines are accounted for, so open the rest.
      if (board[i].adj === flagged) {
        unknowns.forEach((x) => {
          const openStack = [x];
          while (openStack.length) {
            const j = openStack.pop();
            if (known[j] === 1 || board[j].mine) continue;
            known[j] = 1;
            if (board[j].adj === 0) {
              neighborsOf(j, rows, cols).forEach((y) => {
                if (known[y] === 0 && !board[y].mine) openStack.push(y);
              });
            }
          }
        });
        changed = true;
      }
    }
  }

  // Any mine logic never forced.
  const undeducible = new Set();
  for (let i = 0; i < n; i++) {
    if (board[i].mine && known[i] !== 2) undeducible.add(i);
  }
  return undeducible;
}
  ================================================================== */

/* ==================================================================
   Bomb classification
   ================================================================== */

const mineNeighborCount = (board, i, rows, cols) =>
  neighborsOf(i, rows, cols).filter((x) => board[x].mine).length;

/** A flag only earns credit if it touches an opened safe square. */
export const isFlagEarned = (board, i, rows, cols) =>
  board[i].flagged &&
  neighborsOf(i, rows, cols).some((x) => board[x].revealed && !board[x].mine);

/**
 * Which mines did the player actually collect, and what type is each?
 * Specials are win-only. On a loss or surrender you keep the mines you
 * genuinely deduced, but they all bank as plain Mines.
 */
export function collectBombs(board, rows, cols, outcome, firstClick) {
  const counts = { mine: 0, uxo: 0, brokenArrow: 0 };

  // A loss banks the mines you genuinely deduced, but the shock wave ruins
  // them: everything comes back as a plain Mine, no specials.
  if (outcome === "loss") {
    board.forEach((cell, i) => {
      if (cell.mine && isFlagEarned(board, i, rows, cols)) counts.mine++;
    });
    return counts;
  }

  const undeducible = findUndeducibleMines(board, rows, cols, firstClick);

  // Which mines count:
  //   win       — all of them; you cannot clear a board without knowing where
  //               every mine is, flagged or not.
  //   surrender — only the ones you actually earned a flag on.
  const collected = (i) =>
    outcome === "win" ? true : isFlagEarned(board, i, rows, cols);

  board.forEach((cell, i) => {
    if (!cell.mine || !collected(i)) return;
    if (undeducible.has(i)) counts.uxo++;
    else if (mineNeighborCount(board, i, rows, cols) >= BROKEN_ARROW_MIN_NEIGHBORS) counts.brokenArrow++;
    else counts.mine++;
  });

  return counts;
}

/* ==================================================================
   Scoring one run
   ================================================================== */

export function scoreRun({ board, rows, cols, outcome, blind, assist, sweep, smart, firstClick, mode, time }) {
  const rawCoins = coinsForBoard(board);
  const helping = assist && !blind;
  const cut =
    (helping ? 0.20 : 0) +
    (helping && sweep ? 0.35 : 0) +
    (helping && sweep && smart ? 0.45 : 0);

  const multiplier =
    PAYOUT[outcome] * (blind ? BLIND_MULTIPLIER : 1) * Math.max(0, 1 - cut);
  const coins = Math.floor(rawCoins * multiplier);

  // A plain-language receipt, so the payout is never a mystery.
  const breakdown = [];
  if (outcome === "loss") breakdown.push({ label: "Lost the board", amount: `×${PAYOUT.loss}` });
  if (blind) breakdown.push({ label: "Blind mode", amount: `×${BLIND_MULTIPLIER}`, good: true });
  if (helping) breakdown.push({ label: "Auto-flag", amount: "−20%" });
  if (helping && sweep) breakdown.push({ label: "Auto-sweep", amount: "−35%" });
  if (helping && sweep && smart) breakdown.push({ label: "Smart sweep", amount: "−45%" });
  const bombs = collectBombs(board, rows, cols, outcome, firstClick);

 // Auto-sweep did the finding, so it doesn't count as your find. Remember what
  // was on the board anyway — the player deserves to see what they lost.
  const bombsVoided = helping && sweep;
  const bombsFound = { ...bombs };
  if (bombsVoided) SWEEP_VOIDS_BOMBS.forEach((k) => { bombs[k] = 0; });

  return {
    outcome,
    blind,
    assist,
    sweep,
    smart,
    mode,
    time,
    rawCoins,
    multiplier,
    breakdown,
    coins,
    bombs,
    bombsVoided,
    bombsFound,
    bombTotal: bombs.mine + bombs.uxo + bombs.brokenArrow,
    safeOpened: board.filter((c) => c.revealed && !c.mine).length,
  };
}

/* ==================================================================
   Profile — persisted across sessions
   ================================================================== */

const PROFILE_KEY = "minesweep:profile:v1";

export const EMPTY_PROFILE = {
  coins: 0,
  bombs: { mine: 0, uxo: 0, brokenArrow: 0 },
  games: 0,
  wins: 0,
  surrenders: 0,
  losses: 0,
  bestTime: {}, // { easy: 91, medium: 402, ... } seconds, wins only
};

export async function loadProfile() {
  try {
    const raw = await AsyncStorage.getItem(PROFILE_KEY);
    if (!raw) return EMPTY_PROFILE;
    return { ...EMPTY_PROFILE, ...JSON.parse(raw) };
  } catch {
    return EMPTY_PROFILE;
  }
}

export async function saveProfile(profile) {
  try {
    await AsyncStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  } catch {
    // storage failure shouldn't take the game down
  }
}

/** Fold a scored run into the profile and persist it. Returns the new profile. */
export async function bankRun(profile, run, modeKey) {
  const next = {
    ...profile,
    coins: profile.coins + run.coins,
    bombs: {
      mine: profile.bombs.mine + run.bombs.mine,
      uxo: profile.bombs.uxo + run.bombs.uxo,
      brokenArrow: profile.bombs.brokenArrow + run.bombs.brokenArrow,
    },
    games: profile.games + 1,
    wins: profile.wins + (run.outcome === "win" ? 1 : 0),
    surrenders: profile.surrenders + (run.outcome === "surrender" ? 1 : 0),
    losses: profile.losses + (run.outcome === "loss" ? 1 : 0),
    bestTime: { ...profile.bestTime },
  };

  if (run.outcome === "win") {
    const prev = next.bestTime[modeKey];
    if (prev == null || run.time < prev) next.bestTime[modeKey] = run.time;
  }

  await saveProfile(next);
  return next;
}

export async function resetProfile() {
  await saveProfile(EMPTY_PROFILE);
  return EMPTY_PROFILE;
}