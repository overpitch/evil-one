import * as THREE from 'three';
import { Banner } from './banner';
import { createZombie, ZombieGroup, type Zombie } from './enemy';
import { ZombieKing } from './zombieKing';
import type { GameContext } from './types';
import { zombieLandWeight, type World } from './world';
import {
  CAMP_BANNER, KING_ARENA, KING_THRONE, PATROL_ROUTE, STRONGHOLD_GATE, ZOMBIE_OUTPOSTS, type OutpostDef, type ZombieKind,
} from './layout';
import type { SaveData } from './save';
import { OUTPOST_XP } from './progression';
import { sfx } from './audio';

export const ZOMBIE_KING_ID = 'zombie-king';

const TOUCH_RADIUS = 3;
const PATROL_KINDS: ZombieKind[] = ['shambler', 'shambler', 'shambler', 'runner'];
const PATROL_RESPAWN = 45;
const PATROL_MOVE = 25;
const MINION_COUNT = 6;

export interface Checkpoint {
  id: string;
  name: string;
  banner: Banner;
  /** The banner stands and can be used as a checkpoint. */
  unlocked: boolean;
}

export interface Outpost {
  def: OutpostDef;
  group: ZombieGroup;
  captured: boolean;
  checkpoint: Checkpoint;
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
  bossStarted(name: string): void;
  bossEnded(): void;
  save(): void;
}

/**
 * The zombie territory's story: outposts to capture, checkpoints, a roaming
 * patrol, and the Zombie King's arena.
 */
export class Campaign {
  readonly checkpoints: Checkpoint[] = [];
  readonly outposts: Outpost[] = [];
  readonly king: ZombieKing;
  readonly leaders = new Set<string>();
  current: Checkpoint;
  bossState: 'waiting' | 'fighting' | 'defeated' = 'waiting';

  private readonly camp: Checkpoint;
  private readonly gate: Checkpoint;
  private readonly patrol = new ZombieGroup();
  private patrolRespawn = 0;
  private patrolMove = PATROL_MOVE;
  private patrolLeg = 0;
  private readonly kingGroup = new ZombieGroup();
  private readonly minions: Zombie[] = [];
  private touching: string | null = null;
  private time = 0;
  private victoryTimer = -1;
  private readonly arenaCenter = new THREE.Vector3(KING_ARENA.x, 0, KING_ARENA.z);

  constructor(
    scene: THREE.Scene,
    private readonly world: World,
    enemies: Zombie[],
    private readonly events: CampaignEvents,
  ) {
    const checkpoint = (id: string, name: string, x: number, z: number): Checkpoint => {
      const cp = { id, name, banner: new Banner(scene, world.colliders, x, z), unlocked: false };
      this.checkpoints.push(cp);
      return cp;
    };
    const zombie = (kind: ZombieKind, group: ZombieGroup) => {
      const z = createZombie(scene, kind);
      z.group = group;
      group.members.push(z);
      enemies.push(z);
      return z;
    };

    this.camp = this.current = checkpoint(CAMP_BANNER.id, CAMP_BANNER.name, CAMP_BANNER.x, CAMP_BANNER.z);
    for (const def of ZOMBIE_OUTPOSTS) {
      const group = new ZombieGroup();
      for (const [kind] of def.spawns) zombie(kind, group);
      this.outposts.push({ def, group, captured: false, checkpoint: checkpoint(def.id, def.name, def.x, def.z) });
    }
    this.gate = checkpoint(STRONGHOLD_GATE.id, STRONGHOLD_GATE.name, STRONGHOLD_GATE.x, STRONGHOLD_GATE.z);
    for (const kind of PATROL_KINDS) zombie(kind, this.patrol);

    this.king = new ZombieKing(scene);
    this.king.group = this.kingGroup;
    this.kingGroup.members.push(this.king);
    enemies.push(this.king);
    for (let i = 0; i < MINION_COUNT; i++) {
      const m = zombie('shambler', this.kingGroup);
      m.wanderRadius = 3;
      this.minions.push(m);
    }
  }

  get kingDefeated() {
    return this.leaders.has(ZOMBIE_KING_ID);
  }

  /** Rebuilds the territory from a save (also used when respawning after death). */
  load(save: SaveData | null) {
    const captured = new Set(save?.captured ?? []);
    this.leaders.clear();
    for (const id of save?.leaders ?? []) this.leaders.add(id);

    for (const cp of [this.camp, this.gate]) {
      cp.unlocked = true;
      cp.banner.setRaised(true);
    }
    for (const o of this.outposts) {
      o.captured = captured.has(o.def.id);
      o.group.alerted = false;
      o.checkpoint.unlocked = o.captured;
      o.checkpoint.banner.setRaised(o.captured);
      o.group.members.forEach((z, i) => {
        if (o.captured) z.makeDormant();
        else z.spawn(o.def.x + o.def.spawns[i][1], o.def.z + o.def.spawns[i][2]);
      });
    }

    this.patrol.alerted = false;
    this.patrolLeg = 0;
    this.patrolRespawn = 0;
    this.patrolMove = PATROL_MOVE;
    this.spawnPatrol(false);

    if (this.bossState === 'fighting') this.events.bossEnded();
    this.kingGroup.alerted = false;
    for (const m of this.minions) m.makeDormant();
    if (this.kingDefeated) {
      this.king.makeDormant();
      this.bossState = 'defeated';
    } else {
      this.king.spawn(KING_THRONE.x, KING_THRONE.z);
      this.bossState = 'waiting';
    }
    this.world.gate.open();
    this.victoryTimer = -1;

    this.current = this.checkpoints.find((c) => c.id === save?.checkpoint && c.unlocked) ?? this.camp;
    // The hero respawns beside this banner; don't re-trigger it immediately.
    this.touching = this.current.id;
  }

  /** What the save file needs from the campaign. */
  saveFields(): Pick<SaveData, 'checkpoint' | 'captured' | 'leaders'> {
    return {
      checkpoint: this.current.id,
      captured: this.outposts.filter((o) => o.captured).map((o) => o.def.id),
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

    for (const o of this.outposts) {
      if (!o.captured && o.group.cleared) this.capture(o);
    }

    if (!this.kingDefeated) this.updatePatrol(dt);

    if (this.bossState === 'waiting' && player.alive && player.pos.distanceTo(this.arenaCenter) < KING_ARENA.r - 2) {
      this.startBossFight(ctx);
    }
    if (this.bossState === 'fighting' && !this.king.alive) this.endBossFight(ctx);

    if (this.victoryTimer >= 0) {
      this.victoryTimer -= dt;
      if (this.victoryTimer < 0) this.events.announce('Zombie territory liberated', 'The zombie army is broken');
    }
  }

  /** Raises dormant minions out of the ground around the king, inside the arena. */
  summonMinions(around: Zombie, count: number) {
    let raised = 0;
    for (const m of this.minions) {
      if (raised >= count) break;
      if (!m.readyToRespawn) continue;
      const a = Math.random() * Math.PI * 2;
      const r = 4 + Math.random() * 3;
      let x = around.pos.x + Math.sin(a) * r;
      let z = around.pos.z + Math.cos(a) * r;
      const dx = x - KING_ARENA.x;
      const dz = z - KING_ARENA.z;
      const d = Math.hypot(dx, dz);
      const maxR = KING_ARENA.r - 2.5;
      if (d > maxR) {
        x = KING_ARENA.x + (dx / d) * maxR;
        z = KING_ARENA.z + (dz / d) * maxR;
      }
      m.spawn(x, z, true);
      raised++;
    }
    this.kingGroup.alerted = true;
  }

  /** Where the hero should head next. */
  objective(from: THREE.Vector3): Objective {
    const open = this.outposts.filter((o) => !o.captured);
    if (open.length > 0) {
      const dist = (o: Outpost) => Math.hypot(o.def.x - from.x, o.def.z - from.z);
      const next = open.reduce((a, b) => (dist(b) < dist(a) ? b : a));
      return { text: `Capture ${next.def.name}`, at: new THREE.Vector3(next.def.x, 0, next.def.z) };
    }
    if (!this.kingDefeated) return { text: 'Defeat the Zombie King in his crypt', at: this.arenaCenter.clone() };
    return { text: 'The zombie army is broken. The witch and vampire lands await (coming soon).', at: null };
  }

  /** 0..1 gloom for the sky and fog at a position. Lifts once the king falls. */
  gloomAt(pos: THREE.Vector3) {
    return zombieLandWeight(pos.x, pos.z) * (this.kingDefeated ? 0.25 : 1);
  }

  private activate(cp: Checkpoint, title: string, detail: string) {
    this.current = cp;
    sfx.checkpoint();
    this.events.checkpointReached(cp);
    this.events.announce(title, detail);
  }

  private capture(o: Outpost) {
    o.captured = true;
    o.checkpoint.unlocked = true;
    o.checkpoint.banner.setRaised(true, true);
    this.events.awardXp(OUTPOST_XP, new THREE.Vector3(o.def.x, 3, o.def.z));
    this.touching = o.checkpoint.id;
    this.activate(o.checkpoint, 'Outpost captured', `${o.def.name} · Game saved`);
  }

  private spawnPatrol(rise: boolean) {
    if (this.kingDefeated) {
      for (const z of this.patrol.members) z.makeDormant();
      return;
    }
    const p = PATROL_ROUTE[this.patrolLeg % PATROL_ROUTE.length];
    this.patrol.members.forEach((z, i) => {
      const a = (i / this.patrol.members.length) * Math.PI * 2;
      z.spawn(p.x + Math.sin(a) * 2, p.z + Math.cos(a) * 2, rise);
    });
  }

  private updatePatrol(dt: number) {
    if (this.patrol.cleared) {
      this.patrolRespawn += dt;
      if (this.patrolRespawn >= PATROL_RESPAWN && this.patrol.members.every((z) => z.readyToRespawn)) {
        this.patrolRespawn = 0;
        this.patrolLeg++;
        this.spawnPatrol(true);
      }
      return;
    }
    if (this.patrol.alerted) return;
    this.patrolMove -= dt;
    if (this.patrolMove <= 0) {
      // Move the pack's home to the next point on its route; they wander over.
      this.patrolMove = PATROL_MOVE;
      this.patrolLeg++;
      const p = PATROL_ROUTE[this.patrolLeg % PATROL_ROUTE.length];
      this.patrol.members.forEach((z, i) => {
        const a = (i / this.patrol.members.length) * Math.PI * 2;
        z.home.set(p.x + Math.sin(a) * 2, 0, p.z + Math.cos(a) * 2);
      });
    }
  }

  private startBossFight(ctx: GameContext) {
    this.bossState = 'fighting';
    this.world.gate.close();
    this.king.fightActive = true;
    this.kingGroup.alerted = true;
    // Bring the squad inside before the gate shuts.
    for (const a of ctx.allies) {
      if (a.alive && a.pos.distanceTo(this.arenaCenter) > KING_ARENA.r - 1.5) {
        a.reinforce(ctx.player.pos.x + (Math.random() - 0.5) * 3, ctx.player.pos.z + 1 + Math.random() * 2);
      }
    }
    sfx.roar();
    ctx.addShake(0.4);
    this.events.bossStarted(this.king.title);
    this.events.say('The Zombie King', 'Fresh meat for my children!');
  }

  private endBossFight(ctx: GameContext) {
    this.bossState = 'defeated';
    this.leaders.add(ZOMBIE_KING_ID);
    this.world.gate.open();
    // With their king gone, the rest of the dead fall where they stand.
    for (const z of ctx.enemies) if (z.alive) z.collapse(ctx);
    this.events.bossEnded();
    this.events.say('The Zombie King', 'Zomawi... will... avenge... me...');
    this.victoryTimer = 3;
    this.events.save();
  }
}
