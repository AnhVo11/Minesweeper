import AsyncStorage from "@react-native-async-storage/async-storage";
import { neighborsOf } from "./deduce";

/* ==================================================================
   TUNING — every balance knob lives here.
   ================================================================== */

// Coins paid per opened safe square, indexed by its number.
// Index 0 = a blank square, which pays nothing: coins come from working in
// dangerous territory, not from farming empty corners.
export const COIN_TABLE = [0, 1, 4, 9, 16, 25, 40, 60, 70];

export const PAYOUT = {
  win: 1.0,        // cleared the board
  surrender: 1.0,  // banked voluntarily
  loss: 0.75,      // hit a mine — lower toward 0.5 to make surrender bite
};

export const BLIND_MULTIPLIER = 2;

// Assistance cuts are ADDITIVE, so all three on leaves exactly nothing.
export const ASSIST_CUT = 0.20; // auto-flag
export const SWEEP_CUT = 0.35;  // auto-sweep
export const SMART_CUT = 0.45;  // smart sweep
export const ASSIST_MULTIPLIER = 1 - ASSIST_CUT;
export const SWEEP_MULTIPLIER = 1 - SWEEP_CUT;
export const SMART_MULTIPLIER = 1 - SMART_CUT;
// Once the assistant is opening squares for you, ordinary bombs stop paying.
// Only Unexploded Ordnance survives — by definition, the one thing the solver
// could not have found for you.
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
   Bomb classification

   The referee (deduce.js) decides everything. It runs at full strength on every
   move for every player, so what a mine is worth never depends on which
   assistance you switched on.

     provenMines — mines logic can force right now. A flag banks a bomb only if
                   its square is in here. An unproven flag is a guess, and
                   guesses do not pay, even when they happen to be right.

     uxoSet      — mines that sat on the coastline of a stalled board. Logic gave
                   up on them. To claim one you must dig its neighbour and live,
                   which is what turns the guess into a proof.
   ================================================================== */

const mineNeighborCount = (board, i, rows, cols) =>
  neighborsOf(i, rows, cols).filter((x) => board[x].mine).length;

export function collectBombs(board, rows, cols, outcome, provenMines, provenEver, undeducibleEver) {
  const counts = { mine: 0, uxo: 0, brokenArrow: 0 };

  // A win means you located every mine — you cannot clear a board otherwise.
  // Anything short of that, and you keep only what you flagged AND proved.
  const collected = (i) =>
    outcome === "win" ? true : board[i].flagged && provenMines.has(i);

  board.forEach((cell, i) => {
    if (!cell.mine || !collected(i)) return;

    // The blast ruins them: a lost board banks plain Mines and nothing else.
    if (outcome === "loss") { counts.mine++; return; }

    // A UXO is a mine the referee NEVER managed to prove, at any point in the
    // game. If logic could find it, it's ordinary — no matter how it felt to play.
if (undeducibleEver && undeducibleEver.has(i) && !provenEver.has(i)) counts.uxo++;
    else if (mineNeighborCount(board, i, rows, cols) >= BROKEN_ARROW_MIN_NEIGHBORS) counts.brokenArrow++;
    else counts.mine++;
  });

  return counts;
}


/** Every mine on the board, typed. Used to colour the grid once the game ends. */
export function classifyMines(board, rows, cols, provenEver , undeducibleEver) {
  const map = {};
  board.forEach((cell, i) => {
    if (!cell.mine) return;
    if (undeducibleEver && undeducibleEver.has(i) && !provenEver.has(i)) map[i] = "uxo";
    else if (mineNeighborCount(board, i, rows, cols) >= BROKEN_ARROW_MIN_NEIGHBORS) map[i] = "brokenArrow";
    else map[i] = "mine";
  });
  return map;
}
/* ==================================================================
   Scoring one run
   ================================================================== */

export function scoreRun({
  board, rows, cols, outcome, blind, assist, sweep, smart,
  provenMines, provenEver,undeducibleEver, mode, time,
}) {
  const rawCoins = coinsForBoard(board);
  const helping = assist && !blind;

  const cut =
    (helping ? ASSIST_CUT : 0) +
    (helping && sweep ? SWEEP_CUT : 0) +
    (helping && sweep && smart ? SMART_CUT : 0);

  const multiplier =
    PAYOUT[outcome] * (blind ? BLIND_MULTIPLIER : 1) * Math.max(0, 1 - cut);
  const coins = Math.floor(rawCoins * multiplier);

 const bombs = collectBombs(board, rows, cols, outcome, provenMines, provenEver, undeducibleEver);

  // Auto-sweep did the finding, so it doesn't count as your find. Remember what
  // was on the board anyway — the player deserves to see what they lost.
  const bombsVoided = helping && sweep;
  const bombsFound = { ...bombs };
  if (bombsVoided) SWEEP_VOIDS_BOMBS.forEach((k) => { bombs[k] = 0; });

  // A plain-language receipt, so the payout is never a mystery.
  const breakdown = [];
  if (outcome === "loss") breakdown.push({ label: "Lost the board", amount: `×${PAYOUT.loss}` });
  if (blind) breakdown.push({ label: "Blind mode", amount: `×${BLIND_MULTIPLIER}`, good: true });
  if (helping) breakdown.push({ label: "Auto-flag", amount: `−${ASSIST_CUT * 100}%` });
  if (helping && sweep) breakdown.push({ label: "Auto-sweep", amount: `−${SWEEP_CUT * 100}%` });
  if (helping && sweep && smart) breakdown.push({ label: "Smart sweep", amount: `−${SMART_CUT * 100}%` });

  return {
    outcome, blind, assist, sweep, smart, mode, time,
    rawCoins, multiplier, coins, breakdown,
    bombs, bombsFound, bombsVoided,
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
  bestTime: {}, // seconds, wins only
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