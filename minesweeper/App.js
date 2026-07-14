import React, { useState, useEffect, useCallback } from "react";
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
  isFlagEarned,
  EMPTY_PROFILE,
  PAYOUT,
  BLIND_MULTIPLIER,
} from "./reward";

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

const MODES = {
  easy: { label: "Easy", rows: 9, cols: 9, mines: 10 },
  medium: { label: "Medium", rows: 16, cols: 16, mines: 40 },
  hard: { label: "Hard", rows: 30, cols: 16, mines: 160 },
  extreme: { label: "Extreme", rows: 30, cols: 24, mines: 160 },
  custom: { label: "Custom", rows: 12, cols: 12, mines: 24 },
};

const LIMITS = { minRows: 9, maxRows: 40, minCols: 9, maxCols: 30, minMines: 10, maxMines: 280 };

// A board needs breathing room: the first click and its 8 neighbors are always
// safe, and past ~40% density the board stops being solvable by deduction.
const maxMinesFor = (r, c) =>
  Math.max(LIMITS.minMines, Math.min(LIMITS.maxMines, Math.floor(r * c * 0.4), r * c - 10));

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

const countEarnedFlags = (board, rows, cols) =>
  board.reduce((acc, cell, i) => acc + (cell.mine && isFlagEarned(board, i, rows, cols) ? 1 : 0), 0);

/* ------------------------------------------------------------------ */
/*  Cell                                                               */
/* ------------------------------------------------------------------ */

const Cell = React.memo(function Cell({ cell, size, over, peek, onPress, onLongPress }) {
  const showMine = cell.revealed && cell.mine;
  const wrongFlag = over && cell.flagged && !cell.mine;

  let bg = C.cellUp;
  if (cell.exploded) bg = C.red;
  else if (showMine) bg = C.mineBg;
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
          borderTopColor: cell.revealed ? "transparent" : "rgba(255,255,255,0.10)",
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

      {/* Glyph-free markers — no font can fail to render a shape. */}
      {!cell.revealed && cell.flagged && !wrongFlag && (
        <View style={{ width: size * 0.5, height: size * 0.5, borderRadius: 2, backgroundColor: C.amber }} />
      )}
      {wrongFlag && (
        <View style={{ width: size * 0.5, height: size * 0.5, borderRadius: 2, backgroundColor: C.red, opacity: 0.5 }} />
      )}
      {showMine && (
        <View style={{ width: size * 0.5, height: size * 0.5, borderRadius: size, backgroundColor: cell.exploded ? "#12151C" : C.red }} />
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
  const [config, setConfig] = useState({ rows: 9, cols: 9, mines: 10 });
  const [board, setBoard] = useState(() => makeEmptyBoard(9, 9));
  const [firstClick, setFirstClick] = useState(null);
  const [status, setStatus] = useState("idle"); // idle | playing | won | lost | surrendered
  const [flagMode, setFlagMode] = useState(false);
  const [time, setTime] = useState(0);
  const [run, setRun] = useState(null); // scored result of the finished game

  // profile
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
  const accent = blind ? C.amber : C.green;

  useEffect(() => { loadProfile().then(setProfile); }, []);

  useEffect(() => {
    if (status !== "playing") return;
    const id = setInterval(() => setTime((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [status]);

  /* ---------- sizing: the board always fits the width ---------- */
  const boardMaxW = Math.min(SCREEN_W, 640) - 28 - 12;
  const cellSize = Math.max(6, Math.floor((boardMaxW - GAP * (cols - 1)) / cols));
  const boardW = cols * cellSize + GAP * (cols - 1);
  const boardH = rows * cellSize + GAP * (rows - 1);

  /* ---------- lifecycle ---------- */
  const startGame = useCallback((key, customRaw, blindOn) => {
    const base = key === "custom" ? clampCustom(customRaw) : MODES[key];
    setModeKey(key);
    setBlind(blindOn);
    setConfig({ rows: base.rows, cols: base.cols, mines: base.mines });
    setBoard(makeEmptyBoard(base.rows, base.cols));
    setFirstClick(null);
    setStatus("idle");
    setFlagMode(false);
    setTime(0);
    setRun(null);
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
  const restart = () => startGame(modeKey, pendingCustom, blind);

  const openMenu = () => { setPendingMode(modeKey); setMenuOpen(true); };

  const startFromMenu = () => {
    startGame(pendingMode, pendingCustom, blind);
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
          onPress: () => { startGame(pendingMode, pendingCustom, on); setMenuOpen(false); },
        },
      ]
    );
  };

  /* ---------- finishing a run ---------- */
  const finish = async (finalBoard, outcome, click) => {
    setStatus(outcome === "win" ? "won" : outcome === "surrender" ? "surrendered" : "lost");

    const scored = scoreRun({
      board: finalBoard,
      rows,
      cols,
      outcome,
      blind,
      firstClick: click,
      mode: MODES[modeKey].label,
      time,
    });

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
    if (status !== "playing") return;
    Alert.alert(
      "Bank what you have?",
      `Surrender keeps 100% of your coins and every mine you correctly flagged — specials included. Play on and a wrong dig costs you ${Math.round((1 - PAYOUT.loss) * 100)}% of the coins, and your bombs all downgrade to plain Mines.`,
      [
        { text: "Keep digging", style: "cancel" },
        { text: "Surrender", onPress: () => finish(board, "surrender", firstClick) },
      ]
    );
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
        setBoard(nb);
        if (nb.filter((x) => x.revealed && !x.mine).length === totalSafe) finish(nb, "win", click);
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
    setBoard(nb);
    if (nb.filter((x) => x.revealed && !x.mine).length === totalSafe) finish(nb, "win", click);
  };

  const toggleFlag = (i) => {
    if (!active || blind || board[i].revealed) return;
    setBoard(board.map((x, idx) => (idx === i ? { ...x, flagged: !x.flagged } : x)));
    if (status === "idle") setStatus("playing");
    Vibration.vibrate(25);
  };

  const handlePress = (i) => (flagMode && !blind ? toggleFlag(i) : reveal(i));

  const fmt = (t) => `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
  const progress = totalSafe ? safeOpened / totalSafe : 0;
  const liveEarned = countEarnedFlags(board, rows, cols);
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
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        maximumZoomScale={6}
        minimumZoomScale={1}
        bouncesZoom
      >
        <View style={[styles.boardFrame, { borderColor: blind ? "#FFB45455" : C.line, width: boardW + 10, padding: 5 }]}>
          <View style={{ width: boardW, height: boardH, flexDirection: "row", flexWrap: "wrap", gap: GAP }}>
            {board.map((cell, i) => (
              <Cell
                key={i}
                cell={cell}
                size={cellSize}
                over={!active}
                onPress={() => handlePress(i)}
                onLongPress={() => toggleFlag(i)}
                peek={peek}
              />
            ))}
          </View>
        </View>

        <Text style={styles.hint}>
          {blind
            ? `Blind — dig only. Coins pay ${BLIND_MULTIPLIER}x.`
            : "Tap to dig · long-press to flag · pinch to zoom"}
        </Text>

        {/* Surrender */}
        {status === "playing" && (
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
              <Text style={styles.statNote}>Only flags touching an opened square earn credit.</Text>
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
                {run.rawCoins.toLocaleString()} × {run.multiplier}
              </Text>
            </View>

            <View style={styles.summaryGrid}>
              <View style={styles.summaryItem}>
                <Text style={styles.statLabel}>Safe opened</Text>
                <Text style={styles.summaryValue}>{run.safeOpened} / {totalSafe}</Text>
              </View>
              <View style={styles.summaryItem}>
                <Text style={styles.statLabel}>Mines</Text>
                <Text style={styles.summaryValue}>{run.bombs.mine}</Text>
              </View>
              {run.bombs.brokenArrow > 0 && (
                <View style={styles.summaryItem}>
                  <Text style={[styles.statLabel, { color: C.violet }]}>Broken Arrow</Text>
                  <Text style={[styles.summaryValue, { color: C.violet }]}>{run.bombs.brokenArrow}</Text>
                </View>
              )}
              {run.bombs.uxo > 0 && (
                <View style={styles.summaryItem}>
                  <Text style={[styles.statLabel, { color: C.gold }]}>Unexploded Ordnance</Text>
                  <Text style={[styles.summaryValue, { color: C.gold }]}>{run.bombs.uxo}</Text>
                </View>
              )}
            </View>

            {run.outcome === "loss" && (
              <Text style={styles.statNote}>
                Coins cut to {Math.round(PAYOUT.loss * 100)}%. Every bomb downgraded to a plain Mine.
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
  safe: { flex: 1, backgroundColor: C.bg },
  scroll: { paddingHorizontal: 14, paddingTop: 12, paddingBottom: 44 },
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
  blindTitle: { fontSize: 14, fontWeight: "800" },
  blindSub: { color: C.dim, fontSize: 11.5, marginTop: 3 },
  switchTrack: { width: 44, height: 24, borderRadius: 12, justifyContent: "center" },
  switchKnob: { position: "absolute", width: 18, height: 18, borderRadius: 9, backgroundColor: C.bg },
});