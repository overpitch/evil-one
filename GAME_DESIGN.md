# Evil One — Game Design

A third-person sword-fighting game that runs in the web browser. You are a soldier in the human army. Fight through the zombie, witch, and vampire territories, kill each army's leader, and then face the final boss: **Zomawi**, part human, part zombie, part witch.

## Core decisions

| Area | Decision |
|---|---|
| Platform | Web browser (Three.js + Vite). Desktop only. |
| Camera | Third person. The camera sits just behind and slightly above the character's shoulder. |
| Art style | Low-poly and blocky, with models built from code (no external art needed). |
| Structure | Open world. Attack enemy territories in any order. |
| Allies | AI human soldiers fight alongside you. |
| Combat | Simple: attack, block, dodge roll. |
| Progression | XP and levels (health, damage, stamina). |
| Enemy armies | Zombies, witches, vampires. |
| Army leaders | Each army has a named leader (mini-boss) with a unique fight. |
| Boss unlock | Zomawi's fortress opens once all three leaders are dead. |
| Zomawi fight | One long fight that mixes all of Zomawi's powers. |
| Death | Respawn at the last checkpoint. Progress since that checkpoint is lost. |
| Save | Saves in the browser at each checkpoint, so you can close the tab and come back later. |
| Length | 1–2 hours for a full playthrough. |
| Story | Light: intro, leader death lines, final scene. |
| Audio | Sound effects and music. |

## Game flow

1. **Title screen:** "Evil One", with New Game and Continue.
2. **Name your hero:** a text entry. The name appears in dialogue, the HUD, and the ending.
3. **Intro:** a short text scene. Zomawi has raised the zombie, witch, and vampire armies against humanity, and the human army marches out.
4. **Human camp (hub):** the starting area and first checkpoint. The world map shows the three enemy territories.
5. **Territories (any order):** each has outposts to clear, roaming patrols, and the leader's stronghold.
6. **Leader fights:** each leader says a line when it falls, and its territory becomes safe.
7. **Zomawi's fortress:** opens after all three leaders are dead. The final fight follows.
8. **Ending:** a victory scene that names your hero, then credits.

## Controls (keyboard + mouse or trackpad)

None of the core actions need right-click or click-and-hold, so everything works on a trackpad.

| Action | Input |
|---|---|
| Move | WASD |
| Look | Mouse or trackpad (the pointer locks when you click into the game) |
| Attack | Left click / tap, or `J` |
| Block (hold) | `Q` or `K` |
| Dodge roll | `Space` |
| Sprint | `Shift` |
| Interact / talk | `E` |
| Map | `M` |
| Pause | `Esc` |

## Combat

- **Attack:** swing your sword. Pressing attack repeatedly chains up to 3 swings.
- **Block:** reduces incoming damage and uses stamina.
- **Dodge roll:** brief invincibility; uses stamina.
- **Stamina** refills when you aren't using it.
- **Hit feedback:** enemies flash, get knocked back, and the camera shakes slightly.

## Progression

- Kills and objectives give **XP**.
- Each **level up** raises max health, damage, and stamina, and fully heals you.
- Rough pace: level 1 to about level 10 over a full playthrough.

## Allied human army

- A squad of AI soldiers follows you and attacks nearby enemies.
- Soldiers can die. Reinforcements arrive at checkpoints.
- Big set-piece battles happen at leader strongholds.

## Enemy armies

| Army | Soldiers | Behavior | Leader (working name) |
|---|---|---|---|
| Zombies | Shamblers, runners, brutes | Slow but tough, attack in big swarms | Zombie King |
| Witches | Hexers, broom-flyers | Keep their distance and cast spells (fire bolts, slowing curses) | Witch Queen |
| Vampires | Thralls, vampire knights | Fast, drain health to heal themselves, teleport short distances | Vampire Lord |

### Leaders

- **Zombie King:** a huge brute. Ground-pound shockwaves, calls zombie hordes.
- **Witch Queen:** flies between platforms, rains spells, and makes copies of herself.
- **Vampire Lord:** a fast sword duelist. Life-drain grab, and turns into bats to reposition.

## Final boss: Zomawi

A single fight that mixes all three natures at once:

- **Human:** heavy sword combos and a charging lunge.
- **Zombie:** raises zombie minions from the ground, takes a grab-and-bite attack, and regenerates slowly.
- **Witch:** fire bolts, homing hex orbs, and short levitation that keeps Zomawi out of reach.
- As Zomawi's health drops, attacks come faster and Zomawi summons more often.
- Your allied soldiers fight Zomawi's minions in the arena.

## Checkpoints and saving

- Checkpoints are banners at the human camp, at captured outposts, and at the entrance to each stronghold.
- Touching a banner saves the game to browser storage.
- When you die, you respawn at the last banner. XP gained and enemies killed since then are reset.

## World (open world, 1–2 hours)

- **Center:** the human camp.
- **Three territories around the center:**
  - **Zombie territory:** a rotting graveyard and ruined village.
  - **Witch territory:** a dark swamp-forest with glowing mushrooms.
  - **Vampire territory:** a moonlit castle on cliffs.
- **Zomawi's fortress** stands in a sealed area at the edge of the map.
- Each territory has 2–3 outposts and a stronghold.

## Audio

- **Sound effects:** sword swings and clangs, footsteps, zombie groans, spell casts, vampire screeches, and level-up chimes. Generated in the browser with the Web Audio API.
- **Music:** a calm theme for exploring, battle music when enemies are near, and a separate theme for boss fights.

## Technical plan

- **Stack:** Three.js for rendering and Vite as the dev server and build tool, in plain TypeScript. Physics is simple and hand-written (capsule collisions against the ground and walls).
- **Models:** low-poly characters built from simple shapes in code, with procedural animation (swinging limbs, bobbing).
- **AI:** state machines (idle → chase → attack → flee) with simple steering. Enemies spread out around their target.
- **Performance target:** 60 fps with about 40–60 fighters on screen.

## Build milestones

1. ✅ **Core feel:** third-person camera, movement, sword combat against one dummy enemy.
2. ✅ **Hero and HUD:** name entry, health/stamina/XP bars, leveling.
3. ✅ **First territory:** zombie army, allied soldiers, checkpoints and saving, Zombie King fight. Also added: an Options screen with invert vertical look.
4. ✅ **Remaining territories:** witch and vampire armies and their leaders. Recommended levels: Zombie Lands 1, Witch Lands 5, Vampire Lands 8.
5. ✅ **Zomawi:** the fortress, the final fight, and the ending. Also: 5 outposts per land with counterattack waves, and leader arenas sealed until a land's outposts are all captured.
6. **Polish:** music, sound effects, balancing, title screen.

## Open questions (defaults are used until decided)

- Leader names: currently "The Zombie King", "The Witch Queen", and "The Vampire Lord". They can be renamed in `src/layout.ts`.
- Can the hero be customized beyond the name, for example armor color?
- Zomawi's appearance and backstory. Current version: once a general of the human army, raised as a zombie and bound with witchcraft. Half armored knight, half rotting zombie, in a witch's cloak and crowned hat, with a greatsword.
