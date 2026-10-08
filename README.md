# Evil One

A low-poly, third-person sword-fighting game that runs in the browser. See [GAME_DESIGN.md](GAME_DESIGN.md) for the full design.

## Run it

```bash
npm install
npm run dev
```

Then go to http://localhost:5173, choose **New Game**, name your hero, and click **Take up your sword**. Next time, **Continue** picks up from your last checkpoint.

## Controls

| Action | Input |
|---|---|
| Move | W A S D |
| Look | Mouse or trackpad |
| Attack (press repeatedly for a 3-hit combo) | Click or `J` |
| Block (hold) | `Q` or `K` |
| Dodge roll | `Space` |
| Sprint | `Shift` |
| Map | `M` |
| Pause | `Esc` |

## Options

**Options** (on the title screen and the pause screen) has look sensitivity and **Invert vertical look**. Options are saved in the browser, so each player keeps their own on their own device.

## Saving

Touching a standing red banner makes it your checkpoint: it saves the game, restores your health and replaces fallen soldiers. Capturing an outpost raises a new banner there. If you die, you return to your last checkpoint and lose any XP earned since.

## Debugging

Open http://localhost:5173/?test to skip the menus and play without pointer lock. Test runs use a separate save slot. In the browser console, `__game` exposes the player, allies, enemies, campaign and camera. `__game.step(seconds)` advances the game at a fixed 60 fps, which also works while the tab is in the background.

## Layout

| File | What it does |
|---|---|
| `src/main.ts` | Setup, game loop, menu flow, saving, body separation |
| `src/campaign.ts` | The three territories: outposts, checkpoints, patrols, leader fights, objectives |
| `src/layout.ts` | Where everything is in the world, which enemies are where, leader names and lines |
| `src/player.ts` | Hero movement, combat (combo, block, roll), hexes and grabs, animation |
| `src/ally.ts` | Allied soldiers: formation, fighting, reinforcements |
| `src/enemy.ts` | Shared enemy body: movement, targeting, taking hits, packs, health bars |
| `src/enemies.ts` | Creates any enemy or leader by name |
| `src/zombies.ts` | Zombie army: shamblers, runners, brutes |
| `src/witches.ts` | Witch army: hexers, broom-witches, the queen's mirror images |
| `src/vampires.ts` | Vampire army: thralls, vampire knights |
| `src/zombieKing.ts` | The Zombie King: ground pound, summons, enrage |
| `src/witchQueen.ts` | The Witch Queen: flight, meteor rain, exhaustion, mirror images |
| `src/vampireLord.ts` | The Vampire Lord: combos, parries, life-drain grab, bat form |
| `src/projectiles.ts` | Fire bolts, hex orbs and meteors |
| `src/character.ts` | Blocky humanoid model and pose helpers |
| `src/camera.ts` | Over-the-shoulder camera, screen shake, invert look |
| `src/world.ts` | Terrain, three biomes, camp, outposts, arenas, lighting, collisions |
| `src/banner.ts` | Checkpoint banners |
| `src/particles.ts` | Blood, dust and spark particles |
| `src/audio.ts` | Synthesized sound effects |
| `src/hud.ts` | Status bars, messages, objective marker, all menu screens |
| `src/map.ts` | The world map |
| `src/progression.ts` | XP curve, level stat gains, XP rewards |
| `src/floaters.ts` | Floating damage numbers and +XP text |
| `src/settings.ts` | Player options (sensitivity, invert look) |
| `src/save.ts` | Save game |
| `src/input.ts` | Keyboard and pointer-lock mouse input |
