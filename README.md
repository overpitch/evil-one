# Evil One

A low-poly, third-person sword-fighting game that runs in the browser. See [GAME_DESIGN.md](GAME_DESIGN.md) for the full design.

## Play online

**https://overpitch.github.io/evil-one/**

It works in Chrome, Edge and Safari on computers and Chromebooks, and in Microsoft Edge on Xbox with a controller. Each device keeps its own saved game. On a slower computer, set **Graphics: Low** in Options.

Every push to `main` rebuilds and republishes the game automatically (see `.github/workflows/deploy.yml`).

### On Xbox (Microsoft Edge)

1. Open the address above in Edge.
2. **Hold the ☰ Menu button for about a second** to switch the controller from browser controls to **game controls**. Until you do, the sticks move a cursor and B means "go back". The game shows a reminder, and Back no longer leaves the game.
3. Low graphics is chosen automatically on Xbox.

## Run it locally

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
| Inventory (choose your weapon) | `I` |
| Quick-swap weapon | `1`–`5` |
| Pause | `Esc` |

**Controller (Xbox layout):**

| Action | Button |
|---|---|
| Move / look | Left stick / right stick |
| Attack | RT or X |
| Block (hold) | LT or LB |
| Dodge roll | A |
| Sprint (hold) | B or click the left stick |
| Map | View |
| Inventory | Y |
| Quick-swap weapon | D-pad left / right |
| Pause | Menu |
| Menus | D-pad or left stick to choose, A to select, B to go back |

## Options

**Options** (on the title screen and the pause screen) has:

- **Graphics:** High, or Low for slower computers and Chromebooks (no shadows, lower resolution).
- **Difficulty:** Easy, Normal or Hard. It changes how hard enemies hit, how many hits they take, and how fast you and your soldiers heal between fights. You can switch at any time, even mid-fight.
- **Look sensitivity.**
- **Invert vertical look.**
- **Music volume** and **Sound effects volume.**

Options are saved in the browser, so each player keeps their own on their own device.

Your squad heals between fights. When you enter an enemy land, fallen soldiers are replaced and the rest are healed to full.

## How the war goes

1. Each enemy land (Zombie, Witch, Vampire) has **five outposts**. Clearing an outpost's garrison brings a **counterattack**; survive it and the outpost is yours.
2. A land's leader waits behind a **sealed gate** that opens only when all five of its outposts are captured.
3. When all three leaders are dead, the seal on **Zomawi's fortress** in the far south breaks. Storm the courtyard, then face Zomawi in the sanctum.
4. Defeat Zomawi to see the ending. Afterwards you can keep exploring the liberated world.

## Weapons and inventory

Each leader drops its weapon where it falls, glowing in a beam of light. Walk into it to claim it; it goes straight into your hand. Open the **Inventory** (`I`, the controller's Y button, or the pause menu) to switch between the weapons you own. The game waits while it's open.

| Slot | Weapon | From | What it does |
|---|---|---|---|
| 1 | Soldier's Sword | You start with it | Balanced. |
| 2 | Gravebreaker | The Zombie King | Slow, heavy bone maul. The third swing of a combo slams the ground and hits every enemy around you. |
| 3 | Hexfire Staff | The Witch Queen | Weaker swings, but every swing throws a fire bolt, and the third throws three. |
| 4 | Bloodfang | The Vampire Lord | Very fast saber. Every hit heals you a little. |
| 5 | Doomblade | Zomawi | Huge greatsword with long reach. Heals on every hit, and the third swing slams the ground. |

Older saves that already beat a leader get that leader's weapon automatically.

## Fort Victory, gold and shops

Fort Victory is your base, a walled fort on a big hill in the northeast. When you fall (both of you, in two-player), you and your army come back there with nothing lost. **Pause → Go to Fort Victory** takes the team there, and **Go back** returns you to where you were (not during boss fights).

Every enemy you beat gives gold (leaders give a lot); in two-player each hero has their own. Step up to a stall's counter to shop:

| Stall | Sells |
|---|---|
| Potion Shop | Healing potions (carry 5; D-pad up or H to drink, heals half your health) |
| Armory | Leather, chainmail and plate armor: more health, shown on your hero |
| Weaponsmith | Spear, twin daggers, battle axe, war hammer. Sell any weapon for half its price (and buy it back later), or trade the weapon in your hand for one worth the same or less |
| Barracks | Hire soldiers, up to an army of 5 |

## Outfits

After naming a new hero you dress them: shirt, long shirt or chainmail; pants, shorts, or shorts with fishnet stockings (pink, or black for Player 2); and colors. Change it any time with **Pause → Outfit**.

## Saving

Touching a standing red banner makes it your checkpoint: it saves the game, restores your health and replaces fallen soldiers. Capturing an outpost raises a new banner there. If you die, you return to your last checkpoint and lose any XP earned since.

## Troubleshooting a device

Add these to the end of the game's address:

- **`?probe`**: a tiny test page (one spinning shape and a timer). If a browser closes even this, the problem is the device or its settings, not the game.
- **`?padtest`**: a controller test page that shows, in large text, everything the browser passes on from the controller: buttons, sticks, key presses, clicks, cursor movement, scrolling and Back.
- **`?stats`**: shows frame rate, work per frame, draw calls, memory, resolution, graphics quality, running time, and the controller's stick readings and any held keys in the corner.
- **`?lite`**: forces Low graphics for that visit without changing saved Options. On Xbox, Low is chosen automatically the first time. It turns off shadows and edge smoothing, renders at reduced resolution, and simulates fewer distant enemies.

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
| `src/zomawi.ts` | Zomawi, the final boss: human, zombie and witch powers at once |
| `src/projectiles.ts` | Fire bolts, hex orbs and meteors |
| `src/character.ts` | Blocky humanoid model and pose helpers |
| `src/camera.ts` | Over-the-shoulder camera, screen shake, invert look |
| `src/world.ts` | Terrain, three biomes, camp, outposts, arenas, lighting, collisions |
| `src/banner.ts` | Checkpoint banners |
| `src/particles.ts` | Blood, dust and spark particles |
| `src/audio.ts` | Synthesized sound effects; music and effects volume |
| `src/music.ts` | Procedural soundtrack: title, exploring (per land), battle, boss, victory |
| `src/hud.ts` | Status bars, messages, objective marker, all menu screens |
| `src/map.ts` | The world map |
| `src/weapons.ts` | The five weapons: stats, special powers, 3D models and icons |
| `src/loot.ts` | Leader weapons lying on the ground, waiting to be claimed |
| `src/progression.ts` | XP curve, level stat gains, XP rewards |
| `src/floaters.ts` | Floating damage numbers and +XP text |
| `src/settings.ts` | Player options (sensitivity, invert look) |
| `src/save.ts` | Save game |
| `src/input.ts` | Keyboard, pointer-lock mouse and gamepad input |
| `src/menuNav.ts` | Driving the menus with a controller |
