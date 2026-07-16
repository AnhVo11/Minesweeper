# Minesweep

Minesweeper with a difficulty dial that costs you money.

Three assistants can play the board for you — and the more you lean on them, the
less a run is worth. Turn them all on and you earn exactly nothing. Turn them all
off, go in blind, and every square is yours.

Built with React Native (Expo). iOS-first; Android mostly works.

---

## Running it

Requires **Node.js** and **Xcode** (for the iOS Simulator).

```bash
# 1. Install dependencies
npm install
npx expo install @react-native-async-storage/async-storage @react-native-community/slider

# 2. Boot the simulator first — Expo struggles to cold-start it
open -a Simulator

# 3. Start the packager
npx expo start
```

Then press **`i`** to launch in the simulator, or scan the QR code with Expo Go
on a real phone (phone and Mac must be on the same Wi-Fi).

### If it won't start

**"Xcode must be fully installed"** — the command line tools are pointing at the
wrong place:

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
sudo xcodebuild -license accept
xcode-select -p   # should print /Applications/Xcode.app/Contents/Developer
```

**Stale code after editing** — Metro caches aggressively. If the app is running
old logic (old multipliers, old rules), it's this:

```bash
npx expo start --clear
```

**Phone can't reach the Mac** — use `npx expo start --tunnel`, or just use the
simulator, which needs no network at all.

---

## Files

```
App.js       UI, game loop, board generation, state.
deduce.js    All logical reasoning. The solver AND the referee.
reward.js    Coins, bomb classification, scoring, profile persistence.
```

Three files, sharply separated:

- **`deduce.js` knows nothing about rewards.** It's pure logic — given a board,
  what can be proven?
- **`reward.js` knows nothing about the UI.** It's pure scoring. You can change
  every number in it without touching game code.
- **`App.js` owns the board and the screen**, and asks the other two questions.

The one rule: **the live assistant and the referee share the same code.** If they
ever drift, the game will flag a mine the scorer later calls undeducible.

---

## How to play

- **Tap** to dig.
- **Long-press** to flag. Or hit the flag button in the top bar and tap normally.
- **Tap a satisfied number** to chord — clears its remaining neighbours.
- **Pinch** to zoom (the board always fits the screen width; scroll for the rest).
- **Smiley** opens the menu: modes, custom size, assistants.
- **↻** restarts.
- **Wallet** (top right) opens your profile.

**Surrender & bank** appears once a game is live. It keeps 100% of your coins and
every bomb you proved. Dying costs you 25% of the coins and downgrades every bomb
to a plain Mine.

### Flags

- **Locked (red border)** — the board has *proved* it. Banks a bomb, and can no
  longer be unflagged.
- **Unlocked** — still just your call. Banks nothing, yet, and you can remove it.

An unlocked flag means *unproven*, not *wrong*. You can't tell which just by
looking. To prove it: dig its partner and survive.

- **Solid red triangle** — the board has *proved* it. Banks a bomb.
- **Faded red triangle** — still just your call. Banks nothing, yet.

A faded flag means *unproven*, not *wrong*. You can't tell which, and the game
won't tell you. To prove it: dig its partner and survive.

### Endgame colours

| | |
|---|---|
| ⚫️ **Black circle** | where you died |
| 🟫 **Brown** | ordinary Mine |
| 🟪 **Violet** | Broken Arrow (6+ mines touching it) |
| 🟨 **Gold** | Unexploded Ordnance — logic never found it, and you dug around it anyway |

---

## Modes

| | Size | Mines |
|---|---|---|
| Easy | 9 × 9 | 10 |
| Medium | 16 × 16 | 40 |
| Hard | 30 × 16 | 160 |
| Extreme | 30 × 24 | 160 |
| Custom | up to 40 × 30 | up to 280 |

Custom mines are capped at 40% density — past that the board stops being solvable
by deduction and becomes a coin flip.

---

## Tuning

Almost every number lives at the top of **`reward.js`**:

```js
COIN_TABLE                 // [0,1,4,9,16,25,40,60,70] — blanks pay nothing
PAYOUT.loss                // 0.75 — lower toward 0.5 to make surrender bite
BLIND_MULTIPLIER           // 2
ASSIST_CUT / SWEEP_CUT / SMART_CUT   // 0.20 / 0.35 / 0.45 — ADDITIVE, sum to 1.0
SWEEP_VOIDS_BOMBS          // sweeping voids Mines and Broken Arrows
BROKEN_ARROW_MIN_NEIGHBORS // 6
```

**The assist cuts are additive**, so all three currently sum to exactly 100% —
full assist pays zero by design. If you want the top tier to leave something on
the table, lower `SMART_CUT`.

Performance dials are in **`deduce.js`**: `WINDOW_CAP` (18), `FULL_CAP` (22),
`STEP_CAP` (120000). If the game stutters on Extreme, drop `WINDOW_CAP` to 15
first.

---

## Known gaps

- **Guess budget** — not built. See `PROJECT_CONTEXT.md`; it collides with UXO.
- **Coins buy nothing.** There's no shop. Decide what the currency is *for* after
  playing enough to know whether the payouts feel right.
- **Android zoom** doesn't work — it uses iOS-only `ScrollView` zoom props.
- **The referee runs on every move for everyone**, which is the expensive path
  running constantly on Extreme.

---

Read **`PROJECT_CONTEXT.md`** before changing any rule. Several of them look
arbitrary and are not — particularly *why a flag must be proven*, and *why the
referee must never run on a finished board*.