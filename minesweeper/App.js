import React, { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  TextInput,
  StyleSheet,
  SafeAreaView,
  StatusBar,
  Vibration,
  Platform,
  Modal,
  Alert,
  useWindowDimensions,
} from "react-native";

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

const LIMITS = { minRows: 5, maxRows: 40, minCols: 5, maxCols: 30, minMines: 1, maxMines: 280 };

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
  mineBg: "#3A2430",
};

const NUM_COLORS = ["", "#6FB7FF", "#5EE6B0", "#FF7B7B", "#C99CFF", "#FFB454", "#4FD8D8", "#F0F3FA", "#9AA3B5"];
const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });
const GAP = 2;

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

function placeMines(board, rows, cols, mineCount, safeIndex) {
  const next = board.map((c) => ({ ...c }));
  const safeZone = new Set([safeIndex, ...nbrs(safeIndex, rows, cols)]);

  let pool = next.map((_, i) => i).filter((i) => !safeZone.has(i));
  if (pool.length < mineCount) pool = next.map((_, i) => i).filter((i) => i !== safeIndex);

  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  pool.slice(0, mineCount).forEach((i) => { next[i].mine = true; });

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

/**
 * A flag only earns credit if it was actually deduced — meaning it touches at
 * least one opened safe square. Blanket-flagging the whole board earns nothing.
 */
const isFlagEarned = (board, i, rows, cols) =>
  board[i].flagged && nbrs(i, rows, cols).some((n) => board[n].revealed && !board[n].mine);

const countEarnedFlags = (board, rows, cols) =>
  board.reduce((acc, cell, i) => acc + (cell.mine && isFlagEarned(board, i, rows, cols) ? 1 : 0), 0);

/* ------------------------------------------------------------------ */
/*  Cell                                                               */
/* ------------------------------------------------------------------ */

const Cell = React.memo(function Cell({ cell, size, over, onPress, onLongPress }) {
  const showMine = cell.revealed && cell.mine;
  const wrongFlag = over && cell.flagged && !cell.mine;

  let bg = C.cellUp;
  if (cell.exploded) bg = C.red;
  else if (showMine) bg = C.mineBg;
  else if (cell.revealed) bg = C.cellDown;

  const isNumber = cell.revealed && !cell.mine && cell.adj > 0;
  let label = "";
  if (wrongFlag) label = "✕";
  else if (cell.flagged) label = "🚩";
  else if (showMine) label = "💣";
  else if (isNumber) label = String(cell.adj);

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
      {label !== "" && (
        <Text
          allowFontScaling={false}
          style={{
            fontSize: size * (isNumber ? 0.6 : 0.55),
            lineHeight: size,
            fontWeight: "800",
            color: wrongFlag ? C.red : isNumber ? NUM_COLORS[cell.adj] : C.text,
            // emoji don't exist in Menlo — only numbers get the mono face
            fontFamily: isNumber ? MONO : undefined,
          }}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
});

/* ------------------------------------------------------------------ */
/*  App                                                                */
/* ------------------------------------------------------------------ */

const strFrom = (o) => ({ rows: String(o.rows), cols: String(o.cols), mines: String(o.mines) });

const clampCustom = (raw) => {
  const r = Math.max(LIMITS.minRows, Math.min(LIMITS.maxRows, parseInt(raw.rows, 10) || 12));
  const c = Math.max(LIMITS.minCols, Math.min(LIMITS.maxCols, parseInt(raw.cols, 10) || 12));
  const m = Math.max(LIMITS.minMines, Math.min(LIMITS.maxMines, r * c - 10, parseInt(raw.mines, 10) || 10));
  return { rows: r, cols: c, mines: m };
};

export default function App() {
  const { width: SCREEN_W, height: SCREEN_H } = useWindowDimensions();

  // live game
  const [modeKey, setModeKey] = useState("easy");
  const [blind, setBlind] = useState(false);
  const [config, setConfig] = useState({ rows: 9, cols: 9, mines: 10 });
  const [board, setBoard] = useState(() => makeEmptyBoard(9, 9));
  const [minesPlaced, setMinesPlaced] = useState(false);
  const [status, setStatus] = useState("idle"); // idle | playing | won | lost
  const [flagMode, setFlagMode] = useState(false);
  const [time, setTime] = useState(0);
  const [summary, setSummary] = useState(null);

  // menu — selections stay pending until Start
  const [menuOpen, setMenuOpen] = useState(false);
  const [pendingMode, setPendingMode] = useState("easy");
  const [pendingCustom, setPendingCustom] = useState({ rows: "12", cols: "12", mines: "24" });

  const { rows, cols, mines } = config;
  const totalSafe = rows * cols - mines;
  const safeOpened = board.filter((c) => c.revealed && !c.mine).length;
  const flagsPlaced = board.filter((c) => c.flagged).length;
  const active = status === "idle" || status === "playing";
  const accent = blind ? C.amber : C.green;

  useEffect(() => {
    if (status !== "playing") return;
    const id = setInterval(() => setTime((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [status]);

  /* ---------- sizing: the whole board always fits the screen ---------- */
  const boardMaxW = Math.min(SCREEN_W, 640) - 28 - 12;
  const cellSize = Math.max(6, Math.floor((boardMaxW - GAP * (cols - 1)) / cols));
  const boardW = cols * cellSize + GAP * (cols - 1);
  const boardH = rows * cellSize + GAP * (rows - 1);

  /* ---------- lifecycle ---------- */
  const startGame = useCallback((key, customRaw, blindOn) => {
    const base = key === "custom" ? clampCustom(customRaw) : MODES[key];
    const r = base.rows;
    const c = base.cols;
    const m = Math.min(base.mines, r * c - 10);
    setModeKey(key);
    setBlind(blindOn);
    setConfig({ rows: r, cols: c, mines: m });
    setBoard(makeEmptyBoard(r, c));
    setMinesPlaced(false);
    setStatus("idle");
    setFlagMode(false);
    setTime(0);
    setSummary(null);
  }, []);

  const restart = () => startGame(modeKey, pendingCustom, blind);

  const openMenu = () => {
    setPendingMode(modeKey);
    setMenuOpen(true);
  };

  const startFromMenu = () => {
    const raw = pendingMode === "custom" ? strFrom(clampCustom(pendingCustom)) : pendingCustom;
    if (pendingMode === "custom") setPendingCustom(raw);
    startGame(pendingMode, raw, blind);
    setMenuOpen(false);
  };

  const askBlind = () => {
    const turningOn = !blind;
    Alert.alert(
      turningOn ? "Turn on blind mode?" : "Turn off blind mode?",
      turningOn
        ? "Flags are disabled — you dig only. This restarts the current game, and blind runs pay a better reward."
        : "Flags come back. This restarts the current game and you lose the blind bonus.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: turningOn ? "Restart blind" : "Restart normal",
          style: turningOn ? "destructive" : "default",
          onPress: () => {
            const raw = pendingMode === "custom" ? strFrom(clampCustom(pendingCustom)) : pendingCustom;
            startGame(pendingMode, raw, turningOn);
            setMenuOpen(false);
          },
        },
      ]
    );
  };

  /* ---------- moves ---------- */
  const finish = (finalBoard, won) => {
    setStatus(won ? "won" : "lost");
    setSummary({
      won,
      opened: finalBoard.filter((c) => c.revealed && !c.mine).length,
      totalSafe,
      earnedFlags: countEarnedFlags(finalBoard, rows, cols),
      mineFlags: finalBoard.filter((c) => c.flagged && c.mine).length,
      wrongFlags: finalBoard.filter((c) => c.flagged && !c.mine).length,
      time,
      blind,
      mode: MODES[modeKey].label,
      mines,
    });
    Vibration.vibrate(won ? [0, 40, 60, 40] : 200);
  };

  const reveal = (i) => {
    if (!active) return;
    let b = board;

    if (!minesPlaced) {
      b = placeMines(b, rows, cols, mines, i);
      setMinesPlaced(true);
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
        finish(nb, false);
      } else {
        setBoard(nb);
        if (nb.filter((x) => x.revealed && !x.mine).length === totalSafe) finish(nb, true);
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
      finish(nb, false);
      return;
    }

    const nb = floodReveal(b, rows, cols, i);
    setBoard(nb);
    if (nb.filter((x) => x.revealed && !x.mine).length === totalSafe) finish(nb, true);
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

  /* ---------- render ---------- */
  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />
      <View style={styles.topBar}>

        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>
            MINE<Text style={{ color: accent }}>SWEEP</Text>
          </Text>
          <Text style={styles.headerMeta}>
            {MODES[modeKey].label}{blind ? " · Blind" : ""} · {rows}×{cols} · {mines}
          </Text>
        </View>

        {/* Status bar — the smiley opens the menu */}
        {/* Fixed top bar */}
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
                <Text style={[styles.flagBtnText, { color: flagMode ? accent : C.dim }]}>F</Text>
              </Pressable>
            )}
          </View>

          <View style={styles.statusCenter}>
            <Pressable onPress={restart} hitSlop={12}>
              <Text style={styles.restart}>↻</Text>
            </Pressable>
            <Pressable onPress={openMenu} hitSlop={12} style={[styles.menuBtn, { borderColor: accent }]}>
              <Text style={styles.face}>
                {status === "lost" ? ":(" : status === "won" ? ":D" : ":)"}
              </Text>
            </Pressable>
          </View>

          <View style={{ alignItems: "flex-end", width: 90 }}>
            <Text style={styles.statusText}>{fmt(time)}</Text>
          </View>
        </View>

        {/* Board — always fits the width; pinch to zoom in */}
        <View
          style={[styles.boardFrame, { borderColor: blind ? "#FFB45455" : C.line, width: boardW + 10, padding: 5 }]}
        >
          <View style={{ width: boardW, height: boardH, flexDirection: "row", flexWrap: "wrap", gap: GAP }}>
            {board.map((cell, i) => (
              <Cell
                key={i}
                cell={cell}
                size={cellSize}
                over={!active}
                onPress={() => handlePress(i)}
                onLongPress={() => toggleFlag(i)}
              />
            ))}
          </View>
        </View>

        <Text style={styles.hint}>
          {blind
            ? "Blind mode — dig only, no flags. Pinch to zoom in."
            : "Tap to dig · long-press to flag · pinch to zoom in"}
        </Text>


        {/* Stats — below the grid */}
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

        {/* Game over */}
        {summary && (
          <View style={[styles.summary, { borderColor: summary.won ? accent : C.red }]}>
            <Text style={[styles.summaryTitle, { color: summary.won ? accent : C.red }]}>
              {summary.won ? "✓ Board cleared" : "✗ Boom"}
              <Text style={styles.summaryMeta}>
                {"   "}{summary.mode}{summary.blind ? " · Blind" : ""} · {fmt(summary.time)}
              </Text>
            </Text>

            <View style={styles.summaryGrid}>
              <View style={styles.summaryItem}>
                <Text style={styles.statLabel}>Safe opened</Text>
                <Text style={styles.summaryValue}>{summary.opened} / {summary.totalSafe}</Text>
              </View>

              {!summary.blind ? (
                <>
                  <View style={styles.summaryItem}>
                    <Text style={styles.statLabel}>Mines correctly pinged</Text>
                    <Text style={styles.summaryValue}>{summary.earnedFlags} / {summary.mines}</Text>
                  </View>
                  <View style={styles.summaryItem}>
                    <Text style={styles.statLabel}>Wrong flags</Text>
                    <Text style={styles.summaryValue}>{summary.wrongFlags}</Text>
                  </View>
                  {summary.mineFlags > summary.earnedFlags && (
                    <View style={styles.summaryItem}>
                      <Text style={styles.statLabel}>Guessed flags (no credit)</Text>
                      <Text style={styles.summaryValue}>{summary.mineFlags - summary.earnedFlags}</Text>
                    </View>
                  )}
                </>
              ) : (
                <View style={styles.summaryItem}>
                  <Text style={[styles.statLabel, { color: C.amber }]}>Blind bonus</Text>
                  <Text style={styles.summaryValue}>Eligible ✦</Text>
                </View>
              )}
            </View>

            <Pressable onPress={restart} style={[styles.primaryBtn, { backgroundColor: accent }]}>
              <Text style={styles.primaryText}>Play again</Text>
            </Pressable>
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
      </ScrollView>

      {/* ---------------- Menu sheet ---------------- */}
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

          {pendingMode === "custom" && (
            <View style={styles.customBox}>
              {[["rows", "Rows 5–40"], ["cols", "Cols 5–30"], ["mines", "Mines 1–280"]].map(([k, label]) => (
                <View key={k} style={{ flex: 1 }}>
                  <Text style={styles.inputLabel}>{label}</Text>
                  <TextInput
                    value={pendingCustom[k]}
                    onChangeText={(v) => setPendingCustom({ ...pendingCustom, [k]: v.replace(/[^0-9]/g, "") })}
                    keyboardType="number-pad"
                    style={styles.input}
                  />
                </View>
              ))}
            </View>
          )}

          <Pressable
            onPress={askBlind}
            style={[styles.blindBox, { borderColor: blind ? C.amber : C.line, backgroundColor: blind ? "#FFB45418" : C.bg }]}
          >
            <View style={{ flex: 1, paddingRight: 12 }}>
              <Text style={[styles.blindTitle, { color: blind ? C.amber : C.text }]}>
                {blind ? "Blind mode ON" : "Blind mode OFF"}
              </Text>
              <Text style={styles.blindSub}>No flags — dig only. Pays a better reward.</Text>
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
    </SafeAreaView>
  );
}

/* ------------------------------------------------------------------ */

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  scroll: { padding: 14, paddingBottom: 44 },

  header: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12 },
  title: { color: C.text, fontSize: 22, fontWeight: "800", letterSpacing: 1 },
  headerMeta: { color: C.dim, fontSize: 11, fontFamily: MONO },

  statusBar: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    backgroundColor: C.panel, borderRadius: 12, paddingVertical: 8, paddingHorizontal: 14, marginBottom: 10,
  },
  statusSide: { flexDirection: "row", alignItems: "center", gap: 6, width: 80 },
  statusCenter: { flexDirection: "row", alignItems: "center", gap: 18 },
  emoji: { fontSize: 15 },
  statusText: { color: C.text, fontSize: 15, fontFamily: MONO, fontWeight: "700" },
  restart: { color: C.dim, fontSize: 24, fontWeight: "700" },
  menuBtn: { borderWidth: 1, borderRadius: 20, paddingHorizontal: 9, paddingVertical: 3 },

  boardFrame: {
    backgroundColor: C.panel, borderRadius: 14, borderWidth: 1,
    alignSelf: "center", overflow: "hidden", flexGrow: 0,
  },
  cell: { alignItems: "center", justifyContent: "center", borderTopWidth: 1, overflow: "hidden" },

  hint: { color: C.dim, fontSize: 11, textAlign: "center", marginTop: 10, marginBottom: 10 },

  toolRow: { flexDirection: "row", gap: 6, marginBottom: 10 },
  toolBtn: { flex: 1, alignItems: "center", paddingVertical: 11, borderRadius: 10, borderWidth: 1 },
  toolText: { fontSize: 13, fontWeight: "800" },

  statsRow: { flexDirection: "row", gap: 8 },
  statCard: { flex: 1, backgroundColor: C.panel, borderRadius: 12, padding: 12 },
  statLabel: { color: C.dim, fontSize: 11 },
  statValue: { color: C.text, fontSize: 20, fontWeight: "800", fontFamily: MONO, marginTop: 2 },
  statSub: { color: C.dim, fontSize: 12, fontWeight: "400" },
  statNote: { color: C.dim, fontSize: 10, marginTop: 6, lineHeight: 13 },
  barTrack: { height: 4, backgroundColor: C.line, borderRadius: 2, marginTop: 8, overflow: "hidden" },
  barFill: { height: 4, borderRadius: 2 },

  summary: { marginTop: 12, backgroundColor: C.panel, borderWidth: 1, borderRadius: 14, padding: 16 },
  summaryTitle: { fontSize: 16, fontWeight: "800", marginBottom: 12 },
  summaryMeta: { color: C.dim, fontSize: 12, fontWeight: "400" },
  summaryGrid: { flexDirection: "row", flexWrap: "wrap", gap: 14 },
  summaryItem: { minWidth: 120 },
  summaryValue: { color: C.text, fontSize: 14, fontFamily: MONO, fontWeight: "700", marginTop: 2 },

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

  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12 },
  chip: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 12, borderWidth: 1, minWidth: 104 },
  chipText: { fontSize: 14, fontWeight: "700" },
  chipSize: { color: C.dim, fontSize: 10, fontFamily: MONO, marginTop: 2 },

  customBox: { flexDirection: "row", gap: 8, marginBottom: 12 },
  inputLabel: { color: C.dim, fontSize: 11, marginBottom: 4 },
  input: {
    borderWidth: 1, borderColor: C.line, backgroundColor: C.bg, color: C.text,
    borderRadius: 8, paddingHorizontal: 10, paddingVertical: 9, fontSize: 15,
  },

  blindBox: { flexDirection: "row", alignItems: "center", borderWidth: 1, borderRadius: 12, padding: 14 },
  blindTitle: { fontSize: 14, fontWeight: "800" },
  blindSub: { color: C.dim, fontSize: 11.5, marginTop: 3 },
  switchTrack: { width: 44, height: 24, borderRadius: 12, justifyContent: "center" },
  switchKnob: { position: "absolute", width: 18, height: 18, borderRadius: 9, backgroundColor: C.bg },
});