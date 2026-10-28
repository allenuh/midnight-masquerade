import assert from 'node:assert/strict';
import test from 'node:test';
import { FEAR_STAGES, createFear, fearInput, fearLevels, previewInput, type FearLevels } from '../src/client/fear.js';
import { GAMEPLAY } from '../src/shared/gameplay-config.js';
import { DEFAULT_TUNING } from '../src/shared/tuning.js';

const { uneasy, danger, immediate, dreadSteps } = GAMEPLAY.proximity;
const dreadAt = (distance: number) => Math.round((1 - distance / uneasy) * dreadSteps);

test('the band decides the fear stage and the dread places the Hunter inside it', () => {
  assert.deepEqual(fearInput('SAFE', 0, DEFAULT_TUNING), { stage: 0, t: 0 });
  // Halfway through each band, to within a dread step.
  for (const [band, stage, outer, inner] of [
    ['UNEASY', 1, uneasy, danger], ['DANGER', 2, danger, immediate], ['IMMEDIATE', 3, immediate, 0],
  ] as const) {
    const { stage: found, t } = fearInput(band, dreadAt((outer + inner) / 2), DEFAULT_TUNING);
    assert.equal(found, stage);
    assert.ok(Math.abs(t - 0.5) <= (uneasy / dreadSteps) / (outer - inner), `${band} t ${t}`);
  }
  // Touching is the innermost point; t is clamped where a step overshoots its band.
  assert.deepEqual(fearInput('IMMEDIATE', dreadSteps, DEFAULT_TUNING), { stage: 3, t: 1 });
  assert.equal(fearInput('UNEASY', 0, DEFAULT_TUNING).t, 0);
  assert.equal(fearInput('DANGER', 0, DEFAULT_TUNING).t, 0);
});

test('the preview runs from SAFE at 0 to the innermost IMMEDIATE at 3', () => {
  assert.deepEqual(previewInput(0), { stage: 0, t: 0 });
  assert.deepEqual(previewInput(0.5), { stage: 1, t: 0.5 });
  assert.deepEqual(previewInput(1.5), { stage: 2, t: 0.5 });
  assert.deepEqual(previewInput(2), { stage: 2, t: 1 });
  assert.deepEqual(previewInput(9), { stage: 3, t: 1 });
});

test('every band adds layers, and each threshold jumps further than a band changes inside', () => {
  const at = (stage: number, t: number) => fearLevels({ stage, t });
  assert.equal(at(0, 0).darkness, 0);
  for (let stage = 1; stage <= 3; stage++) {
    const within = at(stage, 1).darkness - at(stage, 0).darkness;
    const jump = at(stage, 0).darkness - (stage === 1 ? 0 : at(stage - 1, 1).darkness);
    assert.ok(jump > within, `stage ${stage}: jump ${jump} vs ${within}`);
    assert.ok(at(stage, 0).radius < (stage === 1 ? Infinity : at(stage - 1, 1).radius), 'the darkness closes in');
  }
  // Layers: the heartbeat and TV static from UNEASY, the tendrils and colour split from DANGER, each
  // stronger in every band after the one it starts in.
  const layers: (keyof FearLevels)[] = ['heartRate', 'tvStatic', 'tendrils', 'aberration'];
  const firstStage = (key: keyof FearLevels) => FEAR_STAGES.findIndex((table) => table[key][0] > 0) + 1;
  assert.deepEqual(layers.map(firstStage), [1, 1, 2, 2]);
  assert.ok(at(2, 0).tvStatic > at(1, 1).tvStatic && at(3, 0).tvStatic > at(2, 1).tvStatic, 'the static steps up');
  assert.ok(at(3, 0).aberration > at(2, 1).aberration, 'the colour split steps up');
  assert.ok(at(2, 0).heartRate > at(1, 1).heartRate && at(3, 0).heartRate > at(2, 1).heartRate, 'the heart steps up');
  // The clear radius never shrinks below twice the tag reach, so a Creature about to grab the
  // Hunter is in view.
  assert.ok(at(3, 1).radius > 2 * (GAMEPLAY.playerRadius + GAMEPLAY.creatureHitRadius));
});

test('the panic lines show in every band, the same throughout it, and step up at each threshold', () => {
  const at = (stage: number, t: number) => fearLevels({ stage, t });
  assert.equal(at(0, 0).lines, 0);
  const growing: (keyof FearLevels)[] = ['lines', 'lineLength', 'lineWidth', 'lineWave', 'lineWaves', 'lineSpeed'];
  for (let stage = 1; stage <= 3; stage++) {
    assert.ok(at(stage, 0).lines >= 1, `stage ${stage} has lines`);
    for (const key of growing) {
      assert.equal(at(stage, 1)[key], at(stage, 0)[key], `${key} does not change inside stage ${stage}`);
      if (stage > 1) assert.ok(at(stage, 0)[key] > at(stage - 1, 1)[key], `${key} jumps into stage ${stage}`);
    }
  }
});

test('when a band adds or removes panic lines, they all grow out or shrink back together', () => {
  const fear = createFear();
  const settle = (stage: number) => { for (let i = 0; i < 60; i++) fear.update({ stage, t: 0.5 }, 1 / 30); };
  settle(1);
  let frame = fear.update({ stage: 1, t: 0.5 }, 1 / 30);
  assert.deepEqual([frame.lines, frame.linesSettled, frame.lineEmerge], [8, 8, 1]);
  // Into DANGER: the 8 stay, the 4 new ones share one growth value.
  frame = fear.update({ stage: 2, t: 0.5 }, 1 / 30);
  assert.deepEqual([frame.lines, frame.linesSettled], [12, 8]);
  assert.ok(frame.lineEmerge > 0 && frame.lineEmerge < 1, `growing: ${frame.lineEmerge}`);
  settle(2);
  frame = fear.update({ stage: 2, t: 0.5 }, 1 / 30);
  assert.deepEqual([frame.lines, frame.linesSettled, frame.lineEmerge], [12, 12, 1]);
  // Back out to SAFE: all 12 shrink back together.
  frame = fear.update({ stage: 0, t: 0 }, 1 / 30);
  assert.deepEqual([frame.lines, frame.linesSettled], [12, 0]);
  assert.ok(frame.lineEmerge > 0 && frame.lineEmerge < 1);
  settle(0);
  assert.equal(fear.update({ stage: 0, t: 0 }, 1 / 30).lines, 0);
});
