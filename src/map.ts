import { HUMAN_CAMP, KING_ARENA, VAMPIRE_LAND, WITCH_LAND, ZOMAWI_FORTRESS, ZOMBIE_LAND } from './layout';
import { WORLD_HALF } from './world';

export interface MapData {
  player: { x: number; z: number; yaw: number };
  allies: { x: number; z: number }[];
  outposts: { x: number; z: number; name: string; captured: boolean }[];
  checkpoints: { x: number; z: number; current: boolean }[];
  kingDefeated: boolean;
  objective: { x: number; z: number } | null;
}

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
    g.fillStyle = 'rgba(242, 234, 216, 0.85)';
    g.font = `bold ${size / 38}px Georgia, serif`;
    g.textAlign = 'center';
    const ly = sy(z) + sr(r) * (labelBelow ? 0.62 : -0.55);
    g.fillText(label, sx(x), ly);
    if (sub) {
      g.font = `${size / 52}px Georgia, serif`;
      g.fillStyle = 'rgba(242, 234, 216, 0.55)';
      g.fillText(sub, sx(x), ly + size / 34);
    }
  };
  region(ZOMBIE_LAND.x, ZOMBIE_LAND.z, ZOMBIE_LAND.r, data.kingDefeated ? 'rgba(110, 120, 70, 0.55)' : 'rgba(95, 100, 55, 0.75)', 'Zombie Lands', data.kingDefeated ? 'Liberated' : undefined, true);
  region(WITCH_LAND.x, WITCH_LAND.z, WITCH_LAND.r, 'rgba(70, 50, 90, 0.45)', 'Witch Lands', 'Not yet reachable');
  region(VAMPIRE_LAND.x, VAMPIRE_LAND.z, VAMPIRE_LAND.r, 'rgba(90, 30, 40, 0.45)', 'Vampire Lands', 'Not yet reachable');
  region(ZOMAWI_FORTRESS.x, ZOMAWI_FORTRESS.z, ZOMAWI_FORTRESS.r, 'rgba(20, 15, 20, 0.6)', "Zomawi's Fortress", 'Sealed');
  region(HUMAN_CAMP.x, HUMAN_CAMP.z, 14, 'rgba(160, 120, 70, 0.6)', 'Human Camp');

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
    g.font = `${size / 50}px Georgia, serif`;
    g.textAlign = 'center';
    g.fillStyle = 'rgba(242, 234, 216, 0.8)';
    g.fillText(text, sx(x), sy(z) + size / 28);
  };

  for (const o of data.outposts) {
    icon(o.x, o.z, o.captured ? '⚑' : '☠', o.captured ? '#e2504a' : '#d8cfa0');
    label(o.x, o.z, o.name);
  }
  for (const c of data.checkpoints) {
    if (c.current) {
      g.strokeStyle = '#ffd36b';
      g.lineWidth = 2;
      g.beginPath();
      g.arc(sx(c.x), sy(c.z), size / 40, 0, Math.PI * 2);
      g.stroke();
    }
  }
  icon(KING_ARENA.x, KING_ARENA.z, '♛', data.kingDefeated ? '#7a7a7a' : '#d9b24a', size / 20);
  label(KING_ARENA.x, KING_ARENA.z + 2, data.kingDefeated ? 'Crypt (cleared)' : 'Crypt of the Zombie King');

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

  // The hero: an arrow pointing the way they face.
  const { x, z, yaw } = data.player;
  g.save();
  g.translate(sx(x), sy(z));
  g.rotate(-yaw);
  const s = size / 45;
  g.beginPath();
  g.moveTo(0, -s);
  g.lineTo(s * 0.65, s * 0.7);
  g.lineTo(0, s * 0.35);
  g.lineTo(-s * 0.65, s * 0.7);
  g.closePath();
  g.fillStyle = '#fff';
  g.strokeStyle = '#000';
  g.lineWidth = 2;
  g.fill();
  g.stroke();
  g.restore();
}
