import assert from 'node:assert/strict';
import test from 'node:test';
import { Quaternion, Vector3 } from 'three';
import { FIRE, SPARKLE, createFire, createSparkles, pickupChanges } from '../src/client/particles.js';
import { BATTERY_SPAWN, batterySpawnPose } from '../src/client/vfx.js';

const at = new Vector3(10, 20, 30);
const floor = { x: 10, y: 0, z: 30 };
// How many particles are alive at `seconds`, from what was written to the mesh.
function alive(geometry: { getAttribute(name: string): { array: ArrayLike<number>; count: number } }, seconds: number): number {
  const start = geometry.getAttribute('aStart');
  const motion = geometry.getAttribute('aMotion');
  let count = 0;
  for (let index = 0; index < start.count; index++) {
    const age = seconds - start.array[index * 4 + 3];
    if (age >= 0 && age < motion.array[index * 4 + 3]) count += 1;
  }
  return count;
}
const sparkleParts = (kind: 'spawn' | 'pickup') => (kind === 'spawn'
  ? 2 + SPARKLE.SPAWN_GLINTS // flash, ring, glints
  : 3 + SPARKLE.PICKUP_GLINTS + SPARKLE.PICKUP_FLAKES); // flash, two rings, glints, flakes

test('a battery appearing or disappearing in play is told apart from a new round clearing the map', () => {
  assert.deepEqual(pickupChanges([], [2], 'running'), { spawned: [2], taken: [] });
  assert.deepEqual(pickupChanges([2], [], 'running'), { spawned: [], taken: [2] });
  assert.deepEqual(pickupChanges([2], [4], 'running'), { spawned: [4], taken: [2] }, 'collected and respawned in one step');
  assert.deepEqual(pickupChanges([2], [2], 'running'), { spawned: [], taken: [] });
  assert.deepEqual(pickupChanges([2], [], 'ended'), { spawned: [], taken: [2] }, 'collected on the step the round ended');
  assert.deepEqual(pickupChanges([2], [], 'reveal'), { spawned: [], taken: [] }, 'a new round empties the map');
  assert.deepEqual(pickupChanges(null, [2], 'running'), { spawned: [], taken: [] }, 'joining with a battery already out');
});

test('a sparkle is a fixed set of particles that lives and then stops being drawn', () => {
  for (const kind of ['spawn', 'pickup'] as const) {
    const sparkles = createSparkles(new Quaternion());
    sparkles.update(0);
    assert.equal(sparkles.mesh.visible, true, 'drawn once with nothing alive, to compile its shader');
    sparkles.update(0.1);
    assert.equal(sparkles.mesh.visible, false, 'then not drawn while nothing is alive');
    sparkles.burst(kind, at, 1);
    sparkles.update(1);
    assert.equal(sparkles.mesh.visible, true);
    // The second ring of a pickup starts a moment late.
    assert.equal(alive(sparkles.geometry, 1) + (kind === 'pickup' ? 1 : 0), sparkleParts(kind));
    const longest = Math.max(SPARKLE.FLASH_LIFE, SPARKLE.RING_LIFE + SPARKLE.RING_DELAY, SPARKLE.GLINT_LIFE, SPARKLE.FLAKE_LIFE);
    sparkles.update(1 + longest + 0.01);
    assert.equal(alive(sparkles.geometry, 1 + longest + 0.01), 0);
    assert.equal(sparkles.mesh.visible, false);
  }
});

test('sparkles fit the ring: a pickup never overwrites itself', () => {
  const sparkles = createSparkles(new Quaternion());
  assert.ok(sparkleParts('pickup') <= sparkles.geometry.instanceCount);
});

test('a burst is thrown across the camera\'s plane, whatever way the camera looks', () => {
  const steep = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -1.25);
  const sparkles = createSparkles(steep);
  sparkles.burst('pickup', at, 0);
  const forward = new Vector3(0, 0, -1).applyQuaternion(steep);
  const motion = sparkles.geometry.getAttribute('aMotion');
  for (let index = 0; index < sparkleParts('pickup'); index++) {
    const velocity = new Vector3().fromArray(motion.array, index * 4);
    assert.ok(Math.abs(velocity.dot(forward)) < 1e-3, `particle ${index}`);
  }
});

test('fire burns at its rate only while burning, and what it made burns out by itself', () => {
  const fire = createFire();
  fire.update(0, 0, false, null, 67);
  assert.equal(fire.mesh.visible, true, 'drawn once with nothing alive, to compile its shader');
  fire.update(0.1, 0.1, false, null, 67);
  assert.equal(fire.mesh.visible, false);

  // Ten frames a second of a second burning: the ignition plus a second's worth of flames and embers.
  let seconds = 1;
  const written = () => {
    const start = fire.geometry.getAttribute('aStart');
    let count = 0;
    for (let index = 0; index < start.count; index++) if (start.array[index * 4 + 3] >= 1) count += 1;
    return count;
  };
  for (let frame = 0; frame < 10; frame++) {
    fire.update(seconds, 0.1, true, floor, 67);
    seconds += 0.1;
  }
  const expected = FIRE.IGNITE_FLAMES + FIRE.FLAMES_PER_SECOND + FIRE.EMBERS_PER_SECOND;
  assert.ok(Math.abs(written() - expected) <= 2, `${written()} written, ${expected} expected`);
  assert.equal(fire.mesh.visible, true);

  // The burn ends: embers thrown off once, no more flames, and it stops being drawn.
  const before = written();
  fire.update(seconds, 0.1, false, floor, 67);
  assert.equal(written(), before + FIRE.SNUFF_EMBERS);
  fire.update(seconds + 0.1, 0.1, false, floor, 67);
  assert.equal(written(), before + FIRE.SNUFF_EMBERS, 'thrown off once');
  fire.update(seconds + FIRE.EMBER_LIFE + 0.01, 0.1, false, null, 67);
  assert.equal(alive(fire.geometry, seconds + FIRE.EMBER_LIFE + 0.01), 0);
  assert.equal(fire.mesh.visible, false);
});

test('flames are born on the Creature and stay where they were born', () => {
  const fire = createFire();
  fire.update(0, 0, true, floor, 67);
  const start = fire.geometry.getAttribute('aStart');
  for (let index = 0; index < FIRE.IGNITE_FLAMES; index++) {
    const { [index * 4]: x, [index * 4 + 1]: y, [index * 4 + 2]: z } = start.array;
    assert.ok(Math.hypot(x - floor.x, z - floor.z) <= FIRE.BODY_RADIUS, `flame ${index} across`);
    assert.ok(y >= floor.y && y <= floor.y + 67, `flame ${index} up`);
  }
  // Moving on writes new flames at the new place and leaves these where they are.
  const first = Array.from(start.array.slice(0, 3));
  fire.update(0.1, 0.1, true, { x: 500, y: 0, z: 500 }, 67);
  assert.deepEqual(Array.from(start.array.slice(0, 3)), first);
});

test('the fire keeps within its ring at full burn, so a flame is never cut short', () => {
  const fire = createFire();
  const peak = FIRE.FLAMES_PER_SECOND * FIRE.FLAME_LIFE + FIRE.EMBERS_PER_SECOND * FIRE.EMBER_LIFE + FIRE.IGNITE_FLAMES + FIRE.SNUFF_EMBERS;
  assert.ok(peak <= fire.geometry.instanceCount, `${peak} alive at most`);
});

test('the sparkle is never as orange as the fire: red never leads green by what the tests call burning', () => {
  // tests/browser.spec.ts counts red > green + 25 and green > blue + 10 as the burning Creature.
  for (const color of [SPARKLE.COLOR_LEMON, SPARKLE.COLOR_WHITE, SPARKLE.COLOR_POWDER]) {
    const value = parseInt(color.slice(1), 16);
    const [red, green] = [value >> 16, (value >> 8) & 255];
    assert.ok(red <= green + 25, color);
  }
});

test('a battery grows out from small, overshoots, and ends exactly in its standing pose after one full turn', () => {
  const { SECONDS, FROM, TURNS } = BATTERY_SPAWN;
  const start = batterySpawnPose(0);
  assert.ok(Math.abs(start.scale - FROM) < 1e-9, 'starts really small');
  assert.ok(Math.abs(start.turn + 2 * Math.PI * TURNS) < 1e-9, 'a whole turn to go');
  assert.equal(start.done, false);
  const steps = Array.from({ length: 200 }, (_, step) => batterySpawnPose((step / 200) * SECONDS));
  assert.ok(steps.every(({ scale }) => scale > 0), 'never turned inside out');
  assert.ok(Math.max(...steps.map(({ scale }) => scale)) > 1.02, 'goes a little past full size');
  assert.ok(Math.max(...steps.map(({ scale }) => scale)) < 1.2, 'but only a little');
  for (let step = 1; step < steps.length; step++) assert.ok(steps[step].turn >= steps[step - 1].turn, 'turns one way, slowing to a stop');
  assert.deepEqual(batterySpawnPose(SECONDS), { scale: 1, turn: 0, done: true });
  assert.deepEqual(batterySpawnPose(Infinity), { scale: 1, turn: 0, done: true }, 'no entrance playing');
  const last = batterySpawnPose(SECONDS - 1e-6);
  assert.ok(Math.abs(last.scale - 1) < 1e-3 && Math.abs(last.turn) < 1e-3, 'no jump as it ends');
});
