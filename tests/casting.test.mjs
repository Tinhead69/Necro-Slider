import assert from "node:assert/strict";
import test from "node:test";

test("completed radiant spell casts update the actor once and whisper the reduction", async () => {
  const hooks = new Map();
  const once = new Map();
  const messages = [];
  let state = { value: 50, fired: [25, 50] };
  const actor = {
    uuid: "Actor.dagobert", name: "Dagobert Seesdem", isOwner: true,
    getFlag: () => state,
    setFlag: async (_module, _flag, value) => { state = value; },
    testUserPermission: () => true
  };
  globalThis.Hooks = {
    once: (name, callback) => once.set(name, callback),
    on: (name, callback) => hooks.set(name, callback)
  };
  globalThis.game = {
    user: { isGM: true },
    users: [{ id: "gm", isGM: true }, { id: "player", isGM: false }],
    settings: { register() {}, get: () => actor.uuid }
  };
  globalThis.ChatMessage = {
    create: async data => messages.push(data), getSpeaker: () => ({})
  };
  try {
    await import("../scripts/module.mjs");
    once.get("init")();
    const cast = async (id, { type = "spell", types = new Set(["radiant"]), identifier = "", caster = actor } = {}) => {
      hooks.get("dnd5e.postUseActivity")({
        actor: caster,
        item: { uuid: `Item.${id}`, name: "Test spell", actor: caster, type, system: { identifier, level: 1 } },
        damage: { parts: [{ types }] }
      }, {}, { message: { id } });
      await new Promise(resolve => setImmediate(resolve));
    };
    await cast("radiant");
    assert.equal(state.value, 49);
    assert.equal(state.previous, 50);
    assert.deepEqual(state.fired, [25]);
    assert.ok(messages.some(message => message.content.includes("warmth")));
    assert.ok(messages.some(message => message.content.includes("Undo one step")));
    await cast("radiant");
    assert.equal(state.value, 49, "a repeated cast notification is ignored");
    await cast("healing", { types: [] });
    await cast("weapon", { type: "weapon" });
    await cast("smite", { identifier: "divine-smite" });
    await cast("other-actor", { caster: { uuid: "Actor.other" } });
    assert.equal(state.value, 49);
    state = { ...state, value: 0 };
    await cast("at-zero", { types: ["radiant"] });
    assert.equal(state.value, 0);
    state = { ...state, value: 100, fired: [25, 50, 75, 100] };
    await cast("at-hundred");
    assert.equal(state.value, 99);
    assert.deepEqual(state.fired, [25, 50, 75]);
  } finally {
    delete globalThis.Hooks;
    delete globalThis.game;
    delete globalThis.ChatMessage;
  }
});
