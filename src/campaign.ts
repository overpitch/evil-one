import * as THREE from 'three';
import { Banner } from './banner';
import { EnemyGroup, type Enemy } from './enemy';
import { createEnemy, createLeader } from './enemies';
import type { GameContext } from './types';
import { CASTLE_PLATFORM_R, inGoo, territoryWeight, type World } from './world';
import { ARMY_LEADERS, CAMP_BANNER, FORT, TERRITORIES, type EnemyKind, type OutpostDef, type TerritoryDef, type TerritoryId } from './layout';
import type { SaveData } from './save';
import { OUTPOST_XP } from './progression';
import { sfx } from './audio';

const TOUCH_RADIUS = 3;
const PATROL_RESPAWN = 45;
const PATROL_MOVE = 25;
/** Counterattack size, as a share of the outpost's garrison. */
const WAVE_SHARE = 0.7;
/** Seconds between lair waves (after the war is won). */
const LAIR_REST = 10;
/** Damage per second from the goo castle's goo. */
const GOO_BURN = 8;

/**
 * Once the war is won, each leader's lair keeps raising its army in waves
 * whenever a hero is inside, so there's always something left to fight.
 * Waves grow from 4 to all 8.
 */
const LAIR_KINDS: Record<TerritoryId, EnemyKind[]> = {
  zombie: ['shambler', 'runner', 'shambler', 'brute', 'runner', 'shambler', 'brute', 'runner'],
  witch: ['hexer', 'broomWitch', 'hexer', 'hexer', 'broomWitch', 'hexer', 'broomWitch', 'hexer'],
  vampire: ['thrall', 'knight', 'thrall', 'thrall', 'knight', 'thrall', 'knight', 'thrall'],
  // Zomawi's sanctum: a swarm of gremlins.
  fortress: ['gremlin', 'gremlin', 'gremlin', 'gremlin', 'gremlin', 'gremlin', 'gremlin', 'gremlin', 'gremlin', 'gremlin'],
};

interface Lair {
  group: EnemyGroup;
  wave: number;
  rest: number;
}

export interface Checkpoint {
  id: string;
  name: string;
  banner: Banner;
  /** The banner stands and can be used as a checkpoint. */
  unlocked: boolean;
}

export interface Outpost {
  def: OutpostDef;
  group: EnemyGroup;
  /** The garrison holding the outpost at the start. */
  garrison: Enemy[];
  /** The counterattack that arrives once the garrison falls. */
  wave: Enemy[];
  phase: 'garrison' | 'counterattack' | 'captured';
  checkpoint: Checkpoint;
}

/** One enemy land: outposts, a roaming patrol, and its leader's arena. */
export interface Territory {
  def: TerritoryDef;
  outposts: Outpost[];
  gate: Checkpoint;
  patrol: EnemyGroup;
  patrolRespawn: number;
  patrolMove: number;
  patrolLeg: number;
  leader: Enemy;
  leaderGroup: EnemyGroup;
  minions: Enemy[];
  bossState: 'sealed' | 'waiting' | 'fighting' | 'defeated';
  victoryTimer: number;
  lair: Lair;
}

export interface Objective {
  text: string;
  at: THREE.Vector3 | null;
}

/** How the campaign talks to the rest of the game (HUD, saving, rewards). */
export interface CampaignEvents {
  announce(title: string, detail: string): void;
  say(speaker: string, line: string): void;
  /** Heal, reinforce the squad and save. */
  checkpointReached(cp: Checkpoint): void;
  awardXp(amount: number, at: THREE.Vector3): void;
  /** The hero crossed into an enemy land: fresh soldiers join. */
  enteredTerritory(t: Territory): void;
  bossStarted(name: string): void;
  bossEnded(): void;
  /** A leader has fallen where it stood: its weapon drops there. */
  leaderDefeated(id: string, at: THREE.Vector3): void;
  /** Zomawi has fallen: the end of the war. */
  victory(): void;
  save(): void;
}

/** The kinds that make up a counterattack: most of the garrison, minus decoys. */
function waveKinds(def: OutpostDef): EnemyKind[] {
  const kinds = def.spawns.map(([k]) => k).filter((k) => k !== 'witchDecoy');
  return kinds.slice(0, Math.max(2, Math.ceil(kinds.length * WAVE_SHARE)));
}

/**
 * The war across every enemy land: outposts to capture (each answered by a
 * counterattack), checkpoints, roaming patrols, leader arenas that open only
 * once a land's outposts have all fallen, and Zomawi's fortress, sealed
 * until all three army leaders are dead.
 */
export class Campaign {
  readonly checkpoints: Checkpoint[] = [];
  readonly territories: Territory[] = [];
  readonly leaders = new Set<string>();
  current: Checkpoint;

  private readonly camp: Checkpoint;
  /** Fort Victory's banner: where fallen heroes come back. */
  readonly fortCheckpoint: Checkpoint;
  private touching: string | null = null;
  /** The enemy land the hero is in (null when outside them all). */
  private inLand: TerritoryId | null = null;
  private time = 0;
  private readonly centers = new Map<TerritoryId, THREE.Vector3>();

  constructor(
    scene: THREE.Scene,
    private readonly world: World,
    enemies: Enemy[],
    private readonly events: CampaignEvents,
  ) {
    const checkpoint = (id: string, name: string, x: number, z: number): Checkpoint => {
      const cp = { id, name, banner: new Banner(scene, world.colliders, x, z), unlocked: false };
      this.checkpoints.push(cp);
      return cp;
    };
    const member = (e: Enemy, group: EnemyGroup) => {
      e.group = group;
      group.members.push(e);
      enemies.push(e);
      return e;
    };

    this.camp = this.current = checkpoint(CAMP_BANNER.id, CAMP_BANNER.name, CAMP_BANNER.x, CAMP_BANNER.z);
    this.fortCheckpoint = checkpoint(FORT.banner.id, FORT.banner.name, FORT.banner.x, FORT.banner.z);
    for (const def of TERRITORIES) {
      const outposts = def.outposts.map((o): Outpost => {
        const group = new EnemyGroup();
        const garrison = o.spawns.map(([kind]) => member(createEnemy(scene, kind), group));
        const wave = waveKinds(o).map((kind) => member(createEnemy(scene, kind), group));
        return { def: o, group, garrison, wave, phase: 'garrison', checkpoint: checkpoint(o.id, o.name, o.x, o.z) };
      });
      const patrol = new EnemyGroup();
      for (const kind of def.patrol.kinds) member(createEnemy(scene, kind), patrol);
      const leaderGroup = new EnemyGroup();
      const leader = member(createLeader(scene, def.leader.id), leaderGroup);
      const minions: Enemy[] = [];
      for (let i = 0; i < def.leader.minionCount; i++) {
        const m = member(createEnemy(scene, def.leader.minionKind), leaderGroup);
        m.wanderRadius = 3;
        minions.push(m);
      }
      const lairGroup = new EnemyGroup();
      for (const kind of LAIR_KINDS[def.id]) member(createEnemy(scene, kind), lairGroup).wanderRadius = 4;
      this.territories.push({
        def,
        lair: { group: lairGroup, wave: 0, rest: LAIR_REST },
        outposts,
        gate: checkpoint(def.gate.id, def.gate.name, def.gate.x, def.gate.z),
        patrol,
        patrolRespawn: 0,
        patrolMove: PATROL_MOVE,
        patrolLeg: 0,
        leader,
        leaderGroup,
        minions,
        bossState: 'sealed',
        victoryTimer: -1,
      });
      this.centers.set(def.id, new THREE.Vector3(def.arena.x, 0, def.arena.z));
    }
  }

  get outposts() {
    return this.territories.flatMap((t) => t.outposts);
  }

  /** The territory whose leader is being fought right now, if any. */
  get activeFight() {
    return this.territories.find((t) => t.bossState === 'fighting') ?? null;
  }

  get fortress() {
    return this.territories.find((t) => t.def.requires)!;
  }

  isLiberated(t: Territory) {
    return this.leaders.has(t.def.leader.id);
  }

  /** The land can be entered at all (the fortress needs the three army leaders dead). */
  isOpen(t: Territory) {
    return (t.def.requires ?? []).every((id) => this.leaders.has(id));
  }

  /** Every outpost in the land is taken, so the leader's gate opens. */
  arenaOpen(t: Territory) {
    return this.isOpen(t) && t.outposts.every((o) => o.phase === 'captured');
  }

  get armyLeadersDefeated() {
    return ARMY_LEADERS.filter((id) => this.leaders.has(id)).length;
  }

  get victorious() {
    return this.isLiberated(this.fortress);
  }

  /** Rebuilds the world from a save (also used when respawning after death). */
  load(save: SaveData | null) {
    const captured = new Set(save?.captured ?? []);
    this.leaders.clear();
    for (const id of save?.leaders ?? []) this.leaders.add(id);

    this.camp.unlocked = true;
    this.fortCheckpoint.unlocked = true;
    this.fortCheckpoint.banner.setRaised(true);
    this.camp.banner.setRaised(true);
    for (const t of this.territories) {
      const open = this.isOpen(t);
      t.gate.unlocked = open;
      t.gate.banner.setRaised(open);
      for (const o of t.outposts) this.resetOutpost(o, captured.has(o.def.id), open);
      t.patrol.alerted = false;
      t.patrolLeg = 0;
      t.patrolRespawn = 0;
      t.patrolMove = PATROL_MOVE;
      this.spawnPatrol(t, false);

      if (t.bossState === 'fighting') this.events.bossEnded();
      t.leaderGroup.alerted = false;
      for (const m of t.minions) m.makeDormant();
      if (this.isLiberated(t)) {
        t.leader.makeDormant();
        t.bossState = 'defeated';
      } else if (open) {
        t.leader.spawn(t.def.throne.x, t.def.throne.z);
        t.bossState = this.arenaOpen(t) ? 'waiting' : 'sealed';
      } else {
        t.leader.makeDormant();
        t.bossState = 'sealed';
      }
      for (const e of t.lair.group.members) e.makeDormant();
      t.lair.group.alerted = false;
      t.lair.wave = 0;
      t.lair.rest = LAIR_REST;
      if (t.bossState === 'sealed') this.world.gates[t.def.id].close();
      else this.world.gates[t.def.id].open();
      t.victoryTimer = -1;
    }
    this.world.seal.set(!this.isOpen(this.fortress));

    this.current = this.checkpoints.find((c) => c.id === save?.checkpoint && c.unlocked) ?? this.camp;
    // The hero respawns beside this banner; don't re-trigger it (or a land's welcome) immediately.
    this.touching = this.current.id;
    const b = this.current.banner;
    this.inLand = this.territories.find((t) => territoryWeight(t.def, b.x, b.z) > 0.5)?.def.id ?? null;
  }

  private resetOutpost(o: Outpost, captured: boolean, open: boolean) {
    o.phase = captured ? 'captured' : 'garrison';
    o.group.alerted = false;
    o.checkpoint.unlocked = captured;
    o.checkpoint.banner.setRaised(captured);
    for (const e of o.wave) e.makeDormant();
    o.garrison.forEach((e, i) => {
      if (captured || !open) e.makeDormant();
      else e.spawn(o.def.x + o.def.spawns[i][1], o.def.z + o.def.spawns[i][2]);
    });
  }

  /** What the save file needs from the campaign. */
  saveFields(): Pick<SaveData, 'checkpoint' | 'captured' | 'leaders'> {
    return {
      checkpoint: this.current.id,
      captured: this.outposts.filter((o) => o.phase === 'captured').map((o) => o.def.id),
      leaders: [...this.leaders],
    };
  }

  update(dt: number, ctx: GameContext) {
    this.time += dt;
    for (const cp of this.checkpoints) cp.banner.update(dt, this.time);
    const player = ctx.leader;
    const heroes = ctx.players.filter((h) => h.alive);

    // The goo castle: goo slows and burns.
    for (const h of ctx.players) {
      h.inGoo = h.alive && inGoo(h.pos.x, h.pos.z);
      if (h.inGoo) h.burn(GOO_BURN * dt, ctx);
    }

    // Touching a standing banner (either hero) makes it the checkpoint (heals, reinforces, saves).
    if (heroes.length > 0) {
      const inside = this.checkpoints.find(
        (cp) => cp.unlocked && heroes.some((h) => Math.hypot(h.pos.x - cp.banner.x, h.pos.z - cp.banner.z) < TOUCH_RADIUS),
      );
      if (inside && inside.id !== this.touching) {
        this.touching = inside.id;
        this.activate(inside, 'Checkpoint', `${inside.name} · Game saved`);
      } else if (!inside) {
        this.touching = null;
      }
    }

    for (const t of this.territories) {
      if (!this.isOpen(t)) continue;
      for (const o of t.outposts) {
        if (o.phase !== 'captured' && o.group.cleared) {
          if (o.phase === 'garrison') this.counterattack(o, ctx);
          else this.capture(t, o);
        }
      }

      // Crossing into this land from outside brings fresh soldiers.
      const w = territoryWeight(t.def, player.pos.x, player.pos.z);
      if (player.alive && w > 0.5 && this.inLand !== t.def.id && !this.activeFight) {
        this.inLand = t.def.id;
        this.events.enteredTerritory(t);
      } else if (this.inLand === t.def.id && w < 0.2) {
        this.inLand = null;
      }

      if (!this.isLiberated(t)) this.updatePatrol(t, dt);

      const arena = this.centers.get(t.def.id)!;
      if (t.bossState === 'waiting' && !this.activeFight && heroes.some((h) => h.pos.distanceTo(arena) < t.def.arena.r - 2)) {
        this.startBossFight(t, ctx);
      }
      if (t.bossState === 'fighting' && !t.leader.alive) this.endBossFight(t, ctx);
      if (t.victoryTimer >= 0) {
        t.victoryTimer -= dt;
        if (t.victoryTimer < 0) this.afterVictory(t);
      }
    }
    if (this.victorious && this.fortress.victoryTimer < 0) for (const t of this.territories) this.updateLair(t, ctx, dt);
  }

  /** After the war: a hero inside a leader's lair brings wave after wave of its army. */
  private updateLair(t: Territory, ctx: GameContext, dt: number) {
    const lair = t.lair;
    if (!lair.group.cleared) return;
    const { arena } = t.def;
    const inside = ctx.players.some((h) => h.alive && Math.hypot(h.pos.x - arena.x, h.pos.z - arena.z) < arena.r - 1);
    if (!inside) return;
    lair.rest -= dt;
    if (lair.rest > 0 || !lair.group.members.every((e) => e.readyToRespawn)) return;
    lair.wave++;
    lair.rest = LAIR_REST;
    const count = Math.min(lair.group.members.length, 3 + lair.wave);
    lair.group.members.slice(0, count).forEach((e, i) => {
      // They rise all around the lair; witches appear in a puff of smoke.
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.5;
      const r = t.def.id === 'vampire' ? 3 + Math.random() * (CASTLE_PLATFORM_R - 4.5) : arena.r * (0.45 + Math.random() * 0.3);
      const x = arena.x + Math.sin(a) * r;
      const z = arena.z + Math.cos(a) * r;
      const fromGround = e.faction !== 'witch';
      e.spawn(x, z, fromGround);
      if (!fromGround) ctx.particles.burst(new THREE.Vector3(x, e.pos.y + 1.4, z), 0x6a4a8a, 20, 4);
    });
    lair.group.alerted = true;
    sfx.warHorn();
    const lairName = t.def.requires ? "Zomawi's sanctum" : `${t.def.leader.title}'s lair`;
    this.events.announce(`${lairName} · Wave ${lair.wave}`, `${count} enemies rise`);
  }

  /** The nearest leader's lair (for the objective once the war is won). */
  private nearestLair(from: THREE.Vector3) {
    return this.territories.reduce((a, b) =>
      Math.hypot(b.def.arena.x - from.x, b.def.arena.z - from.z) < Math.hypot(a.def.arena.x - from.x, a.def.arena.z - from.z) ? b : a,
    );
  }

  /** Brings a leader's minions in: risen undead, fresh thralls, or the Witch Queen's mirror images. */
  summonMinions(around: Enemy, count: number, ctx: GameContext) {
    const t = this.territories.find((tt) => tt.leader === around);
    if (!t) return;
    const { arena } = t.def;
    let raised = 0;
    for (const m of t.minions) {
      if (raised >= count) break;
      if (!m.readyToRespawn) continue;
      const a = Math.random() * Math.PI * 2;
      const r = 4 + Math.random() * 3;
      let x = around.pos.x + Math.sin(a) * r;
      let z = around.pos.z + Math.cos(a) * r;
      const dx = x - arena.x;
      const dz = z - arena.z;
      const d = Math.hypot(dx, dz);
      // In the goo castle, minions appear up on the platform.
      const maxR = t.def.id === 'vampire' ? CASTLE_PLATFORM_R - 1.5 : arena.r - 2.5;
      if (d > maxR) {
        x = arena.x + (dx / d) * maxR;
        z = arena.z + (dz / d) * maxR;
      }
      // The dead and the thralls claw out of the ground; the queen's decoys appear in smoke.
      const decoy = t.def.id === 'witch';
      m.spawn(x, z, !decoy);
      if (decoy) ctx.particles.burst(new THREE.Vector3(x, m.pos.y + 1.4, z), 0x6a4a8a, 24, 4);
      raised++;
    }
    t.leaderGroup.alerted = true;
  }

  /**
   * Where the hero should head next: the land they're standing in if it's
   * still held by the enemy, otherwise the open land with the lowest
   * recommended level. Within a land: outposts first, then the leader.
   */
  objective(from: THREE.Vector3, heroLevel: number): Objective {
    const open = this.territories.filter((t) => this.isOpen(t) && !this.isLiberated(t));
    if (open.length === 0) {
      // The war is won, but the leaders' lairs still stir.
      const lair = this.nearestLair(from);
      return { text: 'The war is won · Enemies still rise in the leaders\' lairs', at: new THREE.Vector3(lair.def.arena.x, 0, lair.def.arena.z) };
    }
    const here = open.find((t) => territoryWeight(t.def, from.x, from.z) > 0.5);
    const t = here ?? open.reduce((a, b) => (b.def.recommendedLevel < a.def.recommendedLevel ? b : a));
    const advice = heroLevel < t.def.recommendedLevel ? ` (recommended level ${t.def.recommendedLevel})` : '';

    const holding = t.outposts.find((o) => o.phase === 'counterattack');
    if (holding) return { text: `Hold ${holding.def.name} against the counterattack!`, at: new THREE.Vector3(holding.def.x, 0, holding.def.z) };
    const remaining = t.outposts.filter((o) => o.phase === 'garrison');
    if (remaining.length > 0) {
      const dist = (o: Outpost) => Math.hypot(o.def.x - from.x, o.def.z - from.z);
      const next = remaining.reduce((a, b) => (dist(b) < dist(a) ? b : a));
      const left = remaining.length === 1 ? 'the last outpost' : `${remaining.length} outposts left`;
      const verb = t.def.requires ? 'Storm' : 'Capture';
      return { text: `${verb} ${next.def.name} (${left})${advice}`, at: new THREE.Vector3(next.def.x, 0, next.def.z) };
    }
    return { text: `Defeat ${t.def.leader.title}${advice}`, at: this.centers.get(t.def.id)!.clone() };
  }

  /** 0..1 gloom per land at a position for the sky and fog. Lifts once its leader falls. */
  gloomAt(pos: THREE.Vector3): Record<TerritoryId, number> {
    const out = { zombie: 0, witch: 0, vampire: 0, fortress: 0 };
    for (const t of this.territories) out[t.def.id] = territoryWeight(t.def, pos.x, pos.z) * (this.isLiberated(t) ? 0.25 : 1);
    return out;
  }

  private activate(cp: Checkpoint, title: string, detail: string, sound = sfx.checkpoint) {
    this.current = cp;
    sound();
    this.events.checkpointReached(cp);
    this.events.announce(title, detail);
  }

  /** The garrison has fallen; the enemy sends a counterattack to retake the outpost. */
  private counterattack(o: Outpost, ctx: GameContext) {
    o.phase = 'counterattack';
    o.group.alerted = true;
    o.wave.forEach((e, i) => {
      // They arrive from all sides at the edge of the clearing.
      const a = (i / o.wave.length) * Math.PI * 2 + Math.random() * 0.6;
      const r = o.def.flatRadius - 2;
      const x = o.def.x + Math.sin(a) * r;
      const z = o.def.z + Math.cos(a) * r;
      const fromGround = e.faction !== 'witch';
      e.spawn(x, z, fromGround);
      if (!fromGround) ctx.particles.burst(new THREE.Vector3(x, e.pos.y + 1.4, z), 0x6a4a8a, 20, 4);
    });
    sfx.warHorn();
    this.events.announce('Counterattack!', `Hold ${o.def.name}`);
  }

  private capture(t: Territory, o: Outpost) {
    o.phase = 'captured';
    o.checkpoint.unlocked = true;
    o.checkpoint.banner.setRaised(true, true);
    this.events.awardXp(OUTPOST_XP, new THREE.Vector3(o.def.x, 3, o.def.z));
    this.touching = o.checkpoint.id;
    this.activate(o.checkpoint, 'Outpost captured', `${o.def.name} · Game saved`, sfx.victoryHorn);
    if (this.arenaOpen(t) && t.bossState === 'sealed') {
      t.bossState = 'waiting';
      this.world.gates[t.def.id].open();
      sfx.roar();
      this.events.announce(`The way to ${t.def.leader.title} is open`, `${t.def.gate.name} awaits`);
    }
  }

  private spawnPatrol(t: Territory, rise: boolean) {
    if (this.isLiberated(t) || !this.isOpen(t)) {
      for (const e of t.patrol.members) e.makeDormant();
      return;
    }
    const route = t.def.patrol.route;
    const p = route[t.patrolLeg % route.length];
    t.patrol.members.forEach((e, i) => {
      const a = (i / t.patrol.members.length) * Math.PI * 2;
      e.spawn(p.x + Math.sin(a) * 2, p.z + Math.cos(a) * 2, rise);
    });
  }

  private updatePatrol(t: Territory, dt: number) {
    if (t.patrol.members.length === 0) return;
    if (t.patrol.cleared) {
      t.patrolRespawn += dt;
      if (t.patrolRespawn >= PATROL_RESPAWN && t.patrol.members.every((e) => e.readyToRespawn)) {
        t.patrolRespawn = 0;
        t.patrolLeg++;
        this.spawnPatrol(t, true);
      }
      return;
    }
    if (t.patrol.alerted) return;
    t.patrolMove -= dt;
    if (t.patrolMove <= 0) {
      // Move the pack's home to the next point on its route; they wander over.
      t.patrolMove = PATROL_MOVE;
      t.patrolLeg++;
      const route = t.def.patrol.route;
      const p = route[t.patrolLeg % route.length];
      t.patrol.members.forEach((e, i) => {
        const a = (i / t.patrol.members.length) * Math.PI * 2;
        e.home.set(p.x + Math.sin(a) * 2, 0, p.z + Math.cos(a) * 2);
      });
    }
  }

  private startBossFight(t: Territory, ctx: GameContext) {
    t.bossState = 'fighting';
    ctx.arenaLock = { x: t.def.arena.x, z: t.def.arena.z, r: t.def.arena.r, group: t.leaderGroup };
    this.world.gates[t.def.id].close();
    t.leader.fightActive = true;
    t.leaderGroup.alerted = true;
    // Bring the squad (and a hero left outside) inside before the gate shuts.
    const arena = this.centers.get(t.def.id)!;
    const inside = ctx.players.find((h) => h.alive && h.pos.distanceTo(arena) < t.def.arena.r - 1.5) ?? ctx.leader;
    for (const a of ctx.allies) {
      if (a.alive && a.pos.distanceTo(arena) > t.def.arena.r - 1.5) {
        a.reinforce(inside.pos.x + (Math.random() - 0.5) * 3, inside.pos.z + (Math.random() - 0.5) * 3);
      }
    }
    for (const h of ctx.players) {
      if (h !== inside && h.pos.distanceTo(arena) > t.def.arena.r - 1.5) h.teleport(inside.pos.x + 1.5, inside.pos.z, inside.yaw);
    }
    if (t.def.id === 'witch') sfx.cackle(1);
    else if (t.def.id === 'vampire') sfx.bats(1);
    else sfx.roar();
    ctx.addShake(0.4);
    this.events.bossStarted(t.def.leader.title);
    this.events.say(t.def.leader.title, t.def.leader.introLine);
  }

  private endBossFight(t: Territory, ctx: GameContext) {
    t.bossState = 'defeated';
    ctx.arenaLock = null;
    this.leaders.add(t.def.leader.id);
    this.world.gates[t.def.id].open();
    ctx.projectiles.clear();
    // With their leader gone, the rest of this army falls where it stands (all of them, for Zomawi).
    for (const e of ctx.enemies) {
      if (e.alive && (t.def.requires || e.faction === t.leader.faction)) e.collapse(ctx);
    }
    this.events.bossEnded();
    this.events.leaderDefeated(t.def.leader.id, t.leader.pos.clone());
    this.events.say(t.def.leader.title, t.def.leader.deathLine);
    t.victoryTimer = 3;
    this.events.save();
  }

  private afterVictory(t: Territory) {
    if (t.def.requires) {
      this.events.victory();
      return;
    }
    const left = ARMY_LEADERS.length - this.armyLeadersDefeated;
    this.events.announce(t.def.liberatedTitle, left > 0 ? `${left} ${left === 1 ? 'army remains' : 'armies remain'}` : 'All three armies are broken');
    const fortress = this.fortress;
    if (left === 0 && fortress.bossState === 'sealed' && !this.isLiberated(fortress)) this.unsealFortress(fortress);
  }

  /** The three leaders are dead: Zomawi's seal breaks and the fortress garrison musters. */
  private unsealFortress(t: Territory) {
    this.world.seal.set(false);
    t.gate.unlocked = true;
    t.gate.banner.setRaised(true, true);
    for (const o of t.outposts) this.resetOutpost(o, false, true);
    t.leader.spawn(t.def.throne.x, t.def.throne.z);
    t.bossState = 'sealed'; // until the courtyard falls
    sfx.roar();
    this.events.announce("Zomawi's seal is broken", 'The fortress lies open to the south');
    this.events.save();
  }
}
