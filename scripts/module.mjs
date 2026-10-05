import {
  DEFAULT_ACTOR_NAME,
  DIVINE_SMITE_IDENTIFIER,
  clampScale,
  creditForEvent,
  firedAfterChange,
  isDivineSmiteIdentifier,
  isUndeadTypeValue,
  nameMatches,
  needsSmiteRoll,
  nextScale,
  penaltyForScale,
  readScale,
  setSmiteTypeOnConfig,
  smiteDamageType,
  thresholdsCrossed
} from "./rules.mjs";

const MODULE_ID = "necro-slider";
const FLAG = "state";
const USE_MEMORY = 80;

/**
 * Verified against dnd5e release-5.3.3 and current Midi-QOL master (Foundry 13).
 * Listen to one hook of each V2 pair. postUseLinkedSpell is the Cast wrapper, not a second cast.
 * The scale moves on dnd5e.applyDamage, which Midi-QOL also calls after it updates HP.
 * The smite type is set in dnd5e.preRollDamage, which runs inside DamageRoll.buildConfigure
 * before the rolls exist and before resistance.
 */

const memory = {
  actorUuid: "",
  necromancy: new Set(),
  uses: new Set(),
  lastUse: new Map(),
  smite: new Map()
};

const PLAYER_LINES = {
  25: "The prayer lands, but the answer is thin. Cold sits under it.",
  50: "The Raven Queen is hard to hear. The dead do not feel like enemies.",
  75: "She is still there, and she is disappointed. Something else is willing to answer in her place.",
  100: "The cold is no longer an intrusion. It fits. The Raven Queen is silent."
};

const GM_LINES = {
  25: "Breakpoint 25. No feature change. Attack rolls against undead take −2, labeled Slipping vow.",
  50: "Breakpoint 50. Attack rolls against undead take −4. You may grant one item: Lay on Hands may spend its pool to deal that much necrotic to a creature he touches, instead of healing. One mode per use. This module does not spend the pool.",
  75: "Breakpoint 75. Attack rolls against undead take −7. You may suppress one divine Channel Divinity option he actually has. That suppression is yours to do. You may grant Grave Command: once per short rest, one undead that can hear him hesitates, and you adjudicate it. Start the oath conversation. The subclass stays as it is.",
  100: "Breakpoint 100. The scale locks at 100. Divine Smite is always necrotic. Attack rolls against undead take −10. For you only: he becomes more undead-aligned and supports Null and Tiamat because he comes to believe the takeover should be guided, not stopped. This module does not declare that the Raven Queen has cast him out. Alignment stays as written until you change it. The sheet stays his. Combat is not scripted."
};

const THRESHOLD_ACTIONS = {
  25: [],
  50: ["grant-lay-on-hands"],
  75: ["grant-grave-command", "oath-checklist"],
  100: ["grant-guided-end", "oath-checklist", "set-alignment", "dismiss"]
};

const ACTION_LABELS = {
  undo: "Undo one step",
  "grant-lay-on-hands": "Grant Lay on Hands, necrotic",
  "grant-grave-command": "Grant Grave Command",
  "grant-guided-end": "Apply Guided End",
  "oath-checklist": "Open oath checklist",
  "set-alignment": "Set alignment",
  dismiss: "Dismiss"
};

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "boundActor", {
    name: "Bound actor UUID",
    scope: "world",
    config: false,
    type: String,
    default: ""
  });

  Hooks.on("dnd5e.postUseActivity", onPostUseActivity);
  Hooks.on("dnd5e.preRollDamage", onPreRollDamage);
  Hooks.on("dnd5e.rollDamage", onRollDamage);
  Hooks.on("dnd5e.preRollAttack", onPreRollAttack);
  Hooks.on("dnd5e.calculateDamage", onCalculateDamage);
  Hooks.on("dnd5e.applyDamage", onApplyDamage);
  Hooks.on("midi-qol.preTargetDamageApplication", onMidiPreTarget);
  Hooks.on("getHeaderControlsApplicationV2", onHeaderControls);
  Hooks.on("renderChatMessageHTML", onRenderChat);
});

Hooks.once("ready", async () => {
  game.socket.on(`module.${MODULE_ID}`, onSocket);
  await ensureBinding();
  hydrate(boundActor());
});

/**
 * @param {Actor|null} actor
 */
function hydrate(actor) {
  memory.necromancy = new Set();
  memory.uses = new Set();
  memory.lastUse = new Map();
  memory.actorUuid = actor?.uuid ?? "";
  if (!actor) return;
  const state = readState(actor);
  memory.necromancy = new Set(state.necromancy);
  memory.uses = new Set(state.uses);
  memory.lastUse = new Map(Object.entries(state.lastUse));
}

/**
 * @returns {Actor|null}
 */
function boundActor() {
  const uuid = game.settings.get(MODULE_ID, "boundActor");
  if (!uuid) return null;
  const actor = fromUuidSync(uuid);
  return actor?.documentName === "Actor" ? actor : null;
}

/**
 * @param {Actor|null|undefined} actor
 * @returns {boolean}
 */
function isBoundActor(actor) {
  if (!actor) return false;
  const uuid = game.settings.get(MODULE_ID, "boundActor");
  return Boolean(uuid) && actor.uuid === uuid;
}

/**
 * @param {Actor} actor
 */
function readState(actor) {
  const data = actor.getFlag(MODULE_ID, FLAG) ?? {};
  return {
    value: Object.prototype.hasOwnProperty.call(data, "value") ? data.value : undefined,
    previous: data.previous ?? null,
    fired: Array.isArray(data.fired) ? data.fired.map(Number) : [],
    necromancy: Array.isArray(data.necromancy) ? data.necromancy : [],
    uses: Array.isArray(data.uses) ? data.uses : [],
    lastUse: data.lastUse && typeof data.lastUse === "object" ? data.lastUse : {}
  };
}

/**
 * @param {Actor} actor
 * @returns {number}
 */
function currentScale(actor) {
  return readScale(readState(actor).value);
}

async function ensureBinding() {
  if (!game.user.isGM) return;
  const current = game.settings.get(MODULE_ID, "boundActor");
  if (current && fromUuidSync(current)) return;
  const matches = game.actors.filter(actor => nameMatches(actor.name));
  if (matches.length === 1) {
    await game.settings.set(MODULE_ID, "boundActor", matches[0].uuid);
    return;
  }
  const detail = matches.length === 0
    ? `No actor is named ${DEFAULT_ACTOR_NAME}.`
    : `More than one actor is named ${DEFAULT_ACTOR_NAME}.`;
  ui.notifications.info(`${detail} Open that character's sheet and use Necro Slider to bind one.`);
}

/**
 * @param {Actor} actor
 * @param {object} state
 */
function rememberFromFlag(actor) {
  if (!actor) return;
  const state = readState(actor);
  for (const uuid of state.necromancy) memory.necromancy.add(uuid);
  for (const useId of state.uses) memory.uses.add(useId);
  for (const [uuid, meta] of Object.entries(state.lastUse)) {
    const local = memory.lastUse.get(uuid);
    if (!local || (meta?.at ?? 0) > (local.at ?? 0)) memory.lastUse.set(uuid, meta);
  }
}

function lastUseFor(actor, itemUuid) {
  if (!itemUuid) return null;
  const local = memory.lastUse.get(itemUuid) ?? null;
  const stored = actor ? readState(actor).lastUse[itemUuid] ?? null : null;
  if (!local) return stored;
  if (!stored) return local;
  return (stored.at ?? 0) > (local.at ?? 0) ? stored : local;
}

async function writeState(actor, state) {
  const existing = readState(actor);
  const uses = [...new Set([...existing.uses, ...(state.uses ?? []), ...memory.uses])].slice(-USE_MEMORY);
  const necromancy = [...new Set([...existing.necromancy, ...memory.necromancy])];
  const lastUse = { ...existing.lastUse };
  for (const [uuid, meta] of memory.lastUse) {
    const prior = lastUse[uuid];
    if (!prior || (meta?.at ?? 0) >= (prior.at ?? 0)) lastUse[uuid] = meta;
  }
  await actor.setFlag(MODULE_ID, FLAG, {
    value: state.value,
    previous: state.previous,
    fired: state.fired,
    necromancy,
    uses,
    lastUse
  });
  memory.necromancy = new Set(necromancy);
  memory.uses = new Set(uses);
  memory.lastUse = new Map(Object.entries(lastUse));
}

/**
 * @param {Actor} actor
 * @param {object} change
 */
async function commitScale(actor, change) {
  if (!actor) return;
  if (!actor.isOwner && !game.user.isGM) {
    game.socket.emit(`module.${MODULE_ID}`, { op: "scale", actorUuid: actor.uuid, change });
    return;
  }
  rememberFromFlag(actor);
  const state = readState(actor);
  if (change.useId && (memory.uses.has(change.useId) || state.uses.includes(change.useId))) return;
  if (change.useId) memory.uses.add(change.useId);

  const step = nextScale(readScale(state.value), change.points);
  const crossed = thresholdsCrossed(step.previous, step.value, state.fired);
  const fired = firedAfterChange(step.value, state.fired, crossed);
  await writeState(actor, {
    ...state,
    value: step.value,
    previous: step.changed ? step.previous : state.previous,
    fired,
    uses: change.useId ? [...state.uses, change.useId] : state.uses
  });
  await whisperTick(actor, change.source, step);
  for (const threshold of crossed) await whisperThreshold(actor, threshold);
}

/**
 * @param {object} payload
 */
async function onSocket(payload) {
  if (!game.user.isGM || payload?.op !== "scale") return;
  const actor = fromUuidSync(payload.actorUuid);
  if (actor?.documentName !== "Actor") return;
  await commitScale(actor, payload.change);
}

/**
 * @param {Activity} activity
 * @param {object} usageConfig
 * @param {object} results
 */
function onPostUseActivity(activity, usageConfig, results) {
  const item = activity?.item;
  const actor = activity?.actor ?? item?.actor;
  if (!isBoundActor(actor) || !item) return;
  rememberFromFlag(actor);

  if (isDivineSmiteIdentifier(item.system?.identifier)) memory.smite.delete(item.uuid);

  const isNecromancy = item.type === "spell" && item.system?.school === "nec";
  const baseLevel = item.type === "spell" ? Number(item.system?.level) || 0 : 0;
  const slotLevel = slotLevelFromUsage(item, usageConfig, results);
  const useId = results?.message?.id ? `cast:${results.message.id}` : "";
  memory.lastUse.set(item.uuid, {
    useId: results?.message?.id ?? "",
    slotLevel,
    isNecromancy,
    baseLevel,
    name: item.name,
    at: Date.now()
  });
  if (isNecromancy) memory.necromancy.add(item.uuid);

  const credit = creditForEvent({
    kind: "cast",
    isBoundActor: true,
    isNecromancy,
    slotLevel,
    baseLevel,
    cancelled: false
  });
  const source = describeSource(item.name, "cast", credit.reason, slotLevel, baseLevel);
  if (credit.points > 0) {
    void commitScale(actor, { points: credit.points, source, useId });
    return;
  }
  void persistMemory(actor);
}

/**
 * @param {Item} item
 * @param {object} usageConfig
 * @param {object} results
 * @returns {number|null}
 */
function slotLevelFromUsage(item, usageConfig, results) {
  const consume = usageConfig?.consume;
  const slotConsumed = consume === true || consume?.spellSlot === true;
  if (!slotConsumed) return null;
  const fromMessage = results?.message?.system?.spellLevel;
  if (Number.isInteger(fromMessage) && fromMessage > 0) return fromMessage;
  const slotKey = usageConfig?.spell?.slot;
  const slotData = item.actor?.system?.spells?.[slotKey];
  if (Number.isInteger(slotData?.level) && slotData.level > 0) return slotData.level;
  const scaling = Number(usageConfig?.scaling) || 0;
  const base = Number(item.system?.level) || 0;
  const level = base + scaling;
  return level > 0 ? level : null;
}

/**
 * @param {Actor} actor
 */
async function persistMemory(actor) {
  if (!actor?.isOwner && !game.user.isGM) return;
  const state = readState(actor);
  await writeState(actor, state);
}

/**
 * @param {object} config
 */
function onPreRollDamage(config) {
  const activity = config?.subject;
  const item = activity?.item;
  const actor = activity?.actor ?? item?.actor;
  if (!isBoundActor(actor) || !isDivineSmiteIdentifier(item?.system?.identifier)) return;

  let decision = memory.smite.get(item.uuid);
  if (!decision) {
    const scale = currentScale(actor);
    if (!needsSmiteRoll(scale)) {
      decision = { ...smiteDamageType(scale, null), scale, whispered: false };
    } else {
      const face = rollD100();
      decision = { ...smiteDamageType(scale, face), scale, whispered: false };
    }
    memory.smite.set(item.uuid, decision);
  }
  setSmiteTypeOnConfig(config, decision.necrotic);
}

/**
 * dnd5e.preRollDamage is not awaited, so the face has to exist before the hook returns.
 * @returns {number}
 */
function rollD100() {
  const roll = new Roll("1d100");
  roll.evaluateSync();
  const face = Math.trunc(Number(roll.total));
  if (face < 1 || face > 100) return 1;
  return face;
}

/**
 * @param {Roll[]} rolls
 * @param {{ subject?: Activity }} data
 */
async function onRollDamage(rolls, data) {
  const activity = data?.subject;
  const item = activity?.item;
  const actor = activity?.actor ?? item?.actor;
  if (!rolls?.length || !isBoundActor(actor) || !isDivineSmiteIdentifier(item?.system?.identifier)) return;

  const decision = memory.smite.get(item.uuid);
  if (decision && !decision.whispered) {
    decision.whispered = true;
    await whisperSmite(actor, decision);
  }
  if (!(item.isOwner || game.user.isGM)) return;
  try {
    await item.unsetFlag("dnd5e", `last.${activity.id}.damageType`);
  } catch (error) {
    console.warn(`${MODULE_ID} | could not clear the saved smite type`, error);
  }
}

/**
 * @param {object} config
 */
function onPreRollAttack(config) {
  const activity = config?.subject;
  const actor = activity?.actor ?? activity?.item?.actor;
  if (!isBoundActor(actor)) return;
  const penalty = penaltyForScale(currentScale(actor));
  if (!penalty || !targetsIncludeUndead()) return;
  for (const roll of config.rolls ?? []) {
    roll.parts ??= [];
    if (roll.parts.some(part => String(part).includes("Slipping vow"))) continue;
    roll.parts.push(`${penalty}[Slipping vow]`);
  }
}

/**
 * @returns {boolean}
 */
function targetsIncludeUndead() {
  const targets = game.user?.targets;
  if (!targets?.size) return false;
  for (const token of targets) {
    if (isUndeadTypeValue(token.actor?.system?.details?.type?.value)) return true;
  }
  return false;
}

/**
 * After resistance, record whether any necrotic damage is still above zero.
 * @param {Actor} _target
 * @param {object[]|object} damages
 * @param {object} options
 */
function onCalculateDamage(_target, damages, options) {
  if (!options) return;
  const list = Array.isArray(damages) ? damages : [];
  const necroticApplied = list.some(entry => entry?.type === "necrotic" && Number(entry.value) > 0);
  options.necroSlider = { ...(options.necroSlider ?? {}), necroticApplied };
  if (options.midi) {
    options.midi.necroSlider = { ...(options.midi.necroSlider ?? {}), necroticApplied };
  }
}

/**
 * @param {Token} _token
 * @param {{ item?: Item, workflow?: object, damageItem?: object }} data
 */
function onMidiPreTarget(_token, data) {
  const damageItem = data?.damageItem;
  const workflow = data?.workflow;
  if (!damageItem) return;
  const sourceItem = damageItem.damageSelector === "otherDamage"
    ? (workflow?.otherActivity?.item ?? data.item)
    : data.item;
  const actor = sourceItem?.actor ?? workflow?.actor;
  if (!isBoundActor(actor) || !sourceItem) return;

  rememberFromFlag(actor);
  const options = damageItem.calcDamageOptions ?? {};
  damageItem.calcDamageOptions = options;
  options.midi ??= {};
  const last = lastUseFor(actor, sourceItem.uuid);
  const detail = Array.isArray(damageItem.damageDetail) ? damageItem.damageDetail : [];
  const necroticApplied = detail.some(entry => entry?.type === "necrotic" && Number(entry.value) > 0);
  options.midi.sourceActorUuid = actor.uuid;
  options.midi.necroSlider = {
    ...(options.midi.necroSlider ?? {}),
    necroticApplied,
    itemUuid: sourceItem.uuid,
    identifier: sourceItem.system?.identifier ?? "",
    name: sourceItem.name,
    slotLevel: last?.slotLevel ?? null,
    useId: last?.useId || workflow?.id || "",
    actorUuid: actor.uuid,
    isNecromancy: sourceItem.type === "spell" && sourceItem.system?.school === "nec"
  };
}

/**
 * @param {Actor} target
 * @param {number} _amount
 * @param {object} options
 */
function onApplyDamage(target, _amount, options) {
  const source = resolveDamageSource(target, options);
  if (!source || !isBoundActor(source.actor)) return;
  rememberFromFlag(source.actor);
  const alreadyCast = memory.necromancy.has(source.itemUuid)
    || readState(source.actor).necromancy.includes(source.itemUuid)
    || source.isNecromancy;
  const useId = source.useId && source.targetUuid ? `${source.useId}:${source.targetUuid}` : "";
  const credit = creditForEvent({
    kind: "damage",
    isBoundActor: true,
    hasNecrotic: source.hasNecrotic,
    isDivineSmite: isDivineSmiteIdentifier(source.identifier),
    isNecromancy: alreadyCast,
    alreadyCountedAsCast: alreadyCast,
    alreadyCountedUse: useId ? memory.uses.has(useId) : false,
    slotLevel: alreadyCast ? null : source.slotLevel,
    cancelled: false
  });
  if (credit.points <= 0) return;
  const label = describeSource(source.name, "damage", credit.reason, source.slotLevel, 0);
  void commitScale(source.actor, { points: credit.points, source: label, useId });
}

/**
 * @param {Actor} target
 * @param {object} options
 */
function resolveDamageSource(target, options) {
  const marker = options?.midi?.necroSlider ?? {};
  const message = options?.originatingMessage ?? null;
  const itemUuid = marker.itemUuid
    ?? message?.flags?.dnd5e?.item?.uuid
    ?? message?.getFlag?.("dnd5e", "item.uuid")
    ?? "";
  const item = itemUuid ? fromUuidSync(itemUuid) : null;
  let actor = marker.actorUuid ? fromUuidSync(marker.actorUuid) : null;
  if (actor?.documentName !== "Actor") actor = item?.actor ?? null;
  if (!actor) {
    const speakerId = message?.speaker?.actor;
    const speaker = speakerId ? game.actors.get(speakerId) : null;
    actor = speaker ?? null;
  }
  if (!actor) {
    const sourceUuid = options?.midi?.sourceActorUuid;
    if (sourceUuid && sourceUuid !== target?.uuid) {
      const fromMidi = fromUuidSync(sourceUuid);
      if (fromMidi?.documentName === "Actor") actor = fromMidi;
    }
  }
  if (!actor) return null;

  const last = item ? lastUseFor(actor, item.uuid) : null;
  const usageId = message?.flags?.dnd5e?.originatingMessage ?? message?.getFlag?.("dnd5e", "originatingMessage");
  const usage = usageId ? game.messages.get(usageId) : null;
  const messageLevel = usage?.system?.spellLevel ?? message?.system?.spellLevel ?? null;
  const slotLevel = marker.slotLevel ?? last?.slotLevel ?? (Number.isInteger(messageLevel) ? messageLevel : null);
  const hasNecrotic = marker.necroticApplied ?? options?.necroSlider?.necroticApplied ?? rollsIncludeNecrotic(message);
  return {
    actor,
    itemUuid: item?.uuid ?? itemUuid,
    identifier: item?.system?.identifier ?? marker.identifier ?? "",
    name: item?.name ?? marker.name ?? "Necrotic damage",
    isNecromancy: marker.isNecromancy ?? (item?.type === "spell" && item.system?.school === "nec"),
    slotLevel,
    hasNecrotic: Boolean(hasNecrotic),
    useId: marker.useId || last?.useId || usageId || message?.id || "",
    targetUuid: options?.midi?.targetUuid || target?.uuid || ""
  };
}

/**
 * @param {ChatMessage|null} message
 * @returns {boolean}
 */
function rollsIncludeNecrotic(message) {
  const rolls = message?.rolls ?? [];
  return rolls.some(roll => roll.options?.type === "necrotic" && Number(roll.total) > 0);
}

/**
 * @param {string} name
 * @param {"cast"|"damage"} kind
 * @param {string} reason
 * @param {number|null} slotLevel
 * @param {number} baseLevel
 * @returns {string}
 */
function describeSource(name, kind, reason, slotLevel, baseLevel) {
  if (kind === "cast" && reason === "cantrip") return `${name}, cantrip, cast`;
  if (kind === "cast" && reason === "slot") return `${name}, slot ${slotLevel}, cast`;
  if (kind === "cast" && reason === "base-level") return `${name}, level ${baseLevel}, no slot, cast`;
  if (kind === "damage" && reason === "slot") return `${name}, slot ${slotLevel}, applied`;
  if (kind === "damage") return `${name}, applied`;
  return name;
}

/**
 * @param {number} scale
 * @returns {string}
 */
function smiteSentence(scale) {
  const n = clampScale(scale);
  if (n <= 0) return "Smite stays radiant.";
  if (n >= 100) return "Smite is always necrotic.";
  return `Smite flips when the d100 is ${n} or lower.`;
}

/**
 * @param {Actor} actor
 * @param {string} source
 * @param {{ previous: number, value: number, wouldBe: number, changed: boolean }} step
 */
async function whisperTick(actor, source, step) {
  const player = !step.changed && step.value >= 100
    ? "Something cold answers the blow. The scale stays at 100."
    : `Something cold answers the blow. ${step.previous} → ${step.value}.`;
  const move = step.changed
    ? `${step.previous} → ${step.value}`
    : `${step.value} → ${step.value} (would have reached ${step.wouldBe})`;
  const gm = `${actor.name}, ${source}. Scale ${move}. ${smiteSentence(step.value)}`;
  await whisperPair(actor, player, gm, step.changed ? ["undo"] : []);
}

/**
 * @param {Actor} actor
 * @param {number} threshold
 */
async function whisperThreshold(actor, threshold) {
  await whisperPair(
    actor,
    PLAYER_LINES[threshold],
    GM_LINES[threshold],
    THRESHOLD_ACTIONS[threshold] ?? []
  );
}

/**
 * @param {Actor} actor
 * @param {{ necrotic: boolean, face: number|null, scale: number }} decision
 */
async function whisperSmite(actor, decision) {
  let text;
  if (decision.face == null) {
    text = decision.necrotic
      ? "Divine Smite is necrotic. The slider is 100, so the d100 was not rolled. The scale stays put."
      : "Divine Smite stays radiant. The slider is 0, so the d100 was not rolled. The scale stays put.";
  } else {
    const type = decision.necrotic ? "necrotic" : "radiant";
    text = `Divine Smite d100 ${decision.face}. Slider ${decision.scale}. This use is ${type}. The scale stays put.`;
  }
  const ids = recipientIds(actor);
  if (!ids.length) return;
  await ChatMessage.create({
    content: whisperHtml(text),
    whisper: ids,
    speaker: ChatMessage.getSpeaker({ actor })
  });
}

/**
 * @param {Actor} actor
 * @param {string} playerText
 * @param {string} gmText
 * @param {string[]} actions
 */
async function whisperPair(actor, playerText, gmText, actions) {
  const gms = game.users.filter(user => user.isGM);
  const players = game.users.filter(user => !user.isGM && actor.testUserPermission(user, "OWNER"));
  if (!players.length) {
    await sendWhisper(actor, gmText, gms.map(user => user.id), actions);
    return;
  }
  await sendWhisper(actor, playerText, players.map(user => user.id), []);
  await sendWhisper(actor, gmText, gms.map(user => user.id), actions);
}

/**
 * @param {Actor} actor
 * @returns {string[]}
 */
function recipientIds(actor) {
  const ids = new Set();
  for (const user of game.users) {
    if (user.isGM || actor.testUserPermission(user, "OWNER")) ids.add(user.id);
  }
  return [...ids];
}

/**
 * @param {Actor} actor
 * @param {string} text
 * @param {string[]} whisper
 * @param {string[]} actions
 */
async function sendWhisper(actor, text, whisper, actions) {
  const ids = [...new Set(whisper.filter(Boolean))];
  if (!ids.length) return;
  await ChatMessage.create({
    content: whisperHtml(text, actor.uuid, actions),
    whisper: ids,
    speaker: ChatMessage.getSpeaker({ actor }),
    flags: {
      [MODULE_ID]: { actorUuid: actor.uuid, actions }
    }
  });
}

/**
 * @param {string} text
 * @param {string} [actorUuid]
 * @param {string[]} [actions]
 * @returns {string}
 */
function whisperHtml(text, actorUuid = "", actions = []) {
  const buttons = actions.map(action => (
    `<button type="button" data-necro-action="${action}" data-actor-uuid="${esc(actorUuid)}">${esc(ACTION_LABELS[action] ?? action)}</button>`
  )).join("");
  const row = buttons ? `<div class="necro-slider-actions">${buttons}</div>` : "";
  return `<div class="necro-slider-whisper"><p>${esc(text)}</p>${row}</div>`;
}

/**
 * @param {string} value
 * @returns {string}
 */
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[character]));
}

/**
 * @param {Application} app
 * @param {object[]} controls
 */
function onHeaderControls(app, controls) {
  const actor = app?.document;
  if (actor?.documentName !== "Actor") return;
  const canSee = game.user.isGM || actor.testUserPermission(game.user, "OWNER");
  if (!canSee || (!isBoundActor(actor) && !game.user.isGM)) return;
  controls.push({
    icon: "fa-solid fa-skull",
    label: game.i18n.localize("NECRO-SLIDER.Control"),
    onClick: () => openPanel(actor)
  });
}

/**
 * @param {ChatMessage} message
 * @param {HTMLElement} html
 */
function onRenderChat(message, html) {
  const actions = message.getFlag(MODULE_ID, "actions") ?? [];
  if (!actions.length || !game.user.isGM) return;
  const actorUuid = message.getFlag(MODULE_ID, "actorUuid") ?? "";
  const root = html.querySelector(".necro-slider-whisper") ?? html;
  let row = root.querySelector(".necro-slider-actions");
  if (!row) {
    row = document.createElement("div");
    row.className = "necro-slider-actions";
    root.append(row);
  }
  if (!row.querySelector("[data-necro-action]")) {
    for (const action of actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.necroAction = action;
      button.dataset.actorUuid = actorUuid;
      button.textContent = ACTION_LABELS[action] ?? action;
      row.append(button);
    }
  }
  row.querySelectorAll("[data-necro-action]").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      const actor = fromUuidSync(button.dataset.actorUuid);
      if (actor?.documentName !== "Actor") return;
      void handleAction(button.dataset.necroAction, actor);
    });
  });
}

/**
 * @param {string} action
 * @param {Actor} actor
 */
async function handleAction(action, actor) {
  if (!game.user.isGM) return;
  if (action === "undo") return undo(actor);
  if (action === "dismiss") {
    await sendWhisper(actor, "Dismissed. The sheet is unchanged.", game.users.filter(user => user.isGM).map(user => user.id), []);
    return;
  }
  if (action === "grant-lay-on-hands") return grantItem(actor, layOnHandsItem());
  if (action === "grant-grave-command") return grantItem(actor, graveCommandItem());
  if (action === "grant-guided-end") return grantGuidedEnd(actor);
  if (action === "oath-checklist") return oathChecklist(actor);
  if (action === "set-alignment") return promptAlignment(actor);
}

/**
 * @param {Actor} actor
 */
async function undo(actor) {
  const state = readState(actor);
  const current = readScale(state.value);
  if (state.previous == null || clampScale(state.previous) === current) {
    await sendWhisper(actor, "Nothing to undo.", game.users.filter(user => user.isGM).map(user => user.id), []);
    return;
  }
  const value = clampScale(state.previous);
  const fired = firedAfterChange(value, state.fired, []);
  await writeState(actor, { ...state, value, previous: value, fired });
  await sendWhisper(
    actor,
    `Undone. Scale ${current} → ${value}.`,
    game.users.filter(user => user.isGM).map(user => user.id),
    []
  );
}

/**
 * @param {Actor} actor
 * @param {object} itemData
 */
async function grantItem(actor, itemData) {
  const identifier = itemData.system.identifier;
  if (actor.items.some(item => item.system?.identifier === identifier)) {
    await sendWhisper(actor, `${itemData.name} is already on the sheet.`, gmIds(), []);
    return;
  }
  await actor.createEmbeddedDocuments("Item", [itemData]);
  await sendWhisper(actor, `Granted ${itemData.name}.`, gmIds(), []);
}

/**
 * @param {Actor} actor
 */
async function grantGuidedEnd(actor) {
  const existing = actor.effects.find(effect => effect.flags?.[MODULE_ID]?.guidedEnd || effect.name === "Guided End");
  if (existing) {
    await sendWhisper(actor, "Guided End is already on the sheet.", gmIds(), []);
    return;
  }
  await actor.createEmbeddedDocuments("ActiveEffect", [{
    name: "Guided End",
    icon: "icons/svg/skull.svg",
    description: "The cold is no longer an intrusion. It fits.",
    disabled: false,
    transfer: true,
    flags: { [MODULE_ID]: { guidedEnd: true } }
  }]);
  await sendWhisper(actor, "Applied Guided End. The attack penalty still comes from the slider, not from this effect.", gmIds(), []);
}

/**
 * @param {Actor} actor
 */
async function oathChecklist(actor) {
  const subclass = actor.items.find(item => item.type === "subclass");
  const alignment = actor.system?.details?.alignment || "unset";
  const text = [
    `Oath checklist for ${actor.name}.`,
    `Current subclass: ${subclass?.name ?? "none on the sheet"}.`,
    "Do not delete that subclass from here. Removing a subclass can wipe advancement already on the sheet. If it goes, you remove it.",
    "This module will not add a subclass item. Name what you intend to add, then add it yourself.",
    `Alignment is ${alignment} until you change it.`
  ].join(" ");
  await sendWhisper(actor, text, gmIds(), []);
}

/**
 * @param {Actor} actor
 */
async function promptAlignment(actor) {
  const current = actor.system?.details?.alignment ?? "";
  let value;
  try {
    value = await foundry.applications.api.DialogV2.prompt({
      window: { title: "Set alignment" },
      content: `<input name="alignment" type="text" value="${esc(current)}" autofocus>`,
      ok: {
        label: "Set alignment",
        callback: (_event, button) => button.form.elements.alignment.value
      },
      rejectClose: false
    });
  } catch {
    return;
  }
  if (value == null) return;
  await actor.update({ "system.details.alignment": String(value) });
  await sendWhisper(actor, `Alignment set to ${value || "blank"}.`, gmIds(), []);
}

/**
 * @returns {string[]}
 */
function gmIds() {
  return game.users.filter(user => user.isGM).map(user => user.id);
}

/**
 * @param {Actor} actor
 */
async function openPanel(actor) {
  const scale = isBoundActor(actor) ? currentScale(actor) : readScale(undefined);
  const bound = boundActor();
  const penalty = penaltyForScale(scale);
  const listed = new Map(game.actors.contents.map(candidate => [candidate.uuid, candidate]));
  if (!listed.has(actor.uuid)) listed.set(actor.uuid, actor);
  const selectedUuid = bound?.uuid || actor.uuid;
  const options = [...listed.values()]
    .map(candidate => {
      const selected = candidate.uuid === selectedUuid ? " selected" : "";
      return `<option value="${esc(candidate.uuid)}"${selected}>${esc(candidate.name)}</option>`;
    })
    .join("");
  const readout = [
    `<p><strong>${esc(actor.name)}</strong></p>`,
    `<p>${esc(bandLine(scale))} ${isBoundActor(actor) ? `${scale}. Slipping vow ${penalty}.` : "This actor is not the bound one."}</p>`,
    "<p>A missing value reads as 0. That 0 is only the empty default. The module does not read old combat logs.</p>"
  ];
  if (!game.user.isGM) {
    await foundry.applications.api.DialogV2.prompt({
      window: { title: "Necro Slider" },
      content: readout.join(""),
      ok: { label: "Close" },
      rejectClose: false
    });
    return;
  }
  const content = [
    ...readout,
    `<label>Scale <input name="scale" type="number" min="0" max="100" step="1" value="${scale}"></label>`,
    `<label>Bound actor <select name="actor"><option value="">Choose</option>${options}</select></label>`,
    `<p>Binding this sheet stores its UUID. A rename will not drop it. An unlinked token is a different actor until you bind that copy.</p>`
  ].join("");
  let result;
  try {
    result = await foundry.applications.api.DialogV2.prompt({
      window: { title: "Necro Slider" },
      content,
      ok: {
        label: "Save",
        callback: (_event, button) => ({
          scale: button.form.elements.scale.value,
          actorUuid: button.form.elements.actor.value
        })
      },
      rejectClose: false
    });
  } catch {
    return;
  }
  if (!result) return;
  if (result.actorUuid) await game.settings.set(MODULE_ID, "boundActor", result.actorUuid);
  const target = fromUuidSync(game.settings.get(MODULE_ID, "boundActor"));
  hydrate(target?.documentName === "Actor" ? target : null);
  if (!target || target.documentName !== "Actor") return;
  await setScale(target, result.scale);
}

/**
 * @param {number} scale
 * @returns {string}
 */
function bandLine(scale) {
  if (scale >= 100) return PLAYER_LINES[100];
  if (scale >= 75) return PLAYER_LINES[75];
  if (scale >= 50) return PLAYER_LINES[50];
  if (scale >= 25) return PLAYER_LINES[25];
  return "The vow holds.";
}

/**
 * @param {Actor} actor
 * @param {unknown} raw
 */
async function setScale(actor, raw) {
  const state = readState(actor);
  const from = readScale(state.value);
  const value = clampScale(raw);
  const crossed = thresholdsCrossed(from, value, state.fired);
  const fired = firedAfterChange(value, state.fired, crossed);
  await writeState(actor, { ...state, value, previous: value, fired });
  await sendWhisper(actor, `Scale set to ${value}. ${smiteSentence(value)}`, gmIds(), []);
  for (const threshold of crossed) await whisperThreshold(actor, threshold);
}

/**
 * @returns {object}
 */
function layOnHandsItem() {
  return {
    name: "Lay on Hands, Necrotic",
    type: "feat",
    img: "icons/svg/heal.svg",
    system: {
      description: {
        value: "<p>One mode per use. Spend the Lay on Hands pool to deal that much necrotic damage to a creature he touches, instead of healing. This item does not spend the pool. Deduct the same amount from Lay on Hands.</p>"
      },
      identifier: "lay-on-hands-necrotic",
      type: { value: "class", subtype: "" }
    }
  };
}

/**
 * @returns {object}
 */
function graveCommandItem() {
  return {
    name: "Grave Command",
    type: "feat",
    img: "icons/svg/skull.svg",
    system: {
      description: {
        value: "<p>Once per short rest. One undead that can hear him hesitates. The GM adjudicates. This item does not roll the hesitation.</p>"
      },
      identifier: "grave-command",
      type: { value: "class", subtype: "" }
    }
  };
}
