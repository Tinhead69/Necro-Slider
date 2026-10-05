import assert from "node:assert/strict";
import test from "node:test";
import {
  clampScale,
  creditForEvent,
  firedAfterChange,
  isUndeadTypeValue,
  nameMatches,
  needsSmiteRoll,
  nextScale,
  penaltyForScale,
  readScale,
  setSmiteTypeOnConfig,
  smiteDamageType,
  thresholdsCrossed
} from "../scripts/rules.mjs";

test("d100 threshold: 0, equal, lower, higher, 100", () => {
  assert.equal(needsSmiteRoll(0), false);
  assert.deepEqual(smiteDamageType(0, null), { necrotic: false, face: null });

  assert.equal(needsSmiteRoll(25), true);
  assert.equal(smiteDamageType(25, 25).necrotic, true);
  assert.equal(smiteDamageType(25, 24).necrotic, true);
  assert.equal(smiteDamageType(25, 26).necrotic, false);

  assert.equal(needsSmiteRoll(100), false);
  assert.deepEqual(smiteDamageType(100, null), { necrotic: true, face: null });

  for (const slider of [1, 25, 50, 75, 99]) {
    for (let face = 1; face <= 100; face += 1) {
      assert.equal(smiteDamageType(slider, face).necrotic, face <= slider);
    }
  }
});

test("d100 rejects a face outside 1-100 when a roll is required", () => {
  assert.throws(() => smiteDamageType(50, 0), RangeError);
  assert.throws(() => smiteDamageType(50, 101), RangeError);
});

test("clamp and the empty default", () => {
  assert.equal(clampScale(-1), 0);
  assert.equal(clampScale(0), 0);
  assert.equal(clampScale(100), 100);
  assert.equal(clampScale(101), 100);
  assert.equal(clampScale(50.9), 50);
  assert.equal(clampScale("12"), 12);
  assert.equal(clampScale("nope"), 0);
  assert.equal(readScale(undefined), 0);
  assert.equal(readScale(null), 0);
  assert.equal(readScale(""), 0);
  assert.equal(readScale(40), 40);
});

test("a change at 100 stays put and reports the value it would have reached", () => {
  const step = nextScale(100, 3);
  assert.equal(step.value, 100);
  assert.equal(step.wouldBe, 103);
  assert.equal(step.changed, false);
  assert.deepEqual(thresholdsCrossed(step.previous, step.value, [25, 50, 75, 100]), []);
});

test("penalty bands are 0, −2, −4, −7, −10", () => {
  assert.equal(penaltyForScale(0), 0);
  assert.equal(penaltyForScale(24), 0);
  assert.equal(penaltyForScale(25), -2);
  assert.equal(penaltyForScale(49), -2);
  assert.equal(penaltyForScale(50), -4);
  assert.equal(penaltyForScale(74), -4);
  assert.equal(penaltyForScale(75), -7);
  assert.equal(penaltyForScale(99), -7);
  assert.equal(penaltyForScale(100), -10);
});

test("one credit: cast, damage, smite, cantrip, reroll, cancel", () => {
  const cast = creditForEvent({
    kind: "cast",
    isBoundActor: true,
    isNecromancy: true,
    slotLevel: 3,
    baseLevel: 1
  });
  const sameSpellDamage = creditForEvent({
    kind: "damage",
    isBoundActor: true,
    hasNecrotic: true,
    isNecromancy: true,
    alreadyCountedAsCast: true,
    slotLevel: 3
  });
  assert.equal(cast.points, 3);
  assert.equal(sameSpellDamage.points, 0);
  assert.equal(cast.points + sameSpellDamage.points, 3);

  assert.equal(creditForEvent({
    kind: "cast",
    isBoundActor: true,
    isNecromancy: true,
    baseLevel: 0,
    slotLevel: null
  }).points, 1);

  assert.equal(creditForEvent({
    kind: "cast",
    isBoundActor: true,
    isNecromancy: true,
    baseLevel: 2,
    slotLevel: null
  }).points, 2);

  assert.equal(creditForEvent({
    kind: "damage",
    isBoundActor: true,
    hasNecrotic: true,
    isDivineSmite: true,
    slotLevel: 2
  }).points, 0);

  assert.equal(creditForEvent({
    kind: "damage",
    isBoundActor: true,
    hasNecrotic: true,
    slotLevel: null
  }).points, 1);

  assert.equal(creditForEvent({
    kind: "damage",
    isBoundActor: true,
    hasNecrotic: true,
    isNecromancy: false,
    slotLevel: 2
  }).points, 2);

  assert.equal(creditForEvent({
    kind: "damage",
    isBoundActor: true,
    hasNecrotic: true,
    alreadyCountedUse: true
  }).points, 0);

  assert.equal(creditForEvent({
    kind: "damage",
    isBoundActor: true,
    hasNecrotic: true,
    cancelled: true
  }).points, 0);

  assert.equal(creditForEvent({
    kind: "cast",
    isBoundActor: true,
    isNecromancy: true,
    cancelled: true,
    slotLevel: 9
  }).points, 0);

  assert.equal(creditForEvent({
    kind: "damage",
    isBoundActor: true,
    hasNecrotic: false
  }).points, 0);

  assert.equal(creditForEvent({
    kind: "cast",
    isBoundActor: false,
    isNecromancy: true,
    slotLevel: 9
  }).points, 0);

  assert.equal(creditForEvent({
    kind: "cast",
    isBoundActor: true,
    isNecromancy: false,
    slotLevel: 4
  }).points, 0);
});

test("thresholds fire in order, once, until the scale is set back below them", () => {
  assert.deepEqual(thresholdsCrossed(0, 80, []), [25, 50, 75]);
  assert.deepEqual(thresholdsCrossed(24, 25, []), [25]);
  assert.deepEqual(thresholdsCrossed(25, 40, [25]), []);
  assert.deepEqual(thresholdsCrossed(100, 100, [25, 50, 75, 100]), []);
  assert.deepEqual(firedAfterChange(20, [25, 50], []), []);
  assert.deepEqual(firedAfterChange(50, [25], [50]), [25, 50]);
});

test("smite type is written only onto the config it is given", () => {
  const smite = {
    rolls: [
      { parts: ["2d8[radiant]", "1d8"], options: { type: "radiant", types: ["radiant"] } },
      { parts: ["1d8"], options: { type: "", types: [] } }
    ]
  };
  const weapon = {
    rolls: [{ parts: ["1d8[radiant]"], options: { type: "radiant", types: ["radiant"] } }]
  };
  setSmiteTypeOnConfig(smite, true);
  assert.equal(smite.rolls[0].options.type, "necrotic");
  assert.deepEqual(smite.rolls[0].options.types, ["necrotic"]);
  assert.equal(smite.rolls[0].parts[0], "2d8[necrotic]");
  assert.equal(smite.rolls[1].options.type, "necrotic");
  assert.equal(weapon.rolls[0].options.type, "radiant");
  assert.equal(weapon.rolls[0].parts[0], "1d8[radiant]");
});

test("undead detection does not guess, and the default name matches once", () => {
  assert.equal(isUndeadTypeValue("undead"), true);
  assert.equal(isUndeadTypeValue("Undead"), false);
  assert.equal(isUndeadTypeValue("custom"), false);
  assert.equal(isUndeadTypeValue(""), false);
  assert.equal(isUndeadTypeValue(undefined), false);
  assert.equal(nameMatches("dagobert seesdem"), true);
  assert.equal(nameMatches(" Dagobert Seesdem "), true);
  assert.equal(nameMatches("Dagobert"), false);
});
