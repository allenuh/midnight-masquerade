// Post-processing over the finished picture: a soft bloom on the brightest things (the lens
// glow, the burning Creature, the core of a flashlight's pool) and a quiet night grade with a
// vignette. Both are switched live by VFX.bloom and VFX.grade (vfx.ts).
import {
  type Camera, HalfFloatType, type Scene, Vector2, type WebGLRenderer, WebGLRenderTarget,
} from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
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

// The smallest size the composer is given: the bloom halves its target five times, and a
// zero-sized target is an incomplete framebuffer. The arena is 1 px across before layout.
const MIN_SIZE = 64;

export type Post = { render: () => void; setSize: (width: number, height: number) => void; dispose: () => void };

// The composer renders the scene into a multisampled half-float target (so the canvas's
// anti-aliasing is kept and bright light can exceed 1 for the bloom), then blooms, grades, and
// converts to the canvas's colour space in OutputPass, as rendering straight to it did. With both
// effects off it renders straight to the canvas, as before.
export function createPost(renderer: WebGLRenderer, scene: Scene, camera: Camera): Post {
  const target = new WebGLRenderTarget(MIN_SIZE, MIN_SIZE, { type: HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new Vector2(MIN_SIZE, MIN_SIZE), BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD);
  composer.addPass(bloom);
  const grade = new ShaderPass(GRADE_SHADER);
  composer.addPass(grade);
  const output = new OutputPass();
  composer.addPass(output);

  return {
    render() {
      if (!VFX.bloom && !VFX.grade) {
        renderer.setRenderTarget(null);
        renderer.render(scene, camera);
        return;
      }
      bloom.enabled = VFX.bloom;
      grade.enabled = VFX.grade;
      composer.render();
    },
    setSize(width, height) {
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(Math.max(width, MIN_SIZE), Math.max(height, MIN_SIZE));
    },
    dispose() {
      bloom.dispose();
      grade.dispose();
      output.dispose();
      composer.dispose();
    },
  };
}
