import { test } from "node:test";
import assert from "node:assert/strict";
import { DialogueBook, dialogueLines } from "../src/view/dialogue-lines";
import { BubbleMotion } from "../src/view/bubble-motion";
import { BubbleBudget } from "../src/view/bubble-budget";

test("bubble budget prioritizes needs, caps total and per-table speakers, and spaces ambient chatter", () => {
  const budget = new BubbleBudget();
  const candidates = [
    ...Array.from({ length: 40 }, (_, i) => ({ id: `chat-${i}`, group: `table-${i % 10}`, priority: 0 })),
    { id: "spill", group: "table-1", priority: 5 },
    { id: "fork", group: "table-2", priority: 5 },
    { id: "water", group: "table-3", priority: 4 },
    { id: "pay", group: "table-4", priority: 4 },
    { id: "server", group: "table-1", priority: 3 },
  ];
  const first = budget.choose(candidates, 0);
  assert.equal(first.length, 4);
  assert.deepEqual(new Set(first.map((c) => c.id)), new Set(["spill", "fork", "water", "pay"]));
  for (let time = 250; time < 50000; time += 250) {
    const chosen = budget.choose(candidates, time);
    assert.ok(chosen.length <= 4);
    assert.ok(chosen.filter((c) => c.priority === 0).length <= 1);
    assert.equal(new Set(chosen.map((c) => c.group)).size, chosen.length);
  }
  budget.clear();
  const idle = candidates.filter((c) => !c.priority);
  assert.equal(budget.choose(idle, 0).length, 1);
  assert.equal(budget.choose(idle, 3600).length, 0);
  assert.equal(budget.choose(idle, 14000).length, 0);
  assert.equal(budget.choose(idle, 15000).length, 1);
  // A service need interrupts the same character's casual-chatter cooldown.
  const urgent = budget.choose([{ ...idle[0], priority: 5 }], 15100);
  assert.equal(urgent[0]?.priority, 5);
  assert.equal(budget.choose([idle[0]], 15200).length, 0); // resolved need does not become nonstop chatter
});

test("dialogue decks vary all categories, hold an event stable, and exhaust before repeating", () => {
  const book = new DialogueBook();
  for (const key of Object.keys(dialogueLines) as (keyof typeof dialogueLines)[]) {
    const lines = dialogueLines[key];
    const chosen = lines.map((_, i) => {
      const value = book.pick(key, "server-1", String(i));
      assert.equal(book.pick(key, "server-1", String(i)), value);
      return value;
    });
    assert.equal(new Set(chosen).size, lines.length, key);
    assert.equal(book.pick(key, "server-1", String(lines.length)), chosen[0]);
  }
  const replay = new DialogueBook();
  book.clear();
  assert.equal(book.pick("greet", "server-2", "1"), replay.pick("greet", "server-2", "1"));
  assert.notEqual(book.pick("phone", "guest-1", "1"), book.pick("phone", "guest-2", "1"));
  assert.match(book.pick("orderReply", "guest-3", "1", { dish: "mushroom risotto" }), /mushroom risotto/);
  assert.ok(Object.values(dialogueLines).flat().length >= 300);
});

test("bubble motion grows and retracts continuously, including an interrupted entrance", () => {
  const motion = new BubbleMotion();
  motion.setVisible(true, 0);
  assert.equal(motion.sample(0), 0);
  assert.ok(motion.sample(80) > 0 && motion.value < 1);
  assert.equal(motion.sample(260), 1);
  motion.setVisible(false, 300);
  assert.equal(motion.sample(300), 1);
  assert.ok(motion.sample(390) > 0 && motion.value < 1);
  assert.equal(motion.sample(480), 0);
  motion.setVisible(true, 500);
  const midway = motion.sample(550);
  motion.setVisible(false, 550);
  assert.equal(motion.value, midway);
  assert.equal(motion.sample(730), 0);
});
