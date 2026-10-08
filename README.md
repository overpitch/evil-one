# Evil One

A low-poly, third-person sword-fighting game that runs in the browser. See [GAME_DESIGN.md](GAME_DESIGN.md) for the full design.

## Run it

```bash
npm install
npm run dev
```

Then open http://localhost:5173 and click **Click to play**.

## Controls

| Action | Input |
|---|---|
| Move | W A S D |
| Look | Mouse or trackpad |
| Attack (press repeatedly for a 3-hit combo) | Click or `J` |
| Block (hold) | `Q` or `K` |
| Dodge roll | `Space` |
| Sprint | `Shift` |
| Pause | `Esc` |

## Debugging

Open http://localhost:5173/?test to play without pointer lock. In the browser console, `__game` exposes the player, enemies and camera. `__game.step(seconds)` advances the game at a fixed 60 fps, which also works while the tab is in the background.

## Layout

| File | What it does |
|---|---|
| `src/main.ts` | Setup, game loop, spawning, body separation |
| `src/player.ts` | Hero movement, combat (combo, block, roll), animation |
| `src/enemy.ts` | Zombie AI and animation |
| `src/character.ts` | Blocky humanoid model and pose helpers |
| `src/camera.ts` | Over-the-shoulder camera and screen shake |
| `src/world.ts` | Terrain, trees, rocks, lighting, collisions |
| `src/particles.ts` | Blood and spark particles |
| `src/audio.ts` | Synthesized sound effects |
| `src/hud.ts` | Health and stamina bars, pause and death screens |
| `src/input.ts` | Keyboard and pointer-lock mouse input |
