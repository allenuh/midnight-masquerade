// Post-processing over the finished picture: a soft bloom on the brightest things (the lens
// glow, the burning Creature, the core of a flashlight's pool) and a quiet night grade with a
// vignette, both switched live by VFX.bloom and VFX.grade (vfx.ts); and a Hunter's fear effects
// (fear.ts), which are the proximity warning and so are never switched off.
import {
  type Camera, Color, HalfFloatType, type Scene, Vector2, type WebGLRenderer, WebGLRenderTarget,
} from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { FearFrame } from './fear.js';
import { VFX } from './vfx.js';

// Bloom: only light brighter than BLOOM_THRESHOLD (linear luminance) blooms, by BLOOM_STRENGTH,
// spread by BLOOM_RADIUS (0..1).
const BLOOM_STRENGTH = 0.35;
const BLOOM_RADIUS = 0.5;
const BLOOM_THRESHOLD = 0.85;
// Grade, in linear light. The vignette darkens from VIGNETTE_START to VIGNETTE_END (distance
// from the centre, 1 at the middle of each edge) by up to VIGNETTE_STRENGTH. Shadows lose
// SHADOW_DESATURATION of their colour, the way colour fades in the dark, and lit colours gain
// HIGHLIGHT_SATURATION. GRADE_CONTRAST bends brightness around GRADE_PIVOT.
// Every step scales the three channels together or moves them toward or away from their own
// grey, so an exactly grey pixel stays grey: the browser tests find the Creature by its neutral
// charcoal. The cool shadows and warm light come from the lights themselves (scene.ts).
const VIGNETTE_START = 0.55;
const VIGNETTE_END = 1.45;
const VIGNETTE_STRENGTH = 0.55;
const SHADOW_DESATURATION = 0.3;
const HIGHLIGHT_SATURATION = 0.15;
const GRADE_CONTRAST = 1.08;
const GRADE_PIVOT = 0.18;

const GRADE_SHADER = {
  uniforms: { tDiffuse: { value: null } },
  vertexShader: /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`,
  fragmentShader: /* glsl */ `
uniform sampler2D tDiffuse;
varying vec2 vUv;
void main() {
  vec4 texel = texture2D(tDiffuse, vUv);
  vec3 color = max(texel.rgb, vec3(0.0));
  float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
  // Saturation: less in the dark, a little more where it is lit.
  float lit = smoothstep(0.02, 0.4, luma);
  float saturation = mix(1.0 - ${SHADOW_DESATURATION.toFixed(3)}, 1.0 + ${HIGHLIGHT_SATURATION.toFixed(3)}, lit);
  color = max(mix(vec3(luma), color, saturation), vec3(0.0));
  // Contrast on brightness only, as one factor on all three channels.
  float graded = ${GRADE_PIVOT.toFixed(3)} * pow(max(luma, 1e-5) / ${GRADE_PIVOT.toFixed(3)}, ${GRADE_CONTRAST.toFixed(3)});
  color *= graded / max(luma, 1e-5);
  // Vignette: an ellipse following the arena's shape.
  float edge = smoothstep(${VIGNETTE_START.toFixed(3)}, ${VIGNETTE_END.toFixed(3)}, length((vUv - 0.5) * 2.0));
  color *= 1.0 - ${VIGNETTE_STRENGTH.toFixed(3)} * edge;
  gl_FragColor = vec4(color, texel.a);
}`,
};

// The fear effects around the viewer's own Hunter (values from fear.ts). Distances are world
// units: `scale` converts them to screen heights, and `focus` is the Hunter on screen (UV). The
// darkness starts `radius` from the Hunter and reaches `darkness` `softness` further out, its edge
// broken by drifting ink (`tendrils`) and pulled in by the heartbeat (`pulse`). Colour drains,
// mostly far from the Hunter, and with `aberration` splits in a ring from about half the clear
// radius to ABERRATION_RING softness-widths beyond it: each tap is drained first and the split
// after, so its red and blue fringes keep their colour, and the fringes are saturated and shown
// through the darkness at the edge of the clear area, while the far map stays dark. `tvStatic`
// lays black-and-white TV static over the whole screen: snow, faint scanlines and a band of
// stronger snow rolling down it.
// Darkening, draining and the static treat the three channels alike, so a grey pixel stays grey
// (the browser tests find the Creature by its neutral charcoal); the split only colours edges,
// and inside a flat patch its fringe is zero. The snow is symmetric around zero and clamped at
// black, so on a dark area half its blocks stay black and it never forms a solid grey patch.
// How far the heartbeat pulls the darkness in, and darkens it, at a full thump; how wide the
// tendrils waver (a share of the softness, but never more than TENDRIL_MAX of the clear radius,
// so the middle of the clear area stays clear); the colour split's reach (screen share per unit
// of `aberration`), how much its fringes are saturated, and how much of the darkness they show
// through. The static: snow in STATIC_PIXEL-pixel blocks re-rolled STATIC_FPS times a second
// (so it flickers like a TV set rather than shimmering every frame), at STATIC_AMOUNT of the
// screen's brightness range (added in perceptual, roughly gamma-encoded, light: in linear light
// even faint snow on black reads as bright grey); every third row darkened by STATIC_SCANLINES; and a band
// STATIC_BAND_HEIGHT of the screen tall rolling down it every 1 / STATIC_ROLL_SPEED seconds,
// where the snow is STATIC_BAND times stronger.
const PULSE_SQUEEZE = 0.12;
const PULSE_DARKEN = 0.08;
const TENDRIL_REACH = 0.9;
const TENDRIL_MAX = 0.5;
const ABERRATION_SHIFT = 0.02;
const ABERRATION_SATURATION = 1.8;
const ABERRATION_THROUGH_DARK = 0.5;
const ABERRATION_RING = 2.5;
const STATIC_PIXEL = 2;
const STATIC_FPS = 24;
const STATIC_AMOUNT = 0.14;
const STATIC_SCANLINES = 0.12;
const STATIC_BAND_HEIGHT = 0.12;
const STATIC_ROLL_SPEED = 0.25;
const STATIC_BAND = 1.8;
// The comic panic lines (values from fear.ts), around `lineFocus`, the middle of the Hunter's
// model on screen. Each stroke has a fixed direction, so strokes never move round: stroke k points
// at the base-2 van der Corput fraction of k of a turn (0, 1/2, 1/4, 3/4, 1/8, ...), so the first 8
// are spread evenly and every later one lands halfway between two existing ones (12 fills every
// other gap, 16 all of them). When the band adds strokes they all grow out together from
// LINE_EMERGE_FROM of the way to where they start (and shrink back there together when it drops).
// Each starts LINE_INNER world units
// out (just clear of the model) plus up to LINE_JITTER, is pushed out by LINE_PULSE at each
// heartbeat, and varies its length by up to LINE_LENGTH_JITTER either way. Its centreline is a
// zigzag of straight segments meeting at sharp corners, and it narrows in straight lines to sharp
// points over the last 1 / LINE_TIP of its length at each end. Dark purple LINE_COLOR ink, edged
// in black LINE_OUTLINE of its half-width (never under LINE_OUTLINE_MIN_PX screen pixels), so a
// thin stroke keeps its colour; both edges are anti-aliased across one pixel centred on the edge.
// Drawn after the darkening (so they stay visible in it) and before the static.
const LINE_SLOTS = 32;
const LINE_INNER = 18;
const LINE_JITTER = 3;
const LINE_PULSE = 2;
const LINE_LENGTH_JITTER = 0.2;
const LINE_TIP = 1.5;
const LINE_EMERGE_FROM = 0.7;
const LINE_COLOR = 'rgb(79, 45, 102)';
const LINE_OUTLINE = 0.45;
const LINE_OUTLINE_MIN_PX = 0.75;

const FEAR_SHADER = {
  uniforms: {
    tDiffuse: { value: null }, focus: { value: new Vector2(0.5, 0.5) }, aspect: { value: 1 }, scale: { value: 0.002 },
    radius: { value: 600 }, softness: { value: 300 }, darkness: { value: 0 }, desaturation: { value: 0 },
    tendrils: { value: 0 }, aberration: { value: 0 }, tvStatic: { value: 0 }, pulse: { value: 0 }, time: { value: 0 },
    lineFocus: { value: new Vector2(0.5, 0.5) }, pixels: { value: 600 }, lineColor: { value: new Color(LINE_COLOR) },
    lines: { value: 0 }, linesSettled: { value: 0 }, lineEmerge: { value: 0 }, lineLength: { value: 0 }, lineWidth: { value: 0 }, lineWave: { value: 0 }, lineWaves: { value: 0 },
    linePhase: { value: 0 },
  },
  vertexShader: GRADE_SHADER.vertexShader,
  fragmentShader: /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 focus;
uniform float aspect;
uniform float scale;
uniform float radius;
uniform float softness;
uniform float darkness;
uniform float desaturation;
uniform float tendrils;
uniform float aberration;
uniform float tvStatic;
uniform vec2 lineFocus;
uniform float pixels;
uniform vec3 lineColor;
uniform float lines;
uniform float linesSettled;
uniform float lineEmerge;
uniform float lineLength;
uniform float lineWidth;
uniform float lineWave;
uniform float lineWaves;
uniform float linePhase;
uniform float pulse;
uniform float time;
varying vec2 vUv;
float fearHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float fearNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(fearHash(i), fearHash(i + vec2(1.0, 0.0)), f.x), mix(fearHash(i + vec2(0.0, 1.0)), fearHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fearFbm(vec2 p) {
  float value = 0.0;
  float amplitude = 0.5;
  for (int octave = 0; octave < 4; octave++) {
    value += amplitude * fearNoise(p);
    p *= 2.03;
    amplitude *= 0.5;
  }
  return value;
}
// The direction of panic stroke k, in turns: k's binary digits mirrored about the point.
float fearCorput(int k) {
  float turn = 0.0;
  float digit = 0.5;
  for (int bit = 0; bit < 5; bit++) {
    if (((k >> bit) & 1) == 1) turn += digit;
    digit *= 0.5;
  }
  return turn;
}
// The panic lines at this pixel: (ink, black edge) coverage, 0..1 each.
vec2 fearLines() {
  if (lines <= 0.0) return vec2(0.0);
  vec2 offset = (vUv - lineFocus) * vec2(aspect, 1.0) / scale;
  float r = length(offset);
  float start = ${LINE_INNER.toFixed(1)} + ${LINE_PULSE.toFixed(1)} * pulse;
  float reach = start + ${LINE_JITTER.toFixed(1)} + lineLength * ${(1 + LINE_LENGTH_JITTER).toFixed(3)} + lineWave;
  if (r > reach) return vec2(0.0);
  float pixel = 1.0 / (pixels * scale);
  float theta = atan(offset.y, offset.x);
  vec2 ink = vec2(0.0);
  for (int k = 0; k < ${LINE_SLOTS}; k++) {
    if (float(k) >= lines) break;
    float seed = fearHash(vec2(float(k), 3.7));
    // Growing out: the strokes the band just added (or removed) all together, from most of the way
    // out rather than from the centre.
    float emerge = float(k) < linesSettled ? 1.0 : smoothstep(0.0, 1.0, lineEmerge);
    if (emerge < 0.01) continue;
    float delta = theta - fearCorput(k) * 6.2831853 - 0.4;
    delta = atan(sin(delta), cos(delta));
    if (abs(delta) > 1.2) continue;
    float strokeStart = (start + seed * ${LINE_JITTER.toFixed(1)}) * mix(${LINE_EMERGE_FROM.toFixed(3)}, 1.0, emerge);
    float strokeLength = lineLength * emerge * (1.0 + ${LINE_LENGTH_JITTER.toFixed(3)} * (2.0 * fearHash(vec2(float(k), 9.1)) - 1.0));
    float along = (r * cos(delta) - strokeStart) / strokeLength;
    if (along < 0.0 || along > 1.0) continue;
    float wave = lineWave * (4.0 * abs(fract(lineWaves * along - linePhase + seed) - 0.5) - 1.0);
    float side = abs(r * sin(delta) - wave);
    float halfWidth = 0.5 * lineWidth * min(1.0, (1.0 - abs(2.0 * along - 1.0)) * ${LINE_TIP.toFixed(3)});
    float outer = halfWidth + max(halfWidth * ${LINE_OUTLINE.toFixed(3)}, ${LINE_OUTLINE_MIN_PX.toFixed(2)} * pixel);
    float core = 1.0 - smoothstep(halfWidth - 0.5 * pixel, halfWidth + 0.5 * pixel, side);
    float edge = 1.0 - smoothstep(outer - 0.5 * pixel, outer + 0.5 * pixel, side);
    ink = max(ink, vec2(core, edge));
  }
  return ink;
}
vec3 fearDrain(vec3 color, float amount) {
  return mix(color, vec3(dot(color, vec3(0.2126, 0.7152, 0.0722))), amount);
}
void main() {
  vec2 offset = (vUv - focus) * vec2(aspect, 1.0);
  float distance = length(offset) / scale;
  // Tendrils: the edge wavers like ink, by direction from the Hunter (no seam) and drifting.
  vec2 around = offset / max(length(offset), 1e-4);
  float wisps = fearFbm(around * 2.2 + vec2(time * 0.21, -time * 0.17) + distance * 0.006) - 0.5;
  float reach = min(softness * ${TENDRIL_REACH.toFixed(3)}, radius * ${TENDRIL_MAX.toFixed(3)});
  float edge = distance + tendrils * wisps * reach;
  float inner = radius * (1.0 - ${PULSE_SQUEEZE.toFixed(3)} * pulse);
  float dark = darkness * smoothstep(inner, inner + softness, edge);
  float far = smoothstep(inner * 0.6, inner + softness, distance);
  dark = min(0.98, dark + ${PULSE_DARKEN.toFixed(3)} * pulse * far);
  // Drain each tap, then split: red from one side, blue from the other, green from the centre.
  float split = smoothstep(inner * 0.5, inner + softness * 0.6, distance)
    * (1.0 - smoothstep(inner + softness, inner + softness * ${ABERRATION_RING.toFixed(3)}, distance));
  vec2 shift = (vUv - focus) * aberration * ${ABERRATION_SHIFT.toFixed(4)} * split;
  vec4 texel = texture2D(tDiffuse, vUv);
  float drain = desaturation * (0.35 + 0.65 * far);
  vec3 centre = fearDrain(texel.rgb, drain);
  vec3 fringe = vec3(fearDrain(texture2D(tDiffuse, vUv + shift).rgb, drain).r, centre.g,
    fearDrain(texture2D(tDiffuse, vUv - shift).rgb, drain).b) - centre;
  vec3 color = centre * (1.0 - dark)
    + fringe * ${ABERRATION_SATURATION.toFixed(3)} * (1.0 - dark * ${ABERRATION_THROUGH_DARK.toFixed(3)});
  // Panic lines: the black edge, then the pale core over it.
  vec2 ink = fearLines();
  color = mix(color, vec3(0.0), ink.y);
  color = mix(color, lineColor, ink.x);
  // TV static: scanlines, then snow, stronger inside the rolling band. The frame number is wrapped
  // so the hash's input stays small and its pattern never degrades over a long match.
  float row = mod(floor(gl_FragCoord.y / ${STATIC_PIXEL.toFixed(1)}), 3.0);
  color *= 1.0 - ${STATIC_SCANLINES.toFixed(3)} * tvStatic * step(row, 0.5);
  float frame = mod(floor(time * ${STATIC_FPS.toFixed(1)}), 251.0);
  float snow = fearHash(floor(gl_FragCoord.xy / ${STATIC_PIXEL.toFixed(1)}) + vec2(frame * 13.1, frame * 7.7)) - 0.5;
  float roll = fract(vUv.y + time * ${STATIC_ROLL_SPEED.toFixed(3)});
  float band = 1.0 + (${STATIC_BAND.toFixed(3)} - 1.0) * smoothstep(0.0, ${(STATIC_BAND_HEIGHT / 2).toFixed(3)}, roll)
    * (1.0 - smoothstep(${(STATIC_BAND_HEIGHT / 2).toFixed(3)}, ${STATIC_BAND_HEIGHT.toFixed(3)}, roll));
  vec3 perceived = sqrt(max(color, vec3(0.0))) + snow * tvStatic * ${STATIC_AMOUNT.toFixed(3)} * band;
  color = perceived * max(perceived, vec3(0.0));
  gl_FragColor = vec4(max(color, vec3(0.0)), texel.a);
}`,
};

// The smallest size the composer is given: the bloom halves its target five times, and a
// zero-sized target is an incomplete framebuffer. The arena is 1 px across before layout.
const MIN_SIZE = 64;

// Where the fear effects are centred: the viewer's own Hunter on screen (UV, origin bottom left)
// and screen heights per world unit there.
export type FearFocus = { x: number; y: number; scale: number; lineX: number; lineY: number };

export type Post = {
  render: () => void; setFear: (frame: FearFrame, focus: FearFocus, time: number) => void;
  setSize: (width: number, height: number) => void; dispose: () => void;
};

// The composer renders the scene into a multisampled half-float target (so the canvas's
// anti-aliasing is kept and bright light can exceed 1 for the bloom), then blooms, grades, and
// converts to the canvas's colour space in OutputPass, as rendering straight to it did. With bloom
// and grade off and no fear, it renders straight to the canvas, as before.
export function createPost(renderer: WebGLRenderer, scene: Scene, camera: Camera): Post {
  const target = new WebGLRenderTarget(MIN_SIZE, MIN_SIZE, { type: HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new Vector2(MIN_SIZE, MIN_SIZE), BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD);
  composer.addPass(bloom);
  const grade = new ShaderPass(GRADE_SHADER);
  composer.addPass(grade);
  const fear = new ShaderPass(FEAR_SHADER);
  fear.enabled = false;
  composer.addPass(fear);
  const output = new OutputPass();
  composer.addPass(output);

  return {
    render() {
      if (!VFX.bloom && !VFX.grade && !fear.enabled) {
        renderer.setRenderTarget(null);
        renderer.render(scene, camera);
        return;
      }
      bloom.enabled = VFX.bloom;
      grade.enabled = VFX.grade;
      composer.render();
    },
    setFear(frame, focus, time) {
      fear.enabled = frame.active;
      const { uniforms } = fear;
      uniforms.focus.value.set(focus.x, focus.y);
      uniforms.lineFocus.value.set(focus.lineX, focus.lineY);
      uniforms.scale.value = focus.scale;
      uniforms.time.value = time;
      for (const key of ['radius', 'softness', 'darkness', 'desaturation', 'tendrils', 'aberration', 'tvStatic', 'pulse',
        'lines', 'linesSettled', 'lineEmerge', 'lineLength', 'lineWidth', 'lineWave', 'lineWaves', 'linePhase'] as const) {
        uniforms[key].value = frame[key];
      }
    },
    setSize(width, height) {
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(Math.max(width, MIN_SIZE), Math.max(height, MIN_SIZE));
      fear.uniforms.aspect.value = width / height;
      fear.uniforms.pixels.value = Math.max(height, MIN_SIZE) * renderer.getPixelRatio();
    },
    dispose() {
      bloom.dispose();
      grade.dispose();
      fear.dispose();
      output.dispose();
      composer.dispose();
    },
  };
}
