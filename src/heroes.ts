import { MAX_LEVEL } from './progression';

/**
 * Saved Player 2 heroes. Each has their own name, level, XP and weapons,
 * kept in this browser (separately from Player 1's save, so starting a new
 * game doesn't erase them).
 */
export interface Player2Hero {
  id: string;
  name: string;
  level: number;
  xp: number;
  weapons: string[];
  weapon: string;
}

const MAX_HEROES = 8;
let key = 'evil-one.player2-heroes';

/** Automated test runs use their own list. */
export function useTestHeroList() {
  key = 'evil-one.test-player2-heroes';
}

export function loadHeroes(): Player2Hero[] {
  try {
    const list = JSON.parse(localStorage.getItem(key) ?? '[]') as Partial<Player2Hero>[];
    return list.filter(
      (h): h is Player2Hero =>
        typeof h.id === 'string' &&
        typeof h.name === 'string' &&
        Number.isInteger(h.level) &&
        typeof h.xp === 'number' &&
        Array.isArray(h.weapons) &&
        typeof h.weapon === 'string',
    );
  } catch {
    return [];
  }
}

/** Adds or updates a hero; the most recently played comes first. */
export function saveHero(hero: Player2Hero) {
  const list = [{ ...hero, level: Math.min(hero.level, MAX_LEVEL) }, ...loadHeroes().filter((h) => h.id !== hero.id)].slice(0, MAX_HEROES);
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    /* storage unavailable: the hero just won't be remembered */
  }
}

export function deleteHero(id: string) {
  try {
    localStorage.setItem(key, JSON.stringify(loadHeroes().filter((h) => h.id !== id)));
  } catch {
    /* storage unavailable */
  }
}

export function newHero(name: string): Player2Hero {
  return { id: `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`, name, level: 1, xp: 0, weapons: ['sword'], weapon: 'sword' };
}
