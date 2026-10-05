/**
 * Pure Necro Slider rules. No Foundry globals.
 * Recommendations from the module plan are the behavior here.
 */

export const THRESHOLDS = Object.freeze([25, 50, 75, 100]);

export const DIVINE_SMITE_IDENTIFIER = "divine-smite";

export const DEFAULT_ACTOR_NAME = "Dagobert Seesdem";

/**
 * Clamp a stored slider to a whole number from 0 through 100.
 * @param {unknown} value
 * @returns {number}
 */
export function clampScale(value) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

/**
 * A missing flag is the empty default, which reads as 0.
 * That 0 is not a story start.
 * @param {unknown} stored
 * @returns {number}
 */
export function readScale(stored) {
  if (stored === undefined || stored === null || stored === "") return 0;
  return clampScale(stored);
}

/**
 * Attack penalty against a creature whose type value is undead.
 * @param {unknown} scale
 * @returns {number}
 */
export function penaltyForScale(scale) {
  const n = clampScale(scale);
  if (n >= 100) return -10;
  if (n >= 75) return -7;
  if (n >= 50) return -4;
  if (n >= 25) return -2;
  return 0;
}

/**
 * Slider 0 and slider 100 do not need a d100.
 * @param {unknown} scale
 * @returns {boolean}
 */
export function needsSmiteRoll(scale) {
  const n = clampScale(scale);
  return n > 0 && n < 100;
}

/**
 * Equal to or lower than the slider is necrotic. Higher stays radiant.
 * @param {unknown} scale
 * @param {number|null} face  A d100 face from 1 to 100, or null when the die is not rolled.
 * @returns {{ necrotic: boolean, face: number|null }}
 */
export function smiteDamageType(scale, face) {
  const n = clampScale(scale);
  if (n <= 0) return { necrotic: false, face: null };
  if (n >= 100) return { necrotic: true, face: null };
  if (!Number.isInteger(face) || face < 1 || face > 100) {
    throw new RangeError("A d100 face must be an integer from 1 to 100.");
  }
  return { necrotic: face <= n, face };
}

/**
 * @param {string|undefined} identifier
 * @returns {boolean}
 */
export function isDivineSmiteIdentifier(identifier) {
  return identifier === DIVINE_SMITE_IDENTIFIER;
}

/**
 * Set the in-memory roll config type for this Divine Smite use.
 * Does not receive, and therefore does not change, any other activity.
 * @param {{ rolls?: Array<{ parts?: string[], options?: object }> }} config
 * @param {boolean} necrotic
 */
export function setSmiteTypeOnConfig(config, necrotic) {
  const type = necrotic ? "necrotic" : "radiant";
  for (const roll of config?.rolls ?? []) {
    roll.options ??= {};
    roll.options.type = type;
    roll.options.types = [type];
    if (Array.isArray(roll.parts)) {
      roll.parts = roll.parts.map(part => String(part).replace(/\[radiant\]/gi, `[${type}]`));
    }
  }
  return config;
}

/**
 * @param {unknown} current
 * @param {unknown} delta
 * @returns {{ previous: number, value: number, wouldBe: number, changed: boolean }}
 */
export function nextScale(current, delta) {
  const previous = clampScale(current);
  const points = Math.trunc(Number(delta));
  const added = Number.isFinite(points) ? points : 0;
  const wouldBe = previous + added;
  const value = clampScale(wouldBe);
  return { previous, value, wouldBe, changed: value !== previous };
}

/**
 * Thresholds crossed by one change, lowest first. Already-fired ones stay quiet.
 * @param {unknown} previous
 * @param {unknown} next
 * @param {number[]} [fired]
 * @returns {number[]}
 */
export function thresholdsCrossed(previous, next, fired = []) {
  const from = clampScale(previous);
  const to = clampScale(next);
  const done = new Set(fired);
  return THRESHOLDS.filter(threshold => from < threshold && to >= threshold && !done.has(threshold));
}

/**
 * Drop thresholds the scale has fallen below, and keep the ones just crossed.
 * @param {unknown} value
 * @param {number[]} [fired]
 * @param {number[]} [crossed]
 * @returns {number[]}
 */
export function firedAfterChange(value, fired = [], crossed = []) {
  const n = clampScale(value);
  const kept = fired.filter(threshold => threshold <= n);
  return [...new Set([...kept, ...crossed])].sort((a, b) => a - b);
}

/**
 * Creature type must be the system value "undead". Custom text is not a guess.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isUndeadTypeValue(value) {
  return value === "undead";
}

/**
 * Points for one event. Call this once per cast or once per damage application.
 * @param {object} event
 * @param {"cast"|"damage"} event.kind
 * @param {boolean} [event.isBoundActor]
 * @param {boolean} [event.cancelled]
 * @param {boolean} [event.isNecromancy]
 * @param {number|null} [event.slotLevel]
 * @param {number} [event.baseLevel]
 * @param {boolean} [event.hasNecrotic]
 * @param {boolean} [event.isDivineSmite]
 * @param {boolean} [event.alreadyCountedAsCast]
 * @param {boolean} [event.alreadyCountedUse]
 * @returns {{ points: number, reason: string }}
 */
export function creditForEvent(event) {
  if (!event || event.cancelled || event.isBoundActor === false) {
    return { points: 0, reason: "ignored" };
  }
  if (event.kind === "cast") return creditCast(event);
  if (event.kind === "damage") return creditDamage(event);
  return { points: 0, reason: "ignored" };
}

/**
 * @param {object} event
 * @returns {{ points: number, reason: string }}
 */
function creditCast(event) {
  if (!event.isNecromancy) return { points: 0, reason: "not-necromancy" };
  const slot = positiveInt(event.slotLevel);
  if (slot != null) return { points: slot, reason: "slot" };
  const base = Math.trunc(Number(event.baseLevel)) || 0;
  if (base <= 0) return { points: 1, reason: "cantrip" };
  return { points: base, reason: "base-level" };
}

/**
 * @param {object} event
 * @returns {{ points: number, reason: string }}
 */
function creditDamage(event) {
  if (!event.hasNecrotic) return { points: 0, reason: "no-necrotic" };
  if (event.isDivineSmite) return { points: 0, reason: "smite" };
  if (event.isNecromancy || event.alreadyCountedAsCast) return { points: 0, reason: "cast" };
  if (event.alreadyCountedUse) return { points: 0, reason: "already" };
  const slot = positiveInt(event.slotLevel);
  if (slot != null) return { points: slot, reason: "slot" };
  return { points: 1, reason: "no-slot" };
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function positiveInt(value) {
  if (value == null || value === "") return null;
  const n = Math.trunc(Number(value));
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

/**
 * Case-insensitive name match used when the world setting is still empty.
 * @param {string|undefined} name
 * @param {string} [expected]
 * @returns {boolean}
 */
export function nameMatches(name, expected = DEFAULT_ACTOR_NAME) {
  return String(name ?? "").trim().toLowerCase() === expected.trim().toLowerCase();
}
