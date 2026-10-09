# Mini RPG Battle Arena

A single-page, dependency-free browser fighting RPG. You play **Ryko** in a
best-of gauntlet against three AI-controlled monsters, using a data-driven set
of 13 moves with stamina/mana costs, combos, criticals, blocks, dodges,
crouches and a mana-fuelled ultimate.

Everything is plain HTML, CSS and JavaScript. There is **no build step and no
external JavaScript dependency**. The only network request is the optional
Google Fonts stylesheet; if it is blocked the UI falls back to the system font
stack with no errors.

---

## Launch

Serve the folder with any static file server. Python 3 is the simplest option
that needs no install:

```powershell
# from this folder (rpg-arena/)
python -m http.server 8000
```

Then open **http://localhost:8000/** in a browser.

You can also just double-click `index.html` (it works from `file://`), but a
local server is recommended so font loading and background images behave
exactly as in production.

> The repository root also contains a tiny `index.html` that redirects to
> `rpg-arena/index.html` if you serve from the parent folder instead.

---

## Controls

Click the on-screen buttons, or use the keyboard shortcuts:

| Key | Move | Cost | Notes |
|-----|------|------|-------|
| `1` | Jab | 5 stamina | Fast, accurate |
| `2` | Straight Punch | 8 stamina | Balanced |
| `3` | Heavy Punch | 15 stamina | High damage, slower |
| `4` | Uppercut | 18 stamina | Upward strike; beats crouch |
| `5` | Front Kick | 12 stamina | Quick mid kick |
| `6` | Low Kick | 10 stamina | Low; trips crouchers |
| `7` | Roundhouse | 22 stamina | Spinning, high damage |
| `8` | Heavy Kick | 26 stamina | Highest damage, slowest |
| `Q` | Block | 5 stamina | Reduces incoming damage |
| `E` | Dodge | 12 stamina | Chance to avoid entirely |
| `C` | Crouch | 8 stamina | Evades high attacks |
| `H` | Heal | 20 mana | Restore 40 HP |
| `R` | Special (Ultimate) | 40 mana + 25 stamina | Devastating |

Legacy keys `A` (punch), `S` (roundhouse) and `D` (heal) also work.

---

## Gameplay

* **Gauntlet** — defeat three enemies in order (Goblin Brawler, Orc Brute,
  Draconic Overlord). You keep your health/mana between rounds with a small
  recovery.
* **Resource management** — attacks cost stamina, Heal and the Ultimate cost
  mana. Buttons show when a move is unavailable because of cost or because it
  is not your turn.
* **Combos** — landing consecutive hits builds a damage bonus (capped).
* **Criticals** — chance-based; shown as gold `CRITICAL!` and a harder impact.
* **Ultimate** — fires a gold `ULTIMATE!` hit with extra glow.
* **Defence** — Block reduces damage, Dodge can avoid it, Crouch slips high
  attacks but is punished by low kicks.
* **Enrage** — each monster enrages once when badly hurt (glow + surge).
* **Flow** — start screen → fight → `VICTORY!` or `DEFEATED` overlay →
  restart for a fresh run. A mid-fight restart is deliberately ignored; use
  the overlay button to restart.
* **Live stance** — while idle the fighters keep a subtle, mirrored, out-of-phase
  fight-stance bob with forward/back footwork (CSS `fighterStance`), so they read
  as opponents squaring up instead of copies.

---

## Tests

The regression suites are plain Node scripts (no framework) that run the real
`script.js` inside a stubbed DOM. They live in the **parent** folder and are
run from there:

```powershell
cd ..
node test-logic.js                 # core classes / moves / AI logic
node test-wiring.js                # HTML ids, data-move keys, assets, CSS classes
node test-flow.js                  # full gauntlet flow (virtual clock)
$env:SEED=56; node test-flow.js    # deterministic victory run (47 checks)
node test-flow.js                  # default seed -> defeat run (44 checks)
```

Expected baseline:

| Suite | Result |
|-------|--------|
| `test-logic.js` | 56 / 56 |
| `test-wiring.js` | 10 / 10 |
| `test-flow.js` (SEED=56) | 47 / 47 |
| `test-flow.js` (default seed) | 44 / 44 |

---

## Visual review

`review.html` (repository root) is a generated contact sheet of the current
build with 83 labelled screenshots covering the start screen, all 13 moves,
impact/reaction moments, the victory gauntlet, defeat/retry and every required
viewport. Open it in a browser to eyeball the visuals and note anything off by
its caption path.

## Project layout

```
rpg-arena/
  index.html      markup + inline favicon (no 404)
  style.css       layout, responsive breakpoints, animations
  script.js       OOP engine: Character/Hero/Monster, GameController,
                  UIController, CombatSystem, AnimationSystem, EnemyAI
  assets/         fighter sprites (idle/punch/kick), portraits, arena bg
README.md         this file
```

No external dependencies are required to run or test the game.
