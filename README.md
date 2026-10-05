# Necro Slider

A Foundry VTT module for one paladin. It keeps a private 0–100 scale of how far Null has seeped into his vow, whispers that scale to his player and the GM, and can turn Divine Smite necrotic as the scale rises. The table does not get an announcement.

The default actor name is Dagobert Seesdem. The binding is a world setting, so a rename does not drop it, and another actor can be chosen later. v1 binds one actor.

## Requirements

- Foundry VTT 13.351
- dnd5e 5.3.3
- Midi-QOL, if that is how the table rolls damage. The module sets Divine Smite’s type on the in-memory damage config before those per-type rolls.

## Install

1. Copy this folder into your Foundry user data as `Data/modules/necro-slider`. The folder name and `module.json` id are both `necro-slider`.
2. In a world that uses Foundry 13.351 and dnd5e 5.3.3, enable **Necro Slider**.
3. As GM, open the character sheet. Use the skull control labeled **Necro Slider**.
4. If exactly one actor is named Dagobert Seesdem, the world binds that actor’s UUID on ready. If none match, or more than one matches, choose the actor in the control and save.
5. Set the starting number there. A missing flag reads as 0. That 0 is only the empty default, not the story start. This module does not read old combat logs.

The number is an actor flag in the world database. The bound actor is a world-scoped module setting. Both survive a reload. They are not client settings.

## What moves the scale

One event, one credit.

- A completed necromancy spell adds the slot level he actually spent. A cantrip adds 1. A leveled spell cast with no slot adds its base level. Animate Dead and Speak with Dead count here.
- Necrotic damage from anything else adds points when that damage is applied. A slot on a non-necromancy spell adds the slot level. A weapon, feature, or item with no slot adds 1.
- A necromancy spell that also deals necrotic damage counts on the cast. Later damage from that same spell, including concentration, does not add again.
- Divine Smite’s type flip does not add points.
- A dialog, a cancelled roll, damage he takes, and damage from another actor do not move the scale.
- At 100 the number stays. The GM still hears what it would have reached.
- Every automatic change has a one-step GM undo on that whisper.

Radiant and divine casts do not pull the scale down.

## Divine Smite

The module matches the item identifier `divine-smite`. In dnd5e 5.3.3 that identifier is on both the 2014 feature and the 2024 spell. Weapon damage and Radiant Strikes stay radiant. The owned item stays radiant.

Roll a d100 from 1 to 100. Equal to or lower than the slider, that use is necrotic. Higher, it stays radiant. Slider 0 is always radiant. Slider 100 is always necrotic. One d100 covers the smite and the extra die on that use. The public card shows the damage type. The d100 stays in the whisper.

## Thresholds

Breakpoints are 25, 50, 75, and 100. They fire when the scale moves from below the number to equal or above it, lowest first. They do not fire again until the scale is set below them and crosses them again.

Attack rolls against a creature whose type value is `undead` take −2 / −4 / −7 / −10. The penalty is in the attack roll, labeled Slipping vow. It is not an effect the player can switch off. A missing or custom type is not treated as undead. Saves are unchanged.

Features are added only when the GM clicks the whisper:

- 50: Lay on Hands, Necrotic. The item explains the mode. It does not spend the Lay on Hands pool.
- 75: Grave Command. The GM adjudicates. The module does not suppress a Channel Divinity option by itself.
- 100: Guided End, an oath checklist, or a hand-set alignment. The checklist does not add or delete a subclass.

Setting the starting number up from the empty 0 will offer every breakpoint that number crosses. Dismiss the ones that already happened.

## Tests

The dice, clamp, credit, and penalty rules run without Foundry:

```bash
node --test tests/rules.test.mjs
```
