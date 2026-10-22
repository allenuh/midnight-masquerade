import {
  AdditiveBlending,
  BackSide,
  Color,
  DoubleSide,
  type Material,
  ShaderMaterial,
  Vector3,
  type WebGLProgramParametersWithUniforms,
} from 'three';

// Visual experiments, client-only and individually switchable. On the Hunter: a black cartoon
// outline, and shading from the scene's light with a dithered edge between light and shadow.
// On the flashlight: a soft volumetric beam with a glow at the lens, and the floor fan drawn
// as a pool of light. None of it changes what the light hits; the server decides that.
export const VFX = {
  outline: true,
  ditherShading: true,
  beam: true,
  lightPool: true,
};
export type VfxKey = keyof typeof VFX;

// Outline thickness as a fraction of the viewport height, so it reads the same at any resolution.
const OUTLINE_WIDTH = 1 / 600;
// The Hunter's shadow tone as a multiple of its body colour.
const SHADOW_STRENGTH = 0.55;
// Where the dithered edge between light and shadow sits on N·L, and how wide it is.
const DITHER_BAND = { start: -0.15, width: 0.5 };

// Flashlight colour, shared by the beam, the lens glow and the light pool.
const LIGHT_COLOR = '#ffe9a8';
// Beam brightness where it is densest, and how quickly it fades along its length.
const BEAM_INTENSITY = 0.35;
const BEAM_FADE_POWER = 1.4;
// Lens glow brightness at its centre.
const GLOW_INTENSITY = 0.9;
// Light pool brightness at the Hunter and at the end of its reach, and the share of the cone's
// half-angle over which its sides soften.
const POOL_NEAR = 0.5;
const POOL_FAR = 0.22;
const POOL_SOFT_SIDES = 0.25;

// Shared by the patched materials. Only one scene exists at a time, so these are module-level.
export const VFX_UNIFORMS = {
  vfxLightDirection: { value: new Vector3(0, 1, 0) },
  vfxDitherShading: { value: 1 },
  vfxOutlineWidth: { value: OUTLINE_WIDTH },
  vfxAspect: { value: 1 },
};

// 4x4 ordered-dither threshold in [0, 1) for a pixel coordinate, built from the 2x2 Bayer matrix.
const BAYER_GLSL = /* glsl */ `
float vfxBayer2(vec2 a) { a = floor(a); return fract(dot(a, vec2(0.5, a.y * 0.75))); }
float vfxBayer4(vec2 a) { return vfxBayer2(0.5 * a) * 0.25 + vfxBayer2(a) + 1.0 / 32.0; }
`;

// The Hunter body: emissive (unlit) in the model file. This shades it from the scene's light,
// light or shadow per screen pixel, with the edge between them broken up by an ordered dither.
function ditheredBodyShader(shader: WebGLProgramParametersWithUniforms): void {
  shader.uniforms.vfxLightDirection = VFX_UNIFORMS.vfxLightDirection;
  shader.uniforms.vfxDitherShading = VFX_UNIFORMS.vfxDitherShading;
  shader.fragmentShader = /* glsl */ `
uniform vec3 vfxLightDirection;
uniform float vfxDitherShading;
${BAYER_GLSL}
` + shader.fragmentShader.replace('#include <emissivemap_fragment>', /* glsl */ `#include <emissivemap_fragment>
{
  float vfxLight = clamp((dot(normal, vfxLightDirection) - ${DITHER_BAND.start.toFixed(3)}) / ${DITHER_BAND.width.toFixed(3)}, 0.0, 1.0);
  float vfxShade = vfxLight > vfxBayer4(gl_FragCoord.xy) ? 1.0 : ${SHADOW_STRENGTH.toFixed(3)};
  totalEmissiveRadiance *= mix(1.0, vfxShade, vfxDitherShading);
}`);
}

export function ditheredBody<T extends Material>(material: T): T {
  material.onBeforeCompile = ditheredBodyShader;
  return material;
}

// Inverted-hull outline: the model drawn again, black, back faces only, each vertex pushed
// out along its normal in screen space so the line has the same width everywhere on screen.
export const OUTLINE_MATERIAL = new ShaderMaterial({
  side: BackSide,
  uniforms: {
    vfxOutlineWidth: VFX_UNIFORMS.vfxOutlineWidth,
    vfxAspect: VFX_UNIFORMS.vfxAspect,
  },
  vertexShader: /* glsl */ `
uniform float vfxOutlineWidth;
uniform float vfxAspect;
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  vec2 vfxNormal = (projectionMatrix * vec4(normalize(normalMatrix * normal), 0.0)).xy;
  vec2 vfxPush = normalize(vfxNormal + vec2(1e-6)) * vec2(1.0 / vfxAspect, 1.0);
  gl_Position.xy += vfxPush * vfxOutlineWidth * 2.0 * gl_Position.w;
}`,
  fragmentShader: /* glsl */ `
void main() {
  gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
}`,
});

// Shared by the flashlight shaders: wraps an angle into -pi..pi.
const ANGLE_GLSL = /* glsl */ `
float vfxWrapAngle(float a) { return atan(sin(a), cos(a)); }
`;

// The floor fan as a pool of light: additive warm light, brightest at the Hunter and fading
// with distance, sides softened. The fan's wall-clipped shape is unchanged, so it still shows
// exactly where the light reaches. Positions are world space (the fan mesh is untransformed).
export function createLightPoolMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: AdditiveBlending,
    uniforms: {
      lightColor: { value: new Color(LIGHT_COLOR) },
      lightOrigin: { value: new Vector3() },
      lightFacing: { value: 0 },
      lightRange: { value: 1 },
      lightHalfAngle: { value: 1 },
    },
    vertexShader: /* glsl */ `
varying vec3 vWorld;
void main() {
  vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}`,
    fragmentShader: /* glsl */ `
uniform vec3 lightColor;
uniform vec3 lightOrigin;
uniform float lightFacing;
uniform float lightRange;
uniform float lightHalfAngle;
varying vec3 vWorld;
${ANGLE_GLSL}
void main() {
  vec2 offset = vWorld.xz - lightOrigin.xz;
  float distance = clamp(length(offset) / lightRange, 0.0, 1.0);
  float across = abs(vfxWrapAngle(atan(offset.y, offset.x) - lightFacing)) / lightHalfAngle;
  float sides = 1.0 - smoothstep(1.0 - ${POOL_SOFT_SIDES.toFixed(3)}, 1.0, across);
  float strength = mix(${POOL_NEAR.toFixed(3)}, ${POOL_FAR.toFixed(3)}, distance) * sides;
  gl_FragColor = vec4(lightColor * strength, 1.0);
}`,
  });
}

// The volumetric beam: an open cone from the lens, drawn additively on both sides. It is
// densest where the view looks straight through it, fades toward its silhouette and along its
// length, and is cut where the flashlight's rays meet a wall: `reaches` holds the distance
// each of the fan's rays travels before a wall (the same wall test as the server's line of
// sight), measured from the Hunter's centre across the cone's width.
export function createBeamMaterial(rays: number): ShaderMaterial {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: AdditiveBlending,
    defines: { BEAM_RAYS: rays },
    uniforms: {
      lightColor: { value: new Color(LIGHT_COLOR) },
      lightOrigin: { value: new Vector3() },
      lightApex: { value: new Vector3() },
      lightFacing: { value: 0 },
      lightRange: { value: 1 },
      lightHalfAngle: { value: 1 },
      floorY: { value: 0 },
      reaches: { value: new Float32Array(rays + 1) },
    },
    vertexShader: /* glsl */ `
varying vec3 vWorld;
varying vec3 vViewNormal;
varying vec3 vViewPosition;
void main() {
  vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
  vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
  vViewPosition = viewPosition.xyz;
  vViewNormal = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * viewPosition;
}`,
    fragmentShader: /* glsl */ `
uniform vec3 lightColor;
uniform vec3 lightOrigin;
uniform vec3 lightApex;
uniform float lightFacing;
uniform float lightRange;
uniform float lightHalfAngle;
uniform float floorY;
uniform float reaches[BEAM_RAYS + 1];
varying vec3 vWorld;
varying vec3 vViewNormal;
varying vec3 vViewPosition;
${ANGLE_GLSL}
void main() {
  if (vWorld.y < floorY) discard;
  // Wall cut: compare this point's distance from the Hunter with its ray's reach.
  vec2 offset = vWorld.xz - lightOrigin.xz;
  float across = vfxWrapAngle(atan(offset.y, offset.x) - lightFacing) / lightHalfAngle;
  float ray = clamp((across * 0.5 + 0.5) * float(BEAM_RAYS), 0.0, float(BEAM_RAYS));
  int first = int(min(floor(ray), float(BEAM_RAYS - 1)));
  float reach = mix(reaches[first], reaches[first + 1], ray - float(first));
  float distance = length(offset);
  if (distance > reach) discard;
  float wall = 1.0 - smoothstep(reach - 8.0, reach, distance);
  float along = clamp(length(vWorld - lightApex) / lightRange, 0.0, 1.0);
  float fade = pow(1.0 - along, ${BEAM_FADE_POWER.toFixed(2)});
  float facingView = abs(dot(normalize(vViewNormal), normalize(-vViewPosition)));
  float strength = ${BEAM_INTENSITY.toFixed(3)} * facingView * facingView * fade * wall;
  gl_FragColor = vec4(lightColor * strength, 1.0);
}`,
  });
}

// The lens glow: a small sphere drawn additively, bright where it faces the view and fading
// to nothing at its silhouette, so it reads as a soft point of light.
export function createGlowMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    uniforms: { lightColor: { value: new Color(LIGHT_COLOR) } },
    vertexShader: /* glsl */ `
varying vec3 vViewNormal;
varying vec3 vViewPosition;
void main() {
  vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
  vViewPosition = viewPosition.xyz;
  vViewNormal = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * viewPosition;
}`,
    fragmentShader: /* glsl */ `
uniform vec3 lightColor;
varying vec3 vViewNormal;
varying vec3 vViewPosition;
void main() {
  float facingView = abs(dot(normalize(vViewNormal), normalize(-vViewPosition)));
  gl_FragColor = vec4(lightColor * ${GLOW_INTENSITY.toFixed(3)} * pow(facingView, 3.0), 1.0);
}`,
  });
}
