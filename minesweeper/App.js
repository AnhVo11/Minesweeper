import React, { useState, useEffect, useCallback, useRef } from "react";
import { applyAssist, referee } from "./deduce";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  StyleSheet,
  SafeAreaView,
  StatusBar,
  Vibration,
  Platform,
  Modal,
  Alert,
  useWindowDimensions,
} from "react-native";
import Slider from "@react-native-community/slider";

import {
  scoreRun,
  bankRun,
  loadProfile,
  resetProfile,
  classifyMines,
  EMPTY_PROFILE,
  PAYOUT,
  BLIND_MULTIPLIER,
  ASSIST_MULTIPLIER,
  ASSIST_CUT,
  SWEEP_MULTIPLIER,
  SMART_MULTIPLIER,
} from "./reward";

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

const MODES = {
  easy: { label: "Easy", rows: 9, cols: 9, mines: 10 },
  medium: { label: "Medium", rows: 16, cols: 16, mines: 40 },
  hard: { label: "Hard", rows: 30, cols: 16, mines: 99 },
  extreme: { label: "Extreme", rows: 40, cols: 24, mines: 199 },
  challenge: { label: "Challenge", rows: 20, cols: 20, mines: 100 },
  custom: { label: "Custom", rows: 12, cols: 12, mines: 24 },
};

const LIMITS = { minRows: 9, maxRows: 40, minCols: 9, maxCols: 30, minMines: 10, maxMines: 370 };

// A board needs breathing room: the first click and its 8 neighbors are always
// safe, and past ~40% density the board stops being solvable by deduction.
const maxMinesFor = (r, c) =>
  Math.max(
    LIMITS.minMines,                       // never below 10
    Math.min(
      LIMITS.maxMines,                     // 370 hard cap (a full 40×30)
      Math.floor((r * c * 9) / 40) + 100,  // eases off: −9 mines per 40 cells lost
      Math.floor(r * c * 0.4),             // 40% solvability ceiling (small boards)
      r * c - 10                           // keep a 10-cell safe reserve
    )
  );

const C = {
  bg: "#12151C",
  panel: "#1C212B",
  line: "#2A3140",
  cellUp: "#2F3749",
  cellDown: "#171B24",
  text: "#F0F3FA",
  dim: "#9AA3B5",
  green: "#5EE6B0",
  amber: "#FFB454",
  red: "#FF5C5C",
  gold: "#F5D06B",
  violet: "#C99CFF",
  brown: "#8B5A2B",
  mine: "#2E7D4F",   // ordinary Mine indicator — dark green
  black: "#0A0C10",
  mineBg: "#3A2430",
};

const NUM_COLORS = ["", "#6FB7FF", "#5EE6B0", "#FF7B7B", "#C99CFF", "#FFB454", "#4FD8D8", "#F0F3FA", "#9AA3B5"];
const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });
const GAP = 2;
const TITLE_LETTERS = "MINESWEEP".split("");
const SECRET = "PINMINES";

/* ------------------------------------------------------------------ */
/*  Game logic                                                         */
/* ------------------------------------------------------------------ */

const neighborsOf = (r, c, rows, cols) => {
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

const nbrs = (i, rows, cols) => neighborsOf(Math.floor(i / cols), i % cols, rows, cols);

const makeEmptyBoard = (rows, cols) =>
  Array.from({ length: rows * cols }, () => ({
    mine: false, revealed: false, flagged: false, adj: 0, exploded: false,
  }));

/**
 * Mines are scattered at random, with one constraint: no 2x2 block anywhere on
 * the board may be four solid mines. That breaks up the dense blobs that make
 * regions unsolvable, while still allowing the loose clusters Broken Arrow needs
 * (a mine can reach 6 mine-neighbors with no solid 2x2 — put its safe cells
 * directly above and below it).
 */
function placeMines(board, rows, cols, mineCount, safeIndex) {
  const next = board.map((c) => ({ ...c }));
  const safeZone = new Set([safeIndex, ...nbrs(safeIndex, rows, cols)]);

  let pool = next.map((_, i) => i).filter((i) => !safeZone.has(i));
  if (pool.length < mineCount) pool = next.map((_, i) => i).filter((i) => i !== safeIndex);

  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  const mine = new Array(rows * cols).fill(false);
  const isMine = (r, c) => r >= 0 && r < rows && c >= 0 && c < cols && mine[r * cols + c];

  // Would putting a mine here complete a solid 2x2? Four blocks touch any cell.
  const wouldFillSquare = (i) => {
    const r = Math.floor(i / cols);
    const c = i % cols;
    mine[i] = true;
    let bad = false;
    for (const [dr, dc] of [[-1, -1], [-1, 0], [0, -1], [0, 0]]) {
      const r0 = r + dr;
      const c0 = c + dc;
      if (isMine(r0, c0) && isMine(r0, c0 + 1) && isMine(r0 + 1, c0) && isMine(r0 + 1, c0 + 1)) {
        bad = true;
        break;
      }
    }
    mine[i] = false;
    return bad;
  };

  let placed = 0;
  const rejected = [];
  for (const i of pool) {
    if (placed >= mineCount) break;
    if (wouldFillSquare(i)) { rejected.push(i); continue; }
    mine[i] = true;
    placed++;
  }
  // Safety valve: an absurdly dense board might not fit under the rule.
  for (const i of rejected) {
    if (placed >= mineCount) break;
    mine[i] = true;
    placed++;
  }

  mine.forEach((m, i) => { if (m) next[i].mine = true; });

  for (let i = 0; i < next.length; i++) {
    if (next[i].mine) continue;
    next[i].adj = nbrs(i, rows, cols).filter((n) => next[n].mine).length;
  }
  return next;
}

function floodReveal(board, rows, cols, start) {
  const next = board.map((c) => ({ ...c }));
  const stack = [start];
  while (stack.length) {
    const i = stack.pop();
    const cell = next[i];
    if (cell.revealed || cell.flagged) continue;
    cell.revealed = true;
    if (cell.adj === 0 && !cell.mine) {
      nbrs(i, rows, cols).forEach((n) => {
        if (!next[n].revealed && !next[n].flagged) stack.push(n);
      });
    }
  }
  return next;
}


/* ------------------------------------------------------------------ */
/*  Cell                                                               */
/* ------------------------------------------------------------------ */

const Cell = React.memo(function Cell({ cell, size, over, won, peek, bombType, onPress, onLongPress }) {
  const showMine = cell.revealed && cell.mine;
  const wrongFlag = over && cell.flagged && !cell.mine;

  let bg = C.cellUp;
  if (cell.exploded) bg = C.red;
  else if (showMine) bg = won ? C.cellDown : C.cellUp;
  else if (cell.revealed) bg = C.cellDown;

  const isNumber = cell.revealed && !cell.mine && cell.adj > 0;

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={280}
      disabled={over && !cell.revealed && !cell.flagged}
      style={[
        styles.cell,
        {
          width: size,
          height: size,
          borderRadius: size < 16 ? 2 : 6,
          backgroundColor: bg,
          borderTopColor: cell.revealed && !(showMine && !won) ? "transparent" : "rgba(255,255,255,0.10)",
        },

      ]}
    >
      {isNumber && (
        <Text
          allowFontScaling={false}
          style={{
            fontSize: size * 0.6,
            lineHeight: size,
            fontWeight: "800",
            color: NUM_COLORS[cell.adj],
            fontFamily: MONO,
          }}
        >
          {cell.adj}
        </Text>
      )}

      {/* Flag — a red pennant off an implied pole on the left. Always full
          opacity; whether it's proven shows up as the locked border instead. */}
      {!cell.revealed && cell.flagged && !wrongFlag && (
        <View style={{
          width: 0, height: 0, backgroundColor: "transparent",
          borderTopWidth: size * 0.24, borderBottomWidth: size * 0.24,
          borderLeftWidth: size * 0.48,
          borderTopColor: "transparent", borderBottomColor: "transparent",
          borderLeftColor: C.red,
        }} />
      )}


      {/* A flag that turned out to be wrong. */}
      {wrongFlag && (
        <View style={{
          width: size * 0.5, height: size * 0.5, borderRadius: 2,
          borderWidth: 1.5, borderColor: C.red, opacity: 0.5,
        }} />
      )}
      {/* Locked (auto/proven) flag — a red frame drawn INSIDE the cell, inset
          from the edges so it reads as an inner border. */}
      {!cell.revealed && cell.flagged && cell.auto && (
        <View pointerEvents="none" style={{
          position: "absolute",
          top: 2, left: 2, right: 2, bottom: 2,
          borderWidth: 2, borderColor: C.red,
          borderRadius: size < 16 ? 1 : 4,
        }} />
      )}

      {/* The one you detonated: a dark circle ringed in red. */}
      {cell.exploded && (
        <View style={{
          width: size * 0.5, height: size * 0.5, borderRadius: size,
          backgroundColor: C.black, borderWidth: 1.5, borderColor: C.red,
        }} />
      )}

      {/* Every other mine, typed and coloured once the game is over. */}
      {/* Every other mine. On a WIN, reveal its type by colour (dark-green Mine,
          gold UXO, violet Broken Arrow) — your flags become these markers. On a
          loss it's just an anonymous black circle; you don't learn what it was. */}
      {showMine && !cell.exploded && (
        won ? (
          <View style={{
            width: size * 0.5, height: size * 0.5, borderRadius: 2,
            backgroundColor:
              bombType === "uxo" ? C.gold
              : bombType === "brokenArrow" ? C.violet
              : C.mine,
          }} />
        ) : (
          <View style={{
            width: size * 0.55, height: size * 0.55, borderRadius: size,
            backgroundColor: C.black,
          }} />
        )
      )}

      {peek && !cell.revealed && !cell.flagged && cell.mine && (
        <View style={{
          position: "absolute", width: size * 0.42, height: size * 0.42,
          borderRadius: size, borderWidth: 1.5, borderColor: C.red, opacity: 0.85,
        }} />
      )}
    </Pressable>
  );
});

/* ------------------------------------------------------------------ */
/*  App                                                                */
/* ------------------------------------------------------------------ */

const clampCustom = (raw) => {
  const r = Math.max(LIMITS.minRows, Math.min(LIMITS.maxRows, raw.rows));
  const c = Math.max(LIMITS.minCols, Math.min(LIMITS.maxCols, raw.cols));
  const m = Math.max(LIMITS.minMines, Math.min(maxMinesFor(r, c), raw.mines));
  return { rows: r, cols: c, mines: m };
};

export default function App() {
  const { width: SCREEN_W } = useWindowDimensions();

  // live game
  const [modeKey, setModeKey] = useState("easy");
  const [blind, setBlind] = useState(false);
  const [assist, setAssist] = useState(true);
  const [pendingAssist, setPendingAssist] = useState(true);
  const [sweep, setSweep] = useState(true);
  const [pendingSweep, setPendingSweep] = useState(true);
  const [smart, setSmart] = useState(false);
  const [pendingSmart, setPendingSmart] = useState(false);
  const [config, setConfig] = useState({ rows: 9, cols: 9, mines: 10 });
  const [board, setBoard] = useState(() => makeEmptyBoard(9, 9));
  const [firstClick, setFirstClick] = useState(null);
  const [status, setStatus] = useState("idle"); // idle | playing | won | lost | surrendered
  const [flagMode, setFlagMode] = useState(false);
  const [time, setTime] = useState(0);
  const [run, setRun] = useState(null); // scored result of the finished game
  const [bombMap, setBombMap] = useState({});
  const [proven, setProven] = useState(new Set());
  const provenRef = useRef(new Set());
  const provenEverRef = useRef(new Set()); // every mine logic ever pinned down
  // profile
  const undeducibleEverRef = useRef(new Set()); // mines ever stranded on a stalled coastline
  const [solving, setSolving] = useState(false);
  const [speed, setSpeed] = useState(1);
  const speedRef = useRef(1);
  const stepsRef = useRef([]);
  const animBoardRef = useRef(null);
  const solveCtxRef = useRef({ click: null });
  const endSolveRef = useRef(() => { });
  const [profile, setProfile] = useState(EMPTY_PROFILE);
  const [profileOpen, setProfileOpen] = useState(false);
  const [code, setCode] = useState("");
  const [peek, setPeek] = useState(false);
  const [cheated, setCheated] = useState(false);

  // menu — selections stay pending until Start
  const [menuOpen, setMenuOpen] = useState(false);
  const [pendingMode, setPendingMode] = useState("easy");
  const [pendingCustom, setPendingCustom] = useState({ rows: 12, cols: 12, mines: 24 });

  const { rows, cols, mines } = config;
  const totalSafe = rows * cols - mines;
  const safeOpened = board.filter((c) => c.revealed && !c.mine).length;
  const flagsPlaced = board.filter((c) => c.flagged).length;
  const active = status === "idle" || status === "playing";
  const challenge = modeKey === "challenge";
  const accent = blind ? C.amber : C.green;

  useEffect(() => { loadProfile().then(setProfile); }, []);

  useEffect(() => {
    if (status !== "playing") return;
    const id = setInterval(() => setTime((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [status]);

  useEffect(() => {
    if (!solving) return;
    const id = setInterval(() => {
      const steps = stepsRef.current;
      if (!steps.length) { endSolveRef.current(); return; }
      const per = speedRef.current;                 // 1× / 2× / 4× = steps per tick
      const b = animBoardRef.current.slice();        // new array, new objects only for changed cells
      for (let k = 0; k < per && steps.length; k++) {
        const s = steps.shift();
        if (s.t === "flag") {
          b[s.i] = { ...b[s.i], flagged: true, auto: true };
        } else {
          s.is.forEach((idx) => { b[idx] = { ...b[idx], revealed: true, flagged: false }; });
        }
      }
      animBoardRef.current = b;
      setBoard(b);
      if (!steps.length) endSolveRef.current();
    }, 45);
    return () => clearInterval(id);
  }, [solving]);

  /* ---------- sizing: the board always fits the width ---------- */
  const boardMaxW = Math.min(SCREEN_W, 640) - 8 - 6;
  const cellSize = Math.max(6, Math.floor((boardMaxW - GAP * (cols - 1)) / cols));
  const boardW = cols * cellSize + GAP * (cols - 1);
  const boardH = rows * cellSize + GAP * (rows - 1);

  /* ---------- lifecycle ---------- */
  const startGame = useCallback((key, customRaw, blindOn, assistOn, sweepOn, smartOn) => {
    const base = key === "custom" ? clampCustom(customRaw) : MODES[key];

    // Challenge forces the full solver on and blind off — the bot clears
    // everything deducible and you only make the guesses.
    if (key === "challenge") { blindOn = false; assistOn = true; sweepOn = true; smartOn = true; }

    setModeKey(key);
    setBlind(blindOn);
    setAssist(assistOn);
    setSweep(sweepOn);
    setSmart(smartOn);
    setConfig({ rows: base.rows, cols: base.cols, mines: base.mines });
    setBoard(makeEmptyBoard(base.rows, base.cols));
    setFirstClick(null);
    setStatus("idle");
    setFlagMode(false);
    setTime(0);
    setBombMap({});
    setRun(null);
    setProven(new Set());
    provenRef.current = new Set();
    provenEverRef.current = new Set();
    undeducibleEverRef.current = new Set();
    setSolving(false);
    stepsRef.current = [];
    animBoardRef.current = null;
    speedRef.current = 1;
    setSpeed(1);
    setCode("");
    setPeek(false);
    setCheated(false);
  }, []);

  const tapLetter = (ch) => {
    const next = (code + ch).slice(-SECRET.length);
    setCode(next);
    if (next === SECRET) {
      setCode("");
      setPeek(true);
      setCheated(true);
      Vibration.vibrate(60);
      Alert.alert("X-ray on", "Every mine is showing. This run banks nothing — restart to play for real.");
    }
  };
  const restart = () => startGame(modeKey, pendingCustom, blind, assist, sweep, smart);

  const openMenu = () => { setPendingMode(modeKey); setPendingAssist(assist); setMenuOpen(true); setPendingSmart(smart); };

  const startFromMenu = () => {
    startGame(pendingMode, pendingCustom, blind, pendingAssist, pendingSweep, pendingSmart);
    setMenuOpen(false);
  };

  const askBlind = () => {
    const on = !blind;
    Alert.alert(
      on ? "Turn on blind mode?" : "Turn off blind mode?",
      on
        ? `Flags are disabled — you dig only. This restarts the current game, and coins pay ${BLIND_MULTIPLIER}x.`
        : "Flags come back. This restarts the current game and you lose the blind bonus.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: on ? "Restart blind" : "Restart normal",
          style: on ? "destructive" : "default",
          onPress: () => { startGame(pendingMode, pendingCustom, on, pendingAssist, pendingSweep, pendingSmart); setMenuOpen(false); },
        },
      ]
    );
  };

  /* ---------- finishing a run ---------- */
  const finish = async (finalBoard, outcome, click) => {
    setStatus(outcome === "win" ? "won" : outcome === "surrender" ? "surrendered" : "lost");
// On a win, flip every mine to revealed so the board can show its type — your
    // flags turn into their bomb-type markers. A loss already revealed them; a
    // surrender leaves them hidden.
    if (outcome === "win") {
      finalBoard = finalBoard.map((x) => (x.mine ? { ...x, revealed: true } : x));
      setBoard(finalBoard);
    }
    /*
    // Endgame pass. sweepBot gets one last solve on the finished board, but with
    // global mine-counting OFF (totalMines = null) — so it can only prove a mine
    // that an adjacent number genuinely forces, never the trivial "all remaining
    // squares must be mines." Everything it proves here is an ordinary mine that
    // was only forced by the final reveal; whatever's left unproven is a true
    // ambiguity — a real UXO.
    referee(finalBoard, rows, cols, null).provenMines.forEach((i) =>
      provenEverRef.current.add(i)
    );
    */

    const scored = scoreRun({
      board: finalBoard,
      rows,
      cols,
      outcome,
      blind,
      assist,
      sweep,
      smart,
      challenge,
      provenMines: provenRef.current,
      provenEver: provenEverRef.current,
      undeducibleEver: undeducibleEverRef.current,
      mode: MODES[modeKey].label,
      time,
    });
    setBombMap(classifyMines(finalBoard, rows, cols, provenEverRef.current, undeducibleEverRef.current));
    setRun(scored);
    Vibration.vibrate(outcome === "loss" ? 200 : [0, 40, 60, 40]);

    if (cheated) {
      setRun({ ...scored, coins: 0, cheated: true });
      return;
    }

    const next = await bankRun(profile, scored, modeKey);
    setProfile(next);
  };

  const askSurrender = () => {
    if (status !== "playing" || challenge) return;
    Alert.alert(
      "Bank what you have?",
      `Surrender keeps 100% of your coins and every mine you correctly flagged — specials included. Play on and a wrong dig costs you ${Math.round((1 - PAYOUT.loss) * 100)}% of the coins, and your bombs all downgrade to plain Mines.`,
      [
        { text: "Keep digging", style: "cancel" },
        { text: "Surrender", onPress: () => finish(board, "surrender", firstClick) },
      ]
    );
  };
  // The assistant plants every flag Rule 1 proves. It never opens a square —
  // you still choose every dig yourself.
  // Flags what it can prove, then opens what that proves safe — and repeats.
  const settle = (nb) => (blind || !assist ? nb : applyAssist(nb, rows, cols, sweep, smart, mines).board);

  // The referee runs at full strength after every move, whatever the player has
  // switched on. It decides which flags are proven and which mines were stranded
  // on the coastline of a stalled board — the UXOs.
  // The referee runs at full strength after every move, whatever the player has
  // switched on. Anything it proves is, by definition, ordinary — so we remember
  // everything it ever found. What it NEVER finds is Unexploded Ordnance.
  //
  // It deliberately does not run on a finished board: once every safe square is
  // open, every remaining square is trivially a mine, and it would "prove" the
  // lot — erasing the very UXOs the player dug around to earn.
  const audit = (b) => {
    if (b.every((c) => c.revealed || c.mine)) return;
    const r = referee(b, rows, cols, mines);
    provenRef.current = r.provenMines;
    setProven(r.provenMines);
    r.provenMines.forEach((i) => provenEverRef.current.add(i));
    r.undeducible.forEach((i) => undeducibleEverRef.current.add(i));
  };

  // Latest closure, so the interval always calls a fresh finish/audit.
  endSolveRef.current = () => {
    setSolving(false);
    const b = animBoardRef.current;
    if (!b) return;
    audit(b);
    if (b.filter((x) => x.revealed && !x.mine).length === totalSafe)
      finish(b, "win", solveCtxRef.current.click);
  };

  // Route every successful dig through here. No assist → resolve instantly, as
  // before. Assist on → animate the solver's steps one at a time.
  const applyMoveResult = (nb, click) => {
    const immediate = () => {
      setBoard(nb);
      audit(nb);
      if (nb.filter((x) => x.revealed && !x.mine).length === totalSafe) finish(nb, "win", click);
    };
    if (blind || !assist) return immediate();

    const { steps } = applyAssist(nb, rows, cols, sweep, smart, mines, true);
    if (steps.length === 0) return immediate();

    stepsRef.current = steps;
    animBoardRef.current = nb.map((c) => ({ ...c }));
    solveCtxRef.current = { click };
    setBoard(animBoardRef.current);
    speedRef.current = 1;
    setSpeed(1);
    setSolving(true);
  };

  const bumpSpeed = () =>
    setSpeed((p) => { const n = p === 1 ? 2 : p === 2 ? 4 : 1; speedRef.current = n; return n; });

  const skipSolve = () => {
    const steps = stepsRef.current;
    const b = animBoardRef.current.slice();
   while (steps.length) {
      const s = steps.shift();
      if (s.t === "flag") {
        b[s.i] = { ...b[s.i], flagged: true, auto: true };
      } else {
        s.is.forEach((idx) => { b[idx] = { ...b[idx], revealed: true, flagged: false }; });
      }
    }
    animBoardRef.current = b;
    setBoard(b);
    endSolveRef.current();
  };
  /* ---------- moves ---------- */
  const reveal = (i) => {
    if (!active) return;
    let b = board;
    let click = firstClick;

    if (click === null) {
      b = placeMines(b, rows, cols, mines, i);
      click = i;
      setFirstClick(i);
      setStatus("playing");
    }

    const cell = b[i];
    if (cell.flagged) return;

    // chord: tap a satisfied number to open its remaining neighbors
    if (cell.revealed && cell.adj > 0 && !blind) {
      const ns = nbrs(i, rows, cols);
      if (ns.filter((n) => b[n].flagged).length !== cell.adj) return;

      let nb = b.map((x) => ({ ...x }));
      let boom = false;
      ns.forEach((n) => {
        if (nb[n].flagged || nb[n].revealed) return;
        if (nb[n].mine) { nb[n].revealed = true; nb[n].exploded = true; boom = true; }
        else nb = floodReveal(nb, rows, cols, n);
      });

      if (boom) {
        nb = nb.map((x) => (x.mine ? { ...x, revealed: true } : x));
        setBoard(nb);
        finish(nb, "loss", click);
      } else {
        applyMoveResult(nb, click);
      }
      return;
    }

    if (cell.revealed) return;

    if (cell.mine) {
      const nb = b.map((x, idx) => ({
        ...x,
        revealed: x.mine ? true : x.revealed,
        exploded: idx === i,
      }));
      setBoard(nb);
      finish(nb, "loss", click);
      return;
    }

    const nb = floodReveal(b, rows, cols, i);
    applyMoveResult(nb, click);
  };

  const toggleFlag = (i) => {
    if (!active || blind || board[i].revealed) return;
    if (board[i].flagged && board[i].auto) return; // proven — locked, can't unflag
    setBoard(board.map((x, idx) => (idx === i ? { ...x, flagged: !x.flagged } : x)));
    if (status === "idle") setStatus("playing");
    Vibration.vibrate(25);
  };

  const handlePress = (i) => {
    if (solving) { bumpSpeed(); return; }
    return flagMode && !blind ? toggleFlag(i) : reveal(i);
  };

  const fmt = (t) => `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
  const progress = totalSafe ? safeOpened / totalSafe : 0;
  const liveEarned = board.reduce((a, c, i) => a + (c.flagged && proven.has(i) ? 1 : 0), 0);
  const face = status === "lost" ? ":(" : status === "won" ? ":D" : status === "surrendered" ? ":|" : ":)";

  /* ---------- render ---------- */
  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />

      <View style={styles.topBar}>
        <View style={styles.header}>
          <View style={styles.titleRow}>
            {TITLE_LETTERS.map((ch, idx) => (
              <Pressable
                key={idx}
                onPress={() => tapLetter(ch)}
                style={[styles.letterBox, peek && { borderColor: C.red }]}
              >
                <Text style={[styles.letter, { color: idx >= 4 ? accent : C.text }]}>{ch}</Text>
              </Pressable>
            ))}
          </View>
          <Pressable onPress={() => setProfileOpen(true)} hitSlop={10} style={styles.wallet}>
            <View style={styles.coinDot} />
            <Text style={styles.walletText}>{profile.coins.toLocaleString()}</Text>
            <View style={[styles.mineDot, { marginLeft: 10 }]} />
            <Text style={styles.walletText}>
              {profile.bombs.mine + profile.bombs.uxo + profile.bombs.brokenArrow}
            </Text>
          </Pressable>
        </View>

        <View style={styles.statusBar}>
          <View style={styles.statusSide}>
            <View style={styles.mineDot} />
            <Text style={styles.statusText}>{blind ? mines : Math.max(0, mines - flagsPlaced)}</Text>
            {!blind && (
              <Pressable
                onPress={() => setFlagMode(!flagMode)}
                hitSlop={10}
                style={[styles.flagBtn, { borderColor: flagMode ? accent : C.line, backgroundColor: flagMode ? accent + "22" : "transparent" }]}
              >
                <View style={[styles.flagSwatch, { backgroundColor: flagMode ? accent : C.dim }]} />
              </Pressable>
            )}
          </View>

          <View style={styles.statusCenter}>
            <Pressable onPress={restart} hitSlop={12}>
              <Text style={styles.restart}>↻</Text>
            </Pressable>
            <Pressable onPress={openMenu} hitSlop={12} style={[styles.menuBtn, { borderColor: accent }]}>
              <Text style={styles.face}>{face}</Text>
            </Pressable>
          </View>

          <View style={{ alignItems: "flex-end", width: 90 }}>
            <Text style={styles.statusText}>{fmt(time)}</Text>
          </View>
        </View>

        {solving && (
          <View style={styles.solveBar}>
            <Text style={styles.solveLabel}>Assistant solving…</Text>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Pressable onPress={bumpSpeed} style={styles.solveBtn}>
                <Text style={styles.solveBtnText}>{speed}×</Text>
              </Pressable>
              <Pressable onPress={skipSolve} style={[styles.solveBtn, styles.skipBtn]}>
                <Text style={[styles.solveBtnText, { color: C.bg }]}>Skip</Text>
              </Pressable>
            </View>
          </View>
        )}
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        maximumZoomScale={6}
        minimumZoomScale={1}
        bouncesZoom
      >
        <View style={[styles.boardFrame, { borderColor: blind ? "#FFB45455" : C.line, width: boardW + 6, padding: 3 }]}>
          <View style={{ width: boardW, height: boardH, flexDirection: "row", flexWrap: "wrap", gap: GAP }}>
            {board.map((cell, i) => (
             <Cell
                key={i}
                cell={cell}
                size={cellSize}
                over={!active}
                won={status === "won"}
                onPress={() => handlePress(i)}
                onLongPress={() => toggleFlag(i)}
                peek={peek}
                bombType={bombMap[i]}
              />
            ))}
          </View>
        </View>

        <Text style={styles.hint}>
          {blind
            ? `Blind — dig only. Coins pay ${BLIND_MULTIPLIER}x.`
            : assist
              ? "Assistant on · tap to dig · pinch to zoom"
              : "Tap to dig · long-press to flag · pinch to zoom"}
        </Text>

        {/* Surrender */}
        {status === "playing" && !solving && !challenge && (
          <Pressable onPress={askSurrender} style={styles.surrenderBtn}>
            <Text style={styles.surrenderText}>Surrender & bank</Text>
          </Pressable>
        )}

        {/* Live stats */}
        <View style={styles.statsRow}>
          <View style={styles.statCard}>
            <Text style={styles.statLabel}>Safe squares opened</Text>
            <Text style={[styles.statValue, { color: accent }]}>
              {safeOpened}
              <Text style={styles.statSub}> / {totalSafe}</Text>
            </Text>
            <View style={styles.barTrack}>
              <View style={[styles.barFill, { width: `${progress * 100}%`, backgroundColor: accent }]} />
            </View>
          </View>

          {!blind && (
            <View style={styles.statCard}>
              <Text style={styles.statLabel}>Flags that count</Text>
              <Text style={styles.statValue}>
                {liveEarned}
                <Text style={styles.statSub}> / {flagsPlaced} placed</Text>
              </Text>
              <Text style={styles.statNote}>Only flags the board can prove earn credit. A guess pays nothing.</Text>
            </View>
          )}
        </View>

        {/* Result */}
        {run && (
          <View style={[styles.summary, { borderColor: run.outcome === "loss" ? C.red : accent }]}>
            <Text style={[styles.summaryTitle, { color: run.outcome === "loss" ? C.red : accent }]}>
              {run.outcome === "win" ? "Board cleared" : run.outcome === "surrender" ? "Banked" : "Boom"}
              <Text style={styles.summaryMeta}>
                {"   "}{run.mode}{run.blind ? " · Blind" : ""} · {fmt(run.time)}
              </Text>
            </Text>

            <View style={styles.payoutRow}>
              <View style={styles.coinDot} />
              <Text style={styles.payoutCoins}>+{run.coins.toLocaleString()}</Text>
              <Text style={styles.payoutMath}>
                {run.rawCoins.toLocaleString()} earned
              </Text>
            </View>

            {run.breakdown?.length > 0 && (
              <View style={styles.receipt}>
                {run.breakdown.map((b) => (
                  <View key={b.label} style={styles.receiptRow}>
                    <Text style={styles.receiptLabel}>{b.label}</Text>
                    <Text style={[styles.receiptAmt, { color: b.good ? C.green : C.red }]}>
                      {b.amount}
                    </Text>
                  </View>
                ))}
                <View style={[styles.receiptRow, styles.receiptTotal]}>
                  <Text style={[styles.receiptLabel, { color: C.text, fontWeight: "800" }]}>
                    You keep
                  </Text>
                  <Text style={[styles.receiptAmt, { color: C.gold, fontWeight: "800" }]}>
                    {Math.round(run.multiplier * 100)}%
                  </Text>
                </View>
              </View>
            )}

            <View style={styles.summaryGrid}>
              <View style={styles.summaryItem}>
                <Text style={styles.statLabel}>Safe opened</Text>
                <Text style={styles.summaryValue}>{run.safeOpened} / {totalSafe}</Text>
              </View>
            </View>

            {/* Bomb receipt — what was on the board, and what you actually keep. */}
            <View style={[styles.receipt, { marginTop: 12 }]}>
              {[
                ["mine", "Mines", C.black],
                ["brokenArrow", "Broken Arrow", C.violet],
                ["uxo", "Unexploded Ordnance", C.gold],
              ].map(([key, label, col]) => {
                const found = run.bombsFound?.[key] ?? 0;
                const kept = run.bombs[key];
                const lost = found > 0 && kept === 0;
                if (found === 0 && kept === 0) return null;
                return (
                  <View key={key} style={styles.receiptRow}>
                    <Text style={[styles.receiptLabel, { color: lost ? C.dim : col }]}>
                      {label}
                    </Text>
                    <Text style={[styles.receiptAmt, { color: lost ? C.red : col }]}>
                      {lost ? `${found} → 0` : kept}
                    </Text>
                  </View>
                );
              })}

              <View style={[styles.receiptRow, styles.receiptTotal]}>
                <Text style={[styles.receiptLabel, { color: C.text, fontWeight: "800" }]}>
                  Bombs banked
                </Text>
                <Text style={[styles.receiptAmt, { color: C.text, fontWeight: "800" }]}>
                  {run.bombTotal}
                </Text>
              </View>
            </View>

            {run.outcome === "loss" && (
              <Text style={styles.statNote}>
                Coins cut to {Math.round(PAYOUT.loss * 100)}%. Every bomb downgraded to a plain Mine.
              </Text>
            )}

            {run.bombsVoided && (
              <Text style={styles.statNote}>
                Auto-sweep found them, not you — Mines and Broken Arrows bank nothing.
              </Text>
            )}

            <Pressable onPress={restart} style={[styles.primaryBtn, { backgroundColor: accent }]}>
              <Text style={styles.primaryText}>Play again</Text>
            </Pressable>
          </View>
        )}
      </ScrollView>

      {/* ---------------- New game sheet ---------------- */}
      <Modal visible={menuOpen} transparent animationType="slide" onRequestClose={() => setMenuOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setMenuOpen(false)} />
        <View style={styles.sheet}>
          <View style={styles.grabber} />
          <Text style={styles.sheetTitle}>New game</Text>

          <View style={styles.chipRow}>
            {Object.entries(MODES).map(([key, m]) => {
              const on = pendingMode === key;
              return (
                <Pressable
                  key={key}
                  onPress={() => setPendingMode(key)}
                  style={[styles.chip, { borderColor: on ? accent : C.line, backgroundColor: on ? accent + "22" : C.bg }]}
                >
                  <Text style={[styles.chipText, { color: on ? accent : C.dim }]}>{m.label}</Text>
                  <Text style={styles.chipSize}>
                    {key === "custom" ? "your size" : `${m.rows}×${m.cols} · ${m.mines}`}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {pendingMode === "custom" && (() => {
            const mineCap = maxMinesFor(pendingCustom.rows, pendingCustom.cols);
            const density = Math.round((pendingCustom.mines / (pendingCustom.rows * pendingCustom.cols)) * 100);
            const setDim = (k, v) => {
              const next = { ...pendingCustom, [k]: v };
              next.mines = Math.min(next.mines, maxMinesFor(next.rows, next.cols));
              setPendingCustom(next);
            };
            return (
              <View style={styles.customBox}>
                {[
                  ["rows", "Rows", LIMITS.minRows, LIMITS.maxRows],
                  ["cols", "Columns", LIMITS.minCols, LIMITS.maxCols],
                  ["mines", "Mines", LIMITS.minMines, mineCap],
                ].map(([k, label, min, max]) => (
                  <View key={k} style={styles.sliderRow}>
                    <View style={styles.sliderHead}>
                      <Text style={styles.inputLabel}>{label}</Text>
                      <Text style={styles.sliderValue}>{pendingCustom[k]}</Text>
                    </View>
                    <Slider
                      minimumValue={min}
                      maximumValue={max}
                      step={1}
                      value={pendingCustom[k]}
                      onValueChange={(v) => setDim(k, Math.round(v))}
                      minimumTrackTintColor={accent}
                      maximumTrackTintColor={C.line}
                      thumbTintColor={accent}
                    />
                    <Text style={styles.sliderRange}>{min} – {max}</Text>
                  </View>
                ))}
                <Text style={styles.statNote}>
                  {pendingCustom.rows * pendingCustom.cols} squares · {density}% mine density
                  {density > 25 ? " — brutal" : density < 12 ? " — gentle" : ""}
                </Text>
              </View>
            );
          })()}

          <Pressable
            onPress={askBlind}
            style={[styles.blindBox, { borderColor: blind ? C.amber : C.line, backgroundColor: blind ? "#FFB45418" : C.bg }]}
          >
            <View style={{ flex: 1, paddingRight: 12 }}>
              <Text style={[styles.blindTitle, { color: blind ? C.amber : C.text }]}>
                {blind ? "Blind mode ON" : "Blind mode OFF"}
              </Text>
              <Text style={styles.blindSub}>No flags — dig only. Coins pay {BLIND_MULTIPLIER}x.</Text>
            </View>
            <View style={[styles.switchTrack, { backgroundColor: blind ? C.amber : C.line }]}>
              <View style={[styles.switchKnob, { left: blind ? 22 : 3 }]} />
            </View>
          </Pressable>

          <Pressable
            onPress={() => setPendingAssist(!pendingAssist)}
            disabled={blind}
            style={[styles.blindBox, {
              marginTop: 8,
              opacity: blind ? 0.4 : 1,
              borderColor: pendingAssist ? C.green : C.line,
              backgroundColor: pendingAssist ? "#5EE6B018" : C.bg,
            }
            ]}
          >
            <View style={{ flex: 1, paddingRight: 12 }}>
              <Text style={[styles.blindTitle, { color: pendingAssist ? C.green : C.text }]}>
                Auto-flag assistant
              </Text>
              <Text style={styles.blindSub}>
                {blind
                  ? "Unavailable in blind mode — there are no flags."
                  : `Plants every flag logic can prove. Costs ${Math.round((1 - ASSIST_MULTIPLIER) * 100)}% of coins.`}
              </Text>
            </View>
            <View style={[styles.switchTrack, { backgroundColor: pendingAssist ? C.green : C.line }]}>
              <View style={[styles.switchKnob, { left: pendingAssist ? 22 : 3 }]} />
            </View>
          </Pressable>
          <Pressable
            onPress={() => setPendingSweep(!pendingSweep)}
            disabled={blind || !pendingAssist}
            style={[styles.subBox, {
              opacity: blind || !pendingAssist ? 0.35 : 1,
              borderColor: pendingSweep ? C.green : C.line,
              backgroundColor: pendingSweep ? "#5EE6B012" : C.bg,
            }]}
          >
            <View style={{ flex: 1, paddingRight: 12 }}>
              <Text style={[styles.blindTitle, { fontSize: 13, color: pendingSweep ? C.green : C.text }]}>
                └ Auto-sweep
              </Text>
              <Text style={styles.blindSub}>
                Opens squares its own flags prove safe. Costs a further{" "}
                {Math.round((1 - SWEEP_MULTIPLIER) * 100)}% — and Mines and Broken Arrows
                stop paying entirely. Only UXO still banks.
              </Text>
            </View>
            <View style={[styles.switchTrack, { backgroundColor: pendingSweep ? C.green : C.line }]}>
              <View style={[styles.switchKnob, { left: pendingSweep ? 22 : 3 }]} />
            </View>
          </Pressable>
          <Pressable
            onPress={() => setPendingSmart(!pendingSmart)}
            disabled={blind || !pendingAssist || !pendingSweep}
            style={[styles.subBox, {
              marginLeft: 32,
              opacity: blind || !pendingAssist || !pendingSweep ? 0.35 : 1,
              borderColor: pendingSmart ? C.violet : C.line,
              backgroundColor: pendingSmart ? "#C99CFF12" : C.bg,
            }]}
          >
            <View style={{ flex: 1, paddingRight: 12 }}>
              <Text style={[styles.blindTitle, { fontSize: 13, color: pendingSmart ? C.violet : C.text }]}>
                └ Smart sweep
              </Text>
              <Text style={styles.blindSub}>
                Solves everything except a true 50/50. Costs a further{" "}
                {Math.round((1 - SMART_MULTIPLIER) * 100)}%.
              </Text>
            </View>
            <View style={[styles.switchTrack, { backgroundColor: pendingSmart ? C.violet : C.line }]}>
              <View style={[styles.switchKnob, { left: pendingSmart ? 22 : 3 }]} />
            </View>
          </Pressable>

          <Pressable onPress={startFromMenu} style={[styles.primaryBtn, { backgroundColor: accent, marginTop: 14 }]}>
            <Text style={styles.primaryText}>Start game</Text>
          </Pressable>

          <Pressable onPress={() => setMenuOpen(false)} style={styles.ghostBtn}>
            <Text style={styles.ghostText}>Keep playing</Text>
          </Pressable>
        </View>
      </Modal>

      {/* ---------------- Profile sheet ---------------- */}
      <Modal visible={profileOpen} transparent animationType="slide" onRequestClose={() => setProfileOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setProfileOpen(false)} />
        <View style={styles.sheet}>
          <View style={styles.grabber} />
          <Text style={styles.sheetTitle}>Profile</Text>

          <View style={styles.walletBig}>
            <View style={styles.coinDot} />
            <Text style={styles.walletBigText}>{profile.coins.toLocaleString()}</Text>
            <Text style={styles.walletBigLabel}>coins</Text>
          </View>

          <View style={styles.statsRow}>
            {[
              ["Mines", profile.bombs.mine, C.red],
              ["Broken Arrow", profile.bombs.brokenArrow, C.violet],
              ["Unexploded Ordnance", profile.bombs.uxo, C.gold],
            ].map(([label, n, col]) => (
              <View key={label} style={styles.statCard}>
                <Text style={[styles.statLabel, { color: col }]}>{label}</Text>
                <Text style={[styles.statValue, { color: col }]}>{n}</Text>
              </View>
            ))}
          </View>

          <View style={[styles.statsRow, { marginTop: 8 }]}>
            <View style={styles.statCard}>
              <Text style={styles.statLabel}>Games</Text>
              <Text style={styles.statValue}>{profile.games}</Text>
            </View>
            <View style={styles.statCard}>
              <Text style={styles.statLabel}>Won</Text>
              <Text style={styles.statValue}>{profile.wins}</Text>
            </View>
            <View style={styles.statCard}>
              <Text style={styles.statLabel}>Banked</Text>
              <Text style={styles.statValue}>{profile.surrenders}</Text>
            </View>
          </View>

          {Object.keys(profile.bestTime).length > 0 && (
            <View style={{ marginTop: 14 }}>
              <Text style={styles.statLabel}>Best times</Text>
              {Object.entries(profile.bestTime).map(([k, t]) => (
                <View key={k} style={styles.bestRow}>
                  <Text style={styles.bestMode}>{MODES[k]?.label || k}</Text>
                  <Text style={styles.bestTime}>{fmt(t)}</Text>
                </View>
              ))}
            </View>
          )}

          <Pressable
            onPress={() =>
              Alert.alert("Reset profile?", "Coins, bombs, and best times are all erased. This cannot be undone.", [
                { text: "Cancel", style: "cancel" },
                { text: "Erase", style: "destructive", onPress: () => resetProfile().then(setProfile) },
              ])
            }
            style={styles.ghostBtn}
          >
            <Text style={[styles.ghostText, { color: C.red }]}>Reset profile</Text>
          </Pressable>

          <Pressable onPress={() => setProfileOpen(false)} style={[styles.primaryBtn, { backgroundColor: accent, marginTop: 0 }]}>
            <Text style={styles.primaryText}>Close</Text>
          </Pressable>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

/* ------------------------------------------------------------------ */

const styles = StyleSheet.create({
  solveBar: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    backgroundColor: C.panel, borderRadius: 12, borderWidth: 1, borderColor: C.green,
    paddingVertical: 8, paddingHorizontal: 12, marginTop: 10, marginBottom: 0,
  },
  solveLabel: { color: C.green, fontSize: 12, fontWeight: "700" },
  solveBtn: {
    minWidth: 46, alignItems: "center", borderRadius: 8, borderWidth: 1,
    borderColor: C.green, paddingVertical: 6, paddingHorizontal: 10,
  },
  solveBtnText: { color: C.green, fontSize: 13, fontWeight: "800", fontFamily: MONO },
  skipBtn: { backgroundColor: C.green, borderColor: C.green },
  safe: { flex: 1, backgroundColor: C.bg },
  scroll: { paddingHorizontal: 4, paddingTop: 10, paddingBottom: 44 },
  topBar: {
    paddingHorizontal: 14, paddingTop: 12, paddingBottom: 10,
    backgroundColor: C.bg, borderBottomWidth: 1, borderBottomColor: C.line,
  },

  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  titleRow: { flexDirection: "row" },
  letterBox: {
    width: 21, height: 27, borderRadius: 5, borderWidth: 1, borderColor: C.line,
    backgroundColor: C.panel, alignItems: "center", justifyContent: "center", marginRight: 2,
  },
  letter: { fontSize: 12, fontWeight: "800", fontFamily: MONO },
  wallet: {
    flexDirection: "row", alignItems: "center", gap: 5,
    backgroundColor: C.panel, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6,
  },
  walletText: { color: C.text, fontSize: 13, fontWeight: "800", fontFamily: MONO },
  coinDot: { width: 11, height: 11, borderRadius: 6, backgroundColor: C.gold },
  mineDot: { width: 11, height: 11, borderRadius: 6, backgroundColor: C.red },

  statusBar: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    backgroundColor: C.panel, borderRadius: 12, paddingVertical: 8, paddingHorizontal: 14,
  },
  statusSide: { flexDirection: "row", alignItems: "center", gap: 6, width: 90 },
  statusCenter: { flexDirection: "row", alignItems: "center", gap: 18 },
  statusText: { color: C.text, fontSize: 15, fontFamily: MONO, fontWeight: "700" },
  restart: { color: C.dim, fontSize: 24, fontWeight: "700" },
  menuBtn: { borderWidth: 1, borderRadius: 20, paddingHorizontal: 9, paddingVertical: 3 },
  face: { fontSize: 17, fontWeight: "800", color: C.text, fontFamily: MONO },
  flagBtn: { width: 26, height: 26, borderRadius: 8, borderWidth: 1, alignItems: "center", justifyContent: "center", marginLeft: 4 },
  flagSwatch: { width: 11, height: 11, borderRadius: 2 },

  boardFrame: {
    backgroundColor: C.panel, borderRadius: 14, borderWidth: 1,
    alignSelf: "center", overflow: "hidden", flexGrow: 0,
  },
  cell: { alignItems: "center", justifyContent: "center", borderTopWidth: 1, overflow: "hidden" },
  hint: { color: C.dim, fontSize: 11, textAlign: "center", marginTop: 10, marginBottom: 10 },

  surrenderBtn: {
    borderWidth: 1, borderColor: C.line, borderRadius: 10,
    paddingVertical: 11, alignItems: "center", marginBottom: 10,
  },
  surrenderText: { color: C.gold, fontSize: 13, fontWeight: "800" },

  statsRow: { flexDirection: "row", gap: 8 },
  statCard: { flex: 1, backgroundColor: C.panel, borderRadius: 12, padding: 12 },
  statLabel: { color: C.dim, fontSize: 11 },
  statValue: { color: C.text, fontSize: 20, fontWeight: "800", fontFamily: MONO, marginTop: 2 },
  statSub: { color: C.dim, fontSize: 12, fontWeight: "400" },
  statNote: { color: C.dim, fontSize: 10, marginTop: 8, lineHeight: 13 },
  barTrack: { height: 4, backgroundColor: C.line, borderRadius: 2, marginTop: 8, overflow: "hidden" },
  barFill: { height: 4, borderRadius: 2 },

  summary: { marginTop: 12, backgroundColor: C.panel, borderWidth: 1, borderRadius: 14, padding: 16 },
  summaryTitle: { fontSize: 16, fontWeight: "800", marginBottom: 12 },
  summaryMeta: { color: C.dim, fontSize: 12, fontWeight: "400" },
  payoutRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 14 },
  payoutCoins: { color: C.gold, fontSize: 26, fontWeight: "800", fontFamily: MONO },
  payoutMath: { color: C.dim, fontSize: 11, fontFamily: MONO },
  receipt: { backgroundColor: C.bg, borderRadius: 10, padding: 12, marginBottom: 14 },
  receiptRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 3 },
  receiptLabel: { color: C.dim, fontSize: 12 },
  receiptAmt: { fontSize: 12, fontFamily: MONO, fontWeight: "700" },
  receiptTotal: { borderTopWidth: 1, borderTopColor: C.line, marginTop: 6, paddingTop: 8 },
  summaryGrid: { flexDirection: "row", flexWrap: "wrap", gap: 14 },
  summaryItem: { minWidth: 110 },
  summaryValue: { color: C.text, fontSize: 15, fontFamily: MONO, fontWeight: "700", marginTop: 2 },

  primaryBtn: { marginTop: 14, paddingVertical: 13, borderRadius: 10, alignItems: "center" },
  primaryText: { color: C.bg, fontWeight: "800", fontSize: 15 },
  ghostBtn: { paddingVertical: 12, alignItems: "center" },
  ghostText: { color: C.dim, fontSize: 13, fontWeight: "600" },

  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)" },
  sheet: {
    backgroundColor: C.panel, borderTopLeftRadius: 22, borderTopRightRadius: 22,
    padding: 18, paddingBottom: 34, borderTopWidth: 1, borderColor: C.line,
  },
  grabber: { width: 38, height: 4, borderRadius: 2, backgroundColor: C.line, alignSelf: "center", marginBottom: 14 },
  sheetTitle: { color: C.text, fontSize: 18, fontWeight: "800", marginBottom: 12 },

  walletBig: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: C.bg, borderRadius: 12, padding: 14, marginBottom: 10,
  },
  walletBigText: { color: C.gold, fontSize: 28, fontWeight: "800", fontFamily: MONO },
  walletBigLabel: { color: C.dim, fontSize: 12 },

  bestRow: {
    flexDirection: "row", justifyContent: "space-between",
    paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.line,
  },
  bestMode: { color: C.text, fontSize: 13, fontWeight: "600" },
  bestTime: { color: C.dim, fontSize: 13, fontFamily: MONO },

  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12 },
  chip: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 12, borderWidth: 1, minWidth: 104 },
  chipText: { fontSize: 14, fontWeight: "700" },
  chipSize: { color: C.dim, fontSize: 10, fontFamily: MONO, marginTop: 2 },

  customBox: { marginBottom: 12 },
  sliderRow: { marginBottom: 6 },
  sliderHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  inputLabel: { color: C.dim, fontSize: 11, marginBottom: 4 },
  sliderValue: { color: C.text, fontSize: 16, fontWeight: "800", fontFamily: MONO },
  sliderRange: { color: C.dim, fontSize: 10, fontFamily: MONO, textAlign: "right", marginTop: -4 },

  blindBox: { flexDirection: "row", alignItems: "center", borderWidth: 1, borderRadius: 12, padding: 14 },
  subBox: {
    flexDirection: "row", alignItems: "center", borderWidth: 1, borderRadius: 12,
    padding: 12, marginTop: 6, marginLeft: 16,
  },
  blindTitle: { fontSize: 14, fontWeight: "800" },
  blindSub: { color: C.dim, fontSize: 11.5, marginTop: 3 },
  switchTrack: { width: 44, height: 24, borderRadius: 12, justifyContent: "center" },
  switchKnob: { position: "absolute", width: 18, height: 18, borderRadius: 9, backgroundColor: C.bg },
});