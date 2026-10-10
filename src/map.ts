import { FORT, HUMAN_CAMP, TERRITORIES, type TerritoryId } from './layout';
import { WORLD_HALF } from './world';

export interface MapData {
  player: { x: number; z: number; yaw: number };
  /** Player 2's hero (two-player), drawn in blue. */
  player2: { x: number; z: number; yaw: number } | null;
  heroLevel: number;
  allies: { x: number; z: number }[];
  outposts: { x: number; z: number; name: string; captured: boolean }[];
  checkpoints: { x: number; z: number; current: boolean }[];
  liberated: Record<TerritoryId, boolean>;
  /** Lands that can be entered (the fortress is sealed until the three leaders fall). */
  open: Record<TerritoryId, boolean>;
  armyLeadersDefeated: number;
  objective: { x: number; z: number } | null;
}

const REGION_FILL: Record<TerritoryId, [string, string]> = {
  // [held by the enemy, liberated]
  zombie: ['rgba(95, 100, 55, 0.75)', 'rgba(110, 120, 70, 0.4)'],
  witch: ['rgba(80, 55, 110, 0.75)', 'rgba(90, 75, 120, 0.4)'],
  vampire: ['rgba(100, 30, 45, 0.75)', 'rgba(110, 60, 70, 0.4)'],
  fortress: ['rgba(40, 12, 16, 0.8)', 'rgba(70, 50, 50, 0.4)'],
};

const LEADER_ICON: Record<TerritoryId, string> = { zombie: '♛', witch: '✦', vampire: '♜', fortress: '☬' };

/**
 * Draws the world map, north up. The world's +Z is north and -X is east,
 * so x is mirrored on screen.
 */
export function drawMap(canvas: HTMLCanvasElement, data: MapData) {
  const size = canvas.width;
  const g = canvas.getContext('2d')!;
  const sx = (x: number) => ((WORLD_HALF - x) / (WORLD_HALF * 2)) * size;
  const sy = (z: number) => ((WORLD_HALF - z) / (WORLD_HALF * 2)) * size;
  const sr = (r: number) => (r / (WORLD_HALF * 2)) * size;

  g.fillStyle = '#2a3322';
  g.fillRect(0, 0, size, size);

  const region = (x: number, z: number, r: number, fill: string, label: string, sub?: string, labelBelow = false) => {
    g.beginPath();
    g.arc(sx(x), sy(z), sr(r), 0, Math.PI * 2);
    g.fillStyle = fill;
    g.fill();
    g.fillStyle = 'rgba(242, 234, 216, 0.9)';
    g.font = `bold ${size / 38}px Georgia, serif`;
    g.textAlign = 'center';
    const ly = sy(z) + sr(r) * (labelBelow ? 0.62 : -0.62);
    g.fillText(label, sx(x), ly);
    if (sub) {
      g.font = `${size / 52}px Georgia, serif`;
      g.fillStyle = 'rgba(242, 234, 216, 0.65)';
      g.fillText(sub, sx(x), ly + size / 34);
    }
  };

  for (const t of TERRITORIES) {
    const free = data.liberated[t.id];
    const level = `Recommended level ${t.recommendedLevel}${data.heroLevel < t.recommendedLevel ? ' ⚠' : ''}`;
    const sub = free ? 'Liberated' : !data.open[t.id] ? `Sealed · ${data.armyLeadersDefeated} of 3 leaders defeated` : level;
    // Labels go below the region when its arena sits at the top of it.
    region(t.center.x, t.center.z, t.center.r, REGION_FILL[t.id][free ? 1 : 0], t.name, sub, t.id === 'zombie');
  }
  region(HUMAN_CAMP.x, HUMAN_CAMP.z, 14, 'rgba(160, 120, 70, 0.6)', 'Human Camp');
  region(FORT.x, FORT.z, FORT.r + 2, 'rgba(90, 120, 200, 0.6)', 'Fort Victory', 'Your base · shops');

  const icon = (x: number, z: number, glyph: string, color: string, px = size / 26) => {
    g.font = `${px}px Georgia, serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#000';
    g.fillText(glyph, sx(x) + 1, sy(z) + 1);
    g.fillStyle = color;
    g.fillText(glyph, sx(x), sy(z));
    g.textBaseline = 'alphabetic';
  };
  const label = (x: number, z: number, text: string) => {
    g.font = `${size / 54}px Georgia, serif`;
    g.textAlign = 'center';
    g.fillStyle = 'rgba(242, 234, 216, 0.8)';
    g.fillText(text, sx(x), sy(z) + size / 30);
  };

  for (const o of data.outposts) {
    icon(o.x, o.z, o.captured ? '⚑' : '☠', o.captured ? '#e2504a' : '#d8cfa0');
    label(o.x, o.z, o.name);
  }
  for (const c of data.checkpoints) {
    if (!c.current) continue;
    g.strokeStyle = '#ffd36b';
    g.lineWidth = 2;
    g.beginPath();
    g.arc(sx(c.x), sy(c.z), size / 40, 0, Math.PI * 2);
    g.stroke();
  }
  for (const t of TERRITORIES) {
    const free = data.liberated[t.id];
    icon(t.arena.x, t.arena.z, LEADER_ICON[t.id], free ? '#7a7a7a' : '#d9b24a', size / 20);
    label(t.arena.x, t.arena.z, free ? `${t.leader.title} (defeated)` : t.leader.title);
  }

  if (data.objective) {
    g.strokeStyle = 'rgba(255, 211, 107, 0.9)';
    g.setLineDash([6, 5]);
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(sx(data.player.x), sy(data.player.z));
    g.lineTo(sx(data.objective.x), sy(data.objective.z));
    g.stroke();
    g.setLineDash([]);
  }

  g.fillStyle = '#7fb0ff';
  for (const a of data.allies) {
    g.beginPath();
    g.arc(sx(a.x), sy(a.z), size / 140, 0, Math.PI * 2);
    g.fill();
  }

  // The heroes: arrows pointing the way they face (Player 2 in blue).
  const arrow = (hero: { x: number; z: number; yaw: number }, color: string) => {
    g.save();
    g.translate(sx(hero.x), sy(hero.z));
    g.rotate(-hero.yaw);
    const s = size / 45;
    g.beginPath();
    g.moveTo(0, -s);
    g.lineTo(s * 0.65, s * 0.7);
    g.lineTo(0, s * 0.35);
    g.lineTo(-s * 0.65, s * 0.7);
    g.closePath();
    g.fillStyle = color;
    g.strokeStyle = '#000';
    g.lineWidth = 2;
    g.fill();
    g.stroke();
    g.restore();
  };
  if (data.player2) arrow(data.player2, '#7fb8ff');
  arrow(data.player, '#fff');
}
