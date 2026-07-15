# PROJECT_CONTEXT

Design notes for **Minesweep**. This is the *why* — the reasoning behind rules
that would otherwise look arbitrary six months from now. For setup and file
layout, see `README.md`.

---

## The core idea

Minesweeper, but every board is a decision about **how much help you want and
what that help costs you.** Three assistants sit on a dial. Turn them on and the
game becomes easy and pays nothing. Turn them off and every square is yours to
earn.

The bomb economy exists so that "playing well" has an output beyond a win/loss
record — and so that the *hardest* thing in Minesweeper, the mine that logic
cannot find, is the thing worth the most.

---

## The three assistants

Each is a sub-option of the one above it. You cannot sweep without flagging; you
cannot smart-sweep without sweeping.

| | What it does | Cut |
|---|---|---|
| **Auto-flag** | Plants every flag the numbers *prove*. | −20% |
| **Auto-sweep** | Opens every square those proven flags make safe. | −35% |
| **Smart sweep** | Set-difference, exact enumeration, global mine counting. Solves everything short of a true 50/50. | −45% |

**The cuts are additive, not multiplicative.** All three on = −100% = zero coins.
This was deliberate: if the machine plays the game, you don't get paid. Full
assist is a practice mode, not a difficulty tier.

Auto-sweep additionally **voids Mines and Broken Arrows entirely**. If the solver
is opening squares for you, the ordinary bombs weren't your find. Only UXO
survives — by definition the one thing the solver couldn't have handed you.

Consequence worth knowing: with all three on, a run banks **zero coins, zero
Mines, zero Broken Arrows**. The only possible output is a UXO — and smart sweep
exists precisely to solve the boards that would produce one. Full assist is very
nearly a null run. That's the intent.

### Blind mode

No flags at all. Dig only. **×2 coins.** Mutually exclusive with the assistants
(they have nothing to work with). Because bombs on a non-win require *flags*, a
blind run that doesn't end in a win banks no bombs at all — blind is coins-only
unless you clear the board. Sharp risk profile, intentionally.

---

## The referee — the most important thing in the codebase

`referee()` in `deduce.js` runs a **max-strength solve after every single move,
for every player, regardless of which toggles they have on.**

It strips the player's flags and reasons purely from revealed numbers.

> **Your toggles decide what the game shows you. They never decide what a mine is worth.**

Without this, a player with the assistant *off* would look "stalled" from move
one and the entire board would qualify as undeducible. And smart sweep would mint
UXOs for mines it had just solved. The referee makes bomb value a property of the
**board**, not of the settings.

It returns two things:

- **`provenMines`** — mines logic can force *right now*.
- Everything it has *ever* proven, accumulated across the game (`provenEverRef`).

### One critical guard

The referee **must not run on a finished board.** Once every safe square is open,
every remaining square is trivially a mine — it would "prove" the lot and erase
the very UXOs the player dug around to earn. Hence:

```js
if (b.every((c) => c.revealed || c.mine)) return;
```

Load-bearing. Don't remove it.

---

## Flags: proof, not adjacency

A flag banks a bomb **only if the referee can prove that square is a mine.**

An earlier version used adjacency (a flag counts if it touches an opened square).
That was replaced because it let players carpet-flag near the frontier. The proof
rule is strictly stricter and closes it.

The cost: **a correct-but-unprovable flag pays nothing.** You read a 50/50
right, you flag it, you die — you get zero. This is intended. Guesses don't pay,
even correct ones.

### How you *do* claim an unprovable mine

Dig its partner and survive. Once the neighbour opens, the numbers force the
flag, the referee proves it, and it converts.

**The risk isn't a rule bolted on — it's the price of the proof.** This is why no
extra anti-farming mechanic was needed: a stalled coastline square is by
definition unprovable, so flagging it and surrendering banks nothing.

### Confirming the player's flags

`confirmFlags()` earns a manual flag by contradiction: assume the square is
*safe*, propagate, and if a number ends up needing more mines than it has squares
— impossible. It must be a mine, and the assistant may now build on it.

**Only the confirming direction is tested.** If a flag is wrong, that's the
player's mistake to find. We never volunteer it. A hollow flag means *unproven*,
not *wrong* — and you can't tell which.

---

## The three bomb types

| Type | Rule | Colour |
|---|---|---|
| **Mine** | Ordinary. Logic proved it at some point. | brown |
| **Broken Arrow** | 6+ mines touching it. A dense clump. | violet |
| **Unexploded Ordnance (UXO)** | The referee **never** proved it, all game. | gold |

### UXO, and the bug that shaped it

The first implementation marked coastline mines as UXO **every time the solver
stalled**. But the solver stalls constantly — usually just because the opened
region is closed off and you need to dig somewhere fresh. Those mines become
deducible two moves later, but they'd already been stamped. One medium board
minted dozens of fakes.

**The rule now: if the referee EVER proves a mine, it is ordinary.** A UXO is a
mine logic never found, for the entire game. Nothing else. This is both simpler
and correct.

Expect long dry spells. The referee is strong — set-difference, exact enumeration,
global counting — so most boards it simply solves. That's the point.

### Collection rules

| Outcome | Coins | Bombs | Types |
|---|---|---|---|
| **Win** | 100% | every mine (you cannot clear a board without knowing where they all are) | full |
| **Surrender** | 100% | only mines you flagged **and** proved | full |
| **Loss** | 75% | only mines you flagged **and** proved | all downgrade to plain Mine |

Surrender exists to make every board a *cash out or push your luck* decision.

**Known soft spot:** at 75% retention on a loss, surrender barely bites — the
rational move is almost always to keep digging. If you want that decision to
matter, `PAYOUT.loss` wants to be nearer `0.5`.

---

## Coins

```
adj:    0   1   2   3   4   5   6   7   8
coins:  0   1   4   9  16  25  40  60  70
```

`n²` up to 5, then bent generous. **Blank squares pay nothing** — a lucky flood
that opens forty empty cells earns you almost zero. This is deliberate: coins come
from working in dangerous territory, not from farming empty corners.

---

## Board generation

**No solid 2×2 of mines**, anywhere. Breaks up the dense blobs that make regions
unsolvable.

This does *not* kill Broken Arrow: a mine can still reach 6 mine-neighbours with
no solid 2×2 — put its safe cells directly above and below it. Rare. Legendary.
That's the point.

**First click is always safe**, along with its eight neighbours. Mines are placed
*after* the first tap.

### Queued, not built: the guess budget

The plan was to reject boards needing more than N guesses (Easy 0, Medium 0,
Hard 1, Extreme 2) by running the solver at generation time. **Not implemented.**

Note the collision if you build it: a board with zero guesses has zero UXOs, by
definition. A budget of 0 on Easy/Medium means **UXO can never drop there.**
Possibly correct — UXO becomes a Hard/Extreme prize — but decide deliberately.

---

## The solver, layer by layer

`deduce.js`, weakest first. Each layer only runs when the one below it stalls.

0. **`confirmFlags`** — proof by contradiction on the player's own flags.
1. **`basicPass`** — the two counting rules every player uses.
2. **`smartPass`** — set-difference between overlapping numbers, *with derived
   constraints*. Subtracting one constraint from another manufactures new ones
   that match no number on the board — that's what lets deductions chain. Cracks
   1-2-1 and its whole family.
3. **`fullPass`** — enumerate every legal arrangement on the frontier. Only fires
   when the frontier is small. Unlocks **global mine counting**: if every
   surviving arrangement pins all remaining mines to the frontier, the entire
   unexplored region is safe and gets swept in one stroke.
4. **`windowPass`** — the one that actually runs. On a real board the frontier is
   one long connected blob, far too wide to enumerate whole. So grab a number,
   pull in overlapping neighbours until the pocket hits 18 cells, brute-force
   that. **Sound but weaker:** dropping constraints only *adds* possible
   arrangements, so anything true across all of them stays true.

### Safety invariant

**The assistant physically cannot detonate a mine.** `open()` hard-stops on
`c.mine`. It also reasons only from flags *it* proved (`auto: true`) — a wrong
manual flag could otherwise let Rule 2 "prove" a mine was safe.

### Performance

The referee runs a full max-strength solve after every dig, **for everyone** — not
just when smart sweep is on. On Extreme this is the expensive path running
constantly.

If it stutters, the dial is `WINDOW_CAP` in `deduce.js`. Drop 18 → 15.
`FULL_CAP` (22) and `STEP_CAP` (120000) are the other leashes.

---

## Easter egg

Tap the letters of **MINESWEEP** to spell **PINMINES** (every letter is present).
X-rays all mines. **The run banks nothing** — without that, it's a money printer
that destroys the entire economy. It's a dev tool, not a power-up.

---

## Open questions

- **What are coins *for*?** Nothing yet. Play twenty games and see whether the
  payouts feel right before building an economy on top.
- **Surrender at 75%** barely bites. See above.
- **Guess budget** — unbuilt, and it collides with UXO.
- **Multiple UXOs per board** — a nasty endgame can strand several at once. If
  that feels too generous, cap at 1.
- **Android:** pinch-to-zoom uses the iOS `ScrollView` zoom props and does
  nothing on Android. Needs a gesture library.