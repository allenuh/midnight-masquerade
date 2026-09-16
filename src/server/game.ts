import { randomInt } from 'node:crypto';
import { flashlightRange } from '../shared/flashlight.js';
import { GAMEPLAY } from '../shared/gameplay-config.js';
import { segmentBlocked } from '../shared/raycast.js';
import { constrainToWalls, distance3D, sphereInCone, spheresTouchDuringStep } from './spatial.js';
import type {
  CreatureSnapshot, HunterId, HunterSnapshot, HunterView, InputState, Position, ProximityState, RoundResult, RoundState,
} from '../shared/protocol.js';

// Server-side connection identity. Never sent to clients; roles are looked up from it.
export type PlayerId = string;

// Distinct Creature conditions, each its own countdown:
//   revealed  (revealTicks > 0)          every Hunter receives the Creature position
//   staggered (staggerTicks > 0)         the Creature cannot move or tag
//   cooldown  (staggerCooldownTicks > 0) a flashlight hit damages and reveals but cannot stagger
//   sprint cooldown (sprintCooldownTicks > 0) the held sprint button does nothing
//   attack cooldown (attackCooldownTicks > 0) contact cannot incapacitate another Hunter
export type CreatureState = {
  hp: number;
  lit: boolean; // at least one flashlight reached the Creature during the last step
  sprinting: boolean; // the last step moved the Creature at sprint speed
  revealTicks: number;
  staggerTicks: number;
  staggerCooldownTicks: number;
  sprintCooldownTicks: number;
  attackCooldownTicks: number;
};

// Team state is two flags per Hunter: `down` (incapacitated: no movement, turning, light,
// reviving, or being tagged again) and the revival work accumulated while down. `battery`
// is the authoritative flashlight energy: the client never reports or claims it.
export type Hunter = {
  id: HunterId;
  player: PlayerId;
  position: Position;
  facing: number;
  input: InputState;
  battery: number;
  down: boolean;
  reviveTicks: number;
};

export type Creature = { player: PlayerId; position: Position; input: InputState };

// The single battery on the map: `at` is the spawn point holding it, or null while none
// is out, in which case `spawnTicks` counts down to the next one.
export type PickupState = { at: number | null; spawnTicks: number };

// Round-end playtest data. Counters only: no storage, no identifiers, no analytics.
export type RoundStats = {
  incapacitations: number;
  revives: number;
  pickupsCollected: number;
  lightTicks: Record<HunterId, number>;
};

export type Game = {
  hunters: Hunter[]; // empty in the lobby; H1..H4 in join order during a round
  creature: Creature | null;
  creatureState: CreatureState;
  pickup: PickupState;
  roundId: number;
  roundState: RoundState;
  revealTicks: number; // role-reveal countdown while roundState is 'reveal'
  timeTicks: number; // match clock; counts down only while roundState is 'running'
  result: RoundResult | null;
  stats: RoundStats;
};

export const PLAYER_COUNT = GAMEPLAY.players.hunters + 1;
export const HUNTER_IDS: readonly HunterId[] = ['H1', 'H2', 'H3', 'H4'];
if (HUNTER_IDS.length !== GAMEPLAY.players.hunters) throw new Error('HunterId labels must match players.hunters');

// One fixed simulation step. Movement, damage, and countdowns all use it, so
// gameplay is measured in simulation seconds rather than frames or client clocks.
export const STEP_SECONDS = 1 / GAMEPLAY.tickRate;
export const secondsToTicks = (seconds: number): number => Math.round(seconds * GAMEPLAY.tickRate);
// Beam-ticks of exposure that complete a revival; each valid beam adds one per step.
export const REVIVE_TICKS = secondsToTicks(GAMEPLAY.revive.seconds);
// Radians on the ground plane: direction = (cos, 0, sin). -PI/2 is -Z, "up" on screen.
export const SPAWN_FACING = -Math.PI / 2;

// Match length in seconds. MATCH_SECONDS shortens or lengthens a playtest match without
// editing the tunables; it is a server-side knob only and never reaches a client.
export const MATCH_SECONDS = ((): number => {
  const override = Number(process.env.MATCH_SECONDS);
  return Number.isFinite(override) && override > 0 ? override : GAMEPLAY.round.matchSeconds;
})();
export const MATCH_TICKS = secondsToTicks(MATCH_SECONDS);
// The wait before a round's first battery, and the wait after each one is collected.
export const PICKUP_FIRST_SPAWN_TICKS = secondsToTicks(GAMEPLAY.batteryPickup.firstSpawnSeconds);
export const PICKUP_RESPAWN_TICKS = secondsToTicks(GAMEPLAY.batteryPickup.respawnSeconds);
// Center-to-center distance at which an active Hunter picks a battery up.
export const PICKUP_REACH = GAMEPLAY.playerRadius + GAMEPLAY.batteryPickup.radius;
// World positions of the public pickup points, grounded like every other sphere.
export const PICKUP_POSITIONS: readonly Position[] = GAMEPLAY.batteryPickup.spawns.map(({ x, z }) => ({
  x, y: GAMEPLAY.arena.floorY + GAMEPLAY.playerRadius, z,
}));

export const emptyInput = (): InputState => ({ up: false, down: false, left: false, right: false, light: false });
// A Hunter's beam exists only while it is active, holding the button, and has battery left.
export const hasBeam = (hunter: Hunter): boolean => !hunter.down && hunter.input.light && hunter.battery > 0;
// The public pickup list: the one point holding a battery, or nothing at all.
export const activePickups = (game: Game): number[] => (game.pickup.at === null ? [] : [game.pickup.at]);
export const isRevealed = (state: CreatureState): boolean => state.revealTicks > 0;
export const isStaggered = (state: CreatureState): boolean => state.staggerTicks > 0;
export const isOnStaggerCooldown = (state: CreatureState): boolean => state.staggerCooldownTicks > 0;
export const activeHunters = (game: Game): Hunter[] => game.hunters.filter((hunter) => !hunter.down);
export const downedHunters = (game: Game): Hunter[] => game.hunters.filter((hunter) => hunter.down);
export const allHuntersDown = (game: Game): boolean => game.hunters.length > 0 && game.hunters.every((hunter) => hunter.down);

const freshCreatureState = (): CreatureState => ({
  hp: GAMEPLAY.creature.maxHp, lit: false, sprinting: false,
  revealTicks: 0, staggerTicks: 0, staggerCooldownTicks: 0, sprintCooldownTicks: 0, attackCooldownTicks: 0,
});

// A round starts with an empty map: Hunters are on a full charge, so the first battery
// waits out the long delay before it appears.
const freshPickup = (): PickupState => ({ at: null, spawnTicks: PICKUP_FIRST_SPAWN_TICKS });

const freshStats = (): RoundStats => ({
  incapacitations: 0,
  revives: 0,
  pickupsCollected: 0,
  lightTicks: { H1: 0, H2: 0, H3: 0, H4: 0 },
});

export function createGame(): Game {
  return {
    hunters: [],
    creature: null,
    creatureState: freshCreatureState(),
    pickup: freshPickup(),
    roundId: 0,
    roundState: 'lobby',
    revealTicks: 0,
    timeTicks: MATCH_TICKS,
    result: null,
    stats: freshStats(),
  };
}

function randomPosition(): Position {
  const { arena, playerRadius } = GAMEPLAY;
  let candidate: Position;
  let attempts = 0;
  do {
    candidate = {
      x: randomInt(playerRadius, arena.width - playerRadius + 1),
      y: arena.floorY + playerRadius,
      z: randomInt(playerRadius, arena.depth - playerRadius + 1),
    };
    attempts += 1;
    // Reject spawns overlapping an obstacle; constraining a clear spawn changes nothing.
  } while (distance3D(candidate, constrainToWalls(candidate)) > 0 && attempts < 100);
  return constrainToWalls(candidate);
}

// Private independent randomness: Hunter coordinates / public round IDs do not determine
// the Creature's spawn. The Creature is placed first so every Hunter can be kept outside
// its UNEASY radius; Hunters are also kept from overlapping each other. No battery is on
// the map at round start, so there is nothing to keep a spawn clear of.
function spawnPositions(): { creature: Position; hunters: Position[] } {
  const creature = randomPosition();
  const hunters: Position[] = [];
  for (let slot = 0; slot < GAMEPLAY.players.hunters; slot++) {
    let candidate: Position;
    let attempts = 0;
    do {
      candidate = randomPosition();
      attempts += 1;
    } while (attempts < 100 && (
      distance3D(candidate, creature) <= GAMEPLAY.proximity.uneasy ||
      hunters.some((other) => distance3D(candidate, other) < 4 * GAMEPLAY.playerRadius)
    ));
    hunters.push(candidate);
  }
  return { creature, hunters };
}

export function roleOf(game: Game, player: PlayerId): 'creature' | HunterId | null {
  if (game.creature?.player === player) return 'creature';
  return game.hunters.find((hunter) => hunter.player === player)?.id ?? null;
}

// Starts a round for exactly PLAYER_COUNT distinct players: one becomes the Creature by
// private server randomness, the rest become H1..H4 in the given order. Every start,
// including a restart of a running round, rolls the Creature again.
export function startRound(game: Game, players: readonly PlayerId[]): void {
  if (players.length !== PLAYER_COUNT || new Set(players).size !== PLAYER_COUNT) {
    throw new Error(`A round needs exactly ${PLAYER_COUNT} distinct players`);
  }
  const creatureIndex = randomInt(PLAYER_COUNT);
  const spawns = spawnPositions();
  game.creature = { player: players[creatureIndex], position: spawns.creature, input: emptyInput() };
  game.hunters = players
    .filter((_, index) => index !== creatureIndex)
    .map((player, slot) => ({
      id: HUNTER_IDS[slot], player, position: spawns.hunters[slot], facing: SPAWN_FACING,
      input: emptyInput(), battery: GAMEPLAY.battery.max, down: false, reviveTicks: 0,
    }));
  // Every resource is rebuilt here, so nothing leaks from the previous round: HP and the
  // Creature countdowns, full batteries, an empty map with the first-battery delay reset,
  // a full match clock, and empty statistics.
  game.creatureState = freshCreatureState();
  game.pickup = freshPickup();
  game.roundId += 1;
  game.roundState = 'reveal';
  game.revealTicks = secondsToTicks(GAMEPLAY.roleRevealSeconds);
  game.timeTicks = MATCH_TICKS;
  game.result = null;
  game.stats = freshStats();
}

// Disconnect policy: a round cannot continue without all five players, so it is
// dropped entirely and the room returns to the lobby. Roles are forgotten.
export function abandonRound(game: Game): void {
  game.hunters = [];
  game.creature = null;
  game.creatureState = freshCreatureState();
  game.pickup = freshPickup();
  game.roundState = 'lobby';
  game.revealTicks = 0;
  game.timeTicks = MATCH_TICKS;
  game.result = null;
  game.stats = freshStats();
}

function clearInputs(game: Game): void {
  for (const hunter of game.hunters) hunter.input = emptyInput();
  if (game.creature) game.creature.input = emptyInput();
}

export function expireInput(game: Game, player: PlayerId): void {
  if (game.creature?.player === player) game.creature.input = emptyInput();
  const hunter = game.hunters.find((candidate) => candidate.player === player);
  if (hunter) hunter.input = emptyInput();
}

export function setInput(game: Game, player: PlayerId, raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const message = raw as Record<string, unknown>;
  const allowedKeys = ['type', 'roundId', 'up', 'down', 'left', 'right', 'light'];
  if (
    Object.keys(message).length !== allowedKeys.length ||
    Object.keys(message).some((key) => !allowedKeys.includes(key)) ||
    message.type !== 'input' || message.roundId !== game.roundId ||
    game.roundState !== 'running' ||
    typeof message.up !== 'boolean' || typeof message.down !== 'boolean' ||
    typeof message.left !== 'boolean' || typeof message.right !== 'boolean' ||
    typeof message.light !== 'boolean'
  ) return false;

  // A message only replaces held keys. It never advances time or trusts a position.
  // The same `light` flag is the Hunter's flashlight and the Creature's sprint button.
  // An incapacitated Hunter has no input at all until it is revived.
  const input: InputState = {
    up: message.up, down: message.down, left: message.left, right: message.right, light: message.light,
  };
  if (game.creature?.player === player) {
    game.creature.input = input;
    return true;
  }
  const hunter = game.hunters.find((candidate) => candidate.player === player);
  if (!hunter || hunter.down) return false;
  hunter.input = input;
  return true;
}

function move(position: Position, input: InputState, speed: number): Position {
  const dx = Number(input.right) - Number(input.left);
  const dz = Number(input.down) - Number(input.up);
  const length = Math.hypot(dx, dz);
  if (length === 0) return constrainToWalls(position);
  const step = speed * STEP_SECONDS;
  return constrainToWalls({ x: position.x + dx / length * step, y: position.y, z: position.z + dz / length * step });
}

// Wrap to [-PI, PI).
function wrapAngle(angle: number): number {
  return angle - 2 * Math.PI * Math.floor((angle + Math.PI) / (2 * Math.PI));
}

// The facing chases the held movement direction at a fixed angular speed. It
// turns even when a wall stops the body, and keeps its value with no input.
export function turnToward(facing: number, input: InputState): number {
  const dx = Number(input.right) - Number(input.left);
  const dz = Number(input.down) - Number(input.up);
  if (dx === 0 && dz === 0) return facing;
  const desired = Math.atan2(dz, dx);
  const maxStep = GAMEPLAY.hunterTurnSpeed * (Math.PI / 180) * STEP_SECONDS;
  let difference = wrapAngle(desired - facing);
  // An exact reversal has no shorter side; always turn in the positive direction.
  if (difference < -Math.PI + 1e-9) difference = Math.PI;
  if (Math.abs(difference) <= maxStep) return desired;
  return wrapAngle(facing + Math.sign(difference) * maxStep);
}

export function proximityForDistance(value: number): ProximityState {
  if (value <= GAMEPLAY.proximity.immediate) return 'IMMEDIATE';
  if (value <= GAMEPLAY.proximity.danger) return 'DANGER';
  if (value <= GAMEPLAY.proximity.uneasy) return 'UNEASY';
  return 'SAFE';
}

// One Hunter's own band. Keeping the distance behind this function means nothing outside
// this module has to touch the Creature's position to ask how close a Hunter is.
export function hunterProximity(game: Game, hunter: Hunter): ProximityState {
  if (!game.creature) return 'SAFE';
  return proximityForDistance(distance3D(hunter.position, game.creature.position));
}

// The flashlight originates at the Hunter's center, which collision keeps out of
// every wall. A target sphere (the Creature, or a downed teammate) is lit when it
// overlaps the cone and the straight line from the origin to its center crosses no
// wall box. The same test decides Creature hits and revival exposure. `range` is the
// battery stage's reach; it defaults to the full-battery range.
export function flashlightReaches(
  hunter: Position, facing: number, target: Position, range: number = GAMEPLAY.flashlight.range,
): boolean {
  return sphereInCone(hunter, facing, target, GAMEPLAY.playerRadius, range) && !segmentBlocked(hunter, target);
}

function endRound(game: Game, result: RoundResult): void {
  game.roundState = 'ended';
  game.result = result;
  clearInputs(game);
}

// Step order: the role reveal counts down; the match clock and every countdown expire;
// the battery spawn countdown runs; active Hunters turn and move; the Creature moves (at sprint speed while
// sprinting); one tag is resolved; batteries are collected; the flashlights and the sprint
// reveal are applied; revival exposure accumulates; batteries drain; the round result is
// evaluated. A tag that occurs this step therefore still downs the Hunter even when the
// same step would have revealed the Creature, and that Hunter's beam is void from this step on.
export function stepGame(game: Game): void {
  if (game.roundState === 'reveal') {
    game.revealTicks = Math.max(0, game.revealTicks - 1);
    if (game.revealTicks === 0) game.roundState = 'running';
    return;
  }
  const creature = game.creature;
  if (game.roundState !== 'running' || !creature) return;
  const state = game.creatureState;

  // The match clock only runs here, so it starts when gameplay starts and stops the
  // moment a round ends: an ended round never reaches this line again.
  game.timeTicks = Math.max(0, game.timeTicks - 1);

  // The map holds at most one battery. While none is out a countdown runs — the long
  // first-spawn delay at the start of a round, the shorter respawn after each collection —
  // and reaching zero puts one at a point chosen by private server randomness. Repeats are
  // allowed: the same point can come up twice in a row.
  if (game.pickup.at === null) {
    game.pickup.spawnTicks = Math.max(0, game.pickup.spawnTicks - 1);
    if (game.pickup.spawnTicks === 0) game.pickup.at = randomInt(PICKUP_POSITIONS.length);
  }

  state.revealTicks = Math.max(0, state.revealTicks - 1);
  state.staggerTicks = Math.max(0, state.staggerTicks - 1);
  state.staggerCooldownTicks = Math.max(0, state.staggerCooldownTicks - 1);
  state.sprintCooldownTicks = Math.max(0, state.sprintCooldownTicks - 1);
  state.attackCooldownTicks = Math.max(0, state.attackCooldownTicks - 1);

  // Incapacitated Hunters neither turn nor move; their input is empty and rejected.
  const huntersBefore = game.hunters.map((hunter) => hunter.position);
  for (const hunter of game.hunters) {
    if (hunter.down) continue;
    hunter.facing = turnToward(hunter.facing, hunter.input);
    hunter.position = move(hunter.position, hunter.input, GAMEPLAY.speed.hunter);
  }

  // The sprint is re-evaluated every step from the held button: it cannot run while
  // staggered or during the cooldown that follows every sprint, and a button held
  // through that cooldown resumes sprinting on the step the cooldown expires.
  const sprinting = creature.input.light && !isStaggered(state) && state.sprintCooldownTicks === 0;
  if (state.sprinting && !sprinting) state.sprintCooldownTicks = secondsToTicks(GAMEPLAY.sprint.cooldownSeconds);
  state.sprinting = sprinting;
  const creatureBefore = creature.position;
  creature.position = isStaggered(state)
    ? constrainToWalls(creature.position)
    : move(creature.position, creature.input, sprinting ? GAMEPLAY.sprint.speed : GAMEPLAY.speed.creature);

  // Tag: a staggered Creature cannot attack, and every tag starts the attack cooldown,
  // so at most one Hunter goes down per cooldown. With two active Hunters in contact in
  // the same step, the lower slot (H1 first) is the one downed. Contact with a Hunter
  // that is already down does nothing.
  if (!isStaggered(state) && state.attackCooldownTicks === 0) {
    const target = game.hunters.find((hunter, index) =>
      !hunter.down && spheresTouchDuringStep(huntersBefore[index], hunter.position, creatureBefore, creature.position));
    if (target) {
      target.down = true;
      target.reviveTicks = 0;
      target.input = emptyInput();
      state.attackCooldownTicks = secondsToTicks(GAMEPLAY.creature.attackCooldownSeconds);
      game.stats.incapacitations += 1;
      if (allHuntersDown(game)) {
        endRound(game, 'caught');
        return;
      }
    }
  }

  // Battery collection: server-authoritative in every respect. The client never claims a
  // collection, an amount, or a disappearance. An incapacitated Hunter collects nothing;
  // with two Hunters on the battery the lower slot (H1 first) takes it, and a Hunter
  // already at full battery still consumes it. Taking it clears the map and starts the
  // respawn countdown, so a battery spawning on the step a Hunter is already standing
  // there is simply collected that same step.
  if (game.pickup.at !== null) {
    const point = PICKUP_POSITIONS[game.pickup.at];
    const collector = game.hunters.find((hunter) =>
      !hunter.down && distance3D(hunter.position, point) <= PICKUP_REACH);
    if (collector) {
      collector.battery = Math.min(GAMEPLAY.battery.max, collector.battery + GAMEPLAY.batteryPickup.restores);
      game.pickup = { at: null, spawnTicks: PICKUP_RESPAWN_TICKS };
      game.stats.pickupsCollected += 1;
    }
  }

  // The beams for this step: an active Hunter holding the button with battery left, each
  // reaching as far as its own battery stage allows. Creature hits and revival exposure
  // share this list, so an empty flashlight does neither.
  const beams = game.hunters
    .filter(hasBeam)
    .map((hunter) => ({ hunter, range: flashlightRange(hunter.battery) }));

  // Flashlights: the Creature is lit when any active Hunter's beam reaches it. Damage,
  // the linger, and the stagger are evaluated once per step regardless of how many
  // beams overlap, so extra Hunters neither multiply damage nor bypass the cooldown.
  state.lit = beams.some(({ hunter, range }) =>
    flashlightReaches(hunter.position, hunter.facing, creature.position, range));
  if (state.lit) {
    state.hp = Math.max(0, state.hp - GAMEPLAY.flashlight.damagePerSecond * STEP_SECONDS);
    // Every lit step refreshes the linger. Only a hit outside the cooldown staggers,
    // and that hit also starts the cooldown, so continuous light never re-staggers
    // until the cooldown has fully expired.
    state.revealTicks = secondsToTicks(GAMEPLAY.creature.visibilityLingerSeconds);
    if (!isOnStaggerCooldown(state)) {
      state.staggerTicks = secondsToTicks(GAMEPLAY.creature.staggerSeconds);
      state.staggerCooldownTicks = secondsToTicks(GAMEPLAY.creature.staggerCooldownSeconds);
    }
  }
  // A sprinting Creature is revealed exactly like a lit one and shares its linger, so
  // tapping the button cannot flicker it in and out of the Hunters' view. Sprinting
  // itself never damages or staggers.
  if (state.sprinting) state.revealTicks = secondsToTicks(GAMEPLAY.creature.visibilityLingerSeconds);

  // Revival: every active teammate whose beam reaches a downed Hunter adds one tick of
  // work per step (beams stack). Progress is kept while no beam reaches the Hunter.
  for (const downed of game.hunters) {
    if (!downed.down) continue;
    const reaching = beams.filter(({ hunter, range }) =>
      flashlightReaches(hunter.position, hunter.facing, downed.position, range)).length;
    if (reaching === 0) continue;
    downed.reviveTicks += reaching;
    if (downed.reviveTicks >= REVIVE_TICKS) {
      downed.down = false;
      downed.reviveTicks = 0;
      game.stats.revives += 1;
    }
  }

  // Drain, in simulation time, after the effects: a Hunter gets the reveal, damage, or
  // revival work the battery it just spent paid for. Nothing recharges it.
  for (const { hunter } of beams) {
    hunter.battery = Math.max(0, hunter.battery - GAMEPLAY.battery.drainPerSecond * STEP_SECONDS);
    game.stats.lightTicks[hunter.id] += 1;
  }

  // Result priority: HP first, so a kill on the final tick is still a Hunter victory.
  // An expired clock is a Creature victory; `caught` already returned above.
  if (state.hp <= 0) endRound(game, 'defeated');
  else if (game.timeTicks === 0) endRound(game, 'expired');
}

const copyPosition = (position: Position): Position => ({ x: position.x, y: position.y, z: position.z });

export function snapshotFor(game: Game, player: PlayerId): HunterSnapshot | CreatureSnapshot {
  const role = roleOf(game, player);
  const roundState = game.roundState;
  if (!role || !game.creature || roundState === 'lobby') throw new Error('Cannot create a snapshot for a player without a role');
  const state = game.creatureState;
  // The team view is public to every player in the round: positions, facings, lights,
  // and down / revival state. It carries no proximity band and nothing about the Creature.
  const hunters: HunterView[] = game.hunters.map((hunter) => ({
    id: hunter.id,
    position: copyPosition(hunter.position),
    facing: hunter.facing,
    // An empty battery reads as no light at all: the beam does nothing and is not drawn.
    light: hasBeam(hunter),
    battery: hunter.battery,
    down: hunter.down,
    revive: hunter.down ? hunter.reviveTicks / REVIVE_TICKS : 0,
  }));
  const round = {
    type: 'snapshot' as const,
    roundId: game.roundId,
    roundState,
    result: game.result,
    hunters,
    // Both roles share the clock and the public pickup state; neither carries a position.
    // The clock is rounded to hundredths: it is a countdown to display, and the raw
    // tick quotient would put a long float on the wire thirty times a second.
    timeRemaining: Math.round(game.timeTicks * STEP_SECONDS * 100) / 100,
    pickups: activePickups(game),
  };

  // SECURITY: construct an allowlist for each role. Never serialize game.creature,
  // spread private simulation state, or reveal the Creature after a catch.
  if (role !== 'creature') {
    const self = game.hunters.find((hunter) => hunter.id === role)!;
    const snapshot: HunterSnapshot = {
      ...round,
      role: 'hunter',
      self: role,
      // This Hunter's own distance only; each Hunter is told a different band.
      proximity: hunterProximity(game, self),
      creatureHp: state.hp,
    };
    // The Creature position exists in this payload only while revealed. Once the
    // linger expires the key is gone, not merely flagged invisible.
    if (isRevealed(state)) {
      snapshot.creature = {
        position: copyPosition(game.creature.position), staggered: isStaggered(state), sprinting: state.sprinting,
      };
    }
    return snapshot;
  }
  return {
    ...round,
    role: 'creature',
    creature: copyPosition(game.creature.position),
    hp: state.hp,
    lit: state.lit,
    revealed: isRevealed(state),
    staggered: isStaggered(state),
    staggerCooldown: state.staggerCooldownTicks * STEP_SECONDS,
    sprinting: state.sprinting,
    sprintCooldown: state.sprintCooldownTicks * STEP_SECONDS,
    attackCooldown: state.attackCooldownTicks * STEP_SECONDS,
  };
}
