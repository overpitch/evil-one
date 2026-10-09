import * as THREE from 'three';
import { Banner } from './banner';
import { EnemyGroup, type Enemy } from './enemy';
import { createEnemy, createLeader } from './enemies';
import type { GameContext } from './types';
import { territoryWeight, type World } from './world';
import { ARMY_LEADERS, CAMP_BANNER, TERRITORIES, type EnemyKind, type OutpostDef, type TerritoryDef, type TerritoryId } from './layout';
import type { SaveData } from './save';
import { OUTPOST_XP } from './progression';
import { sfx } from './audio';

const TOUCH_RADIUS = 3;
const PATROL_RESPAWN = 45;
const PATROL_MOVE = 25;
/** Counterattack size, as a share of the outpost's garrison. */
const WAVE_SHARE = 0.7;

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
      this.territories.push({
        def,
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
    const player = ctx.player;

    // Touching a standing banner makes it the checkpoint (heals, reinforces, saves).
    if (player.alive) {
      const inside = this.checkpoints.find(
        (cp) => cp.unlocked && Math.hypot(player.pos.x - cp.banner.x, player.pos.z - cp.banner.z) < TOUCH_RADIUS,
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
      if (t.bossState === 'waiting' && player.alive && !this.activeFight && player.pos.distanceTo(arena) < t.def.arena.r - 2) {
        this.startBossFight(t, ctx);
      }
      if (t.bossState === 'fighting' && !t.leader.alive) this.endBossFight(t, ctx);
      if (t.victoryTimer >= 0) {
        t.victoryTimer -= dt;
        if (t.victoryTimer < 0) this.afterVictory(t);
      }
    }
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
      const maxR = arena.r - 2.5;
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
    if (open.length === 0) return { text: 'The war is won. The lands are free.', at: null };
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
    // Bring the squad inside before the gate shuts.
    const arena = this.centers.get(t.def.id)!;
    for (const a of ctx.allies) {
      if (a.alive && a.pos.distanceTo(arena) > t.def.arena.r - 1.5) {
        a.reinforce(ctx.player.pos.x + (Math.random() - 0.5) * 3, ctx.player.pos.z + (Math.random() - 0.5) * 3);
      }
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
