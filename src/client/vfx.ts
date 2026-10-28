import {
  AdditiveBlending,
  BackSide,
  Color,
  DoubleSide,
  type Material,
  ShaderMaterial,
  Vector3,
  Vector4,
  type WebGLProgramParametersWithUniforms,
} from 'three';

// Visual experiments, client-only and individually switchable. On the Hunter and the Creature: a
// black cartoon outline, and shading from the scene's light with a dithered edge between light
// and shadow.
// On the flashlight: a soft volumetric beam with a glow at the lens, and the light itself
// lighting the floors and walls it reaches. None of it changes what the light hits; the server
// decides that.
// On the floors and walls: hard, unfiltered texels instead of smooth filtering.
// On the whole picture (post.ts): a soft bloom, and a night grade with a vignette. Under the
// players and batteries: soft round blob shadows.
export const VFX = {
  outline: true,
  ditherShading: true,
  beam: true,
  lightPool: true,
  blobShadows: true,
  bloom: true,
  grade: true,
  pixelTextures: false,
};
export type VfxKey = keyof typeof VFX;

// Outline thickness as a fraction of the viewport height, so it reads the same at any resolution.
export const OUTLINE_WIDTH = 1 / 600;
// The staggered Creature's outline: white and thicker, shown even with the outline toggled off.
export const STAGGER_OUTLINE_COLOR = '#ffffff';
export const STAGGER_OUTLINE_WIDTH = 3.5 / 600;
// The Hunter's shadow tone as a multiple of its body colour.
const SHADOW_STRENGTH = 0.55;
// Where the dithered edge between light and shadow sits on N·L, and how wide it is.
const DITHER_BAND = { start: -0.15, width: 0.5 };

// Flashlight colour, shared by the beam, the lens glow and the light pool.
export const LIGHT_COLOR = '#ffe9a8';
// Beam brightness where it is densest, the share of its length after which it fades out, and
// the height over which it fades into the floor (so the edge where the cone's lower half meets
// the floor is soft instead of a hard step in brightness).
const BEAM_INTENSITY = 0.27;
const BEAM_FADE_START = 0.8;
const BEAM_FLOOR_SOFT = 14;
// Lens glow brightness at its centre.
const GLOW_INTENSITY = 0.9;
// The light pool: the flashlight lighting the floors and walls it reaches. It spreads wider than
// the hit cone (POOL_SPREAD times its angle, at most POOL_MAX_ANGLE) and further (POOL_REACH
// times the battery stage's range), so it shortens with the battery like the beam. Its
// brightness, as a share of the surface's own colour, is POOL_INTENSITY at the Hunter, fading
// smoothly to nothing at its reach (sharpened by POOL_FALLOFF above 1) and softened toward its sides from POOL_SOFT_SIDES of its
// half-angle. Inside the real hit cone it is brighter by POOL_CORE_BOOST, so the aim still reads.
// POOL_RAYS rays measure where walls stop it, like the fan.
export const POOL_SPREAD = 1.8;
export const POOL_MAX_ANGLE = 170;
export const POOL_REACH = 1.5;
export const POOL_RAYS = 32;
const POOL_INTENSITY = 1.3;
const POOL_FALLOFF = 1.0;
const POOL_SOFT_SIDES = 0.35;
const POOL_CORE_BOOST = 0.35;
// Pool slots: one per Hunter, each in one component of a vec4.
export const POOL_SLOTS = 4;
// Blob shadows: their darkness at the centre, under the Hunters and batteries and under the
// hovering Creature.
const BLOB_SHADOW_OPACITY = 0.45;
const CREATURE_BLOB_SHADOW_OPACITY = 0.3;

// Shared by the patched materials. Only one scene exists at a time, so these are module-level.
export const VFX_UNIFORMS = {
  vfxLightDirection: { value: new Vector3(0, 1, 0) },
  vfxDitherShading: { value: 1 },
  vfxAspect: { value: 1 },
};

// 4x4 ordered-dither threshold in [0, 1) for a pixel coordinate, built from the 2x2 Bayer matrix.
const BAYER_GLSL = /* glsl */ `
float vfxBayer2(vec2 a) { a = floor(a); return fract(dot(a, vec2(0.5, a.y * 0.75))); }
float vfxBayer4(vec2 a) { return vfxBayer2(0.5 * a) * 0.25 + vfxBayer2(a) + 1.0 / 32.0; }
`;

// The Hunter and Creature bodies: emissive (unlit) in their model files. This shades them from
// the scene's light, light or shadow per screen pixel, with the edge between them broken up by
// an ordered dither.
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

// Inverted-hull outline: the model drawn again, back faces only, each vertex pushed out along
// its normal in screen space so the line has the same width everywhere on screen. Black at
// OUTLINE_WIDTH; each material has its own colour and width so the Creature's can change.
export function createOutlineMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    side: BackSide,
    uniforms: {
      vfxOutlineWidth: { value: OUTLINE_WIDTH },
      vfxOutlineColor: { value: new Color('#000000') },
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
uniform vec3 vfxOutlineColor;
void main() {
  gl_FragColor = vec4(vfxOutlineColor, 1.0);
}`,
  });
}

// The Hunters' outline, shared by all of them.
export const OUTLINE_MATERIAL = createOutlineMaterial();

// Shared by the flashlight shaders: wraps an angle into -pi..pi.
const ANGLE_GLSL = /* glsl */ `
float vfxWrapAngle(float a) { return atan(sin(a), cos(a)); }
`;

// The light pool's per-frame state, shared by every floor and wall material (one scene at a
// time). Each Hunter slot is one component: `flashOrigin[slot]` is (x, z, facing, pool reach)
// and `flashOn` is how bright each slot's light is: 0 when off, 1 when on, in between while the
// viewer's own light stutters near the Creature (fear.ts). `flashReach[ray]` is how far each slot's ray
// travels before a wall, across the pool's angle (the same wall test as the fan and the server).
// The angles and heights are the same for every Hunter.
export const POOL_UNIFORMS = {
  flashOrigin: { value: Array.from({ length: POOL_SLOTS }, () => new Vector4()) },
  flashOn: { value: new Vector4() },
  flashReach: { value: Array.from({ length: POOL_RAYS + 1 }, () => new Vector4()) },
  flashHalfAngle: { value: 1 },
  flashCoreHalfAngle: { value: 1 },
  flashLensY: { value: 0 },
  flashFloorY: { value: 0 },
  flashColor: { value: new Color(LIGHT_COLOR) },
};

// The flashlight lighting a floor or wall material (MeshLambertMaterial): every lit slot adds
// warm light to the surface's own colour, brightest near the Hunter and fading with distance,
// with soft sides and a brighter core inside the hit cone. A fragment further than its ray's
// reach is behind a wall and gets nothing; the small margin lets the wall face the ray stops at
// catch the light, while wall tops stay dark. Positions and normals are world space (the
// surface meshes are untransformed). Called first by every surface material's onBeforeCompile.
export function flashlitSurfaceShader(shader: WebGLProgramParametersWithUniforms): void {
  Object.assign(shader.uniforms, POOL_UNIFORMS);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vFlashWorld;\nvarying vec3 vFlashNormal;')
    .replace('#include <project_vertex>', `#include <project_vertex>
vFlashWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
vFlashNormal = normalize(mat3(modelMatrix) * objectNormal);`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', /* glsl */ `#include <common>
varying vec3 vFlashWorld;
varying vec3 vFlashNormal;
uniform vec4 flashOrigin[${POOL_SLOTS}];
uniform vec4 flashOn;
uniform vec4 flashReach[${POOL_RAYS + 1}];
uniform float flashHalfAngle;
uniform float flashCoreHalfAngle;
uniform float flashLensY;
uniform float flashFloorY;
uniform vec3 flashColor;
${ANGLE_GLSL}
float vfxFlashlight(vec3 world, vec3 normal) {
  // Wall tops are never lit: the light stops at the face below them.
  if (normal.y > 0.5 && world.y > flashFloorY + 1.0) return 0.0;
  float total = 0.0;
  for (int slot = 0; slot < ${POOL_SLOTS}; slot++) {
    if (flashOn[slot] <= 0.0) continue;
    vec4 origin = flashOrigin[slot];
    vec2 offset = world.xz - origin.xy;
    float distance = length(offset);
    if (distance > origin.w + 2.0) continue;
    float angle = vfxWrapAngle(atan(offset.y, offset.x) - origin.z);
    float across = angle / flashHalfAngle;
    if (abs(across) > 1.0) continue;
    float ray = (across * 0.5 + 0.5) * float(${POOL_RAYS});
    int first = int(min(floor(ray), float(${POOL_RAYS - 1})));
    float reach = mix(flashReach[first][slot], flashReach[first + 1][slot], ray - float(first));
    float wall = 1.0 - smoothstep(reach, reach + 2.0, distance);
    float fade = pow(1.0 - smoothstep(0.0, 1.0, distance / origin.w), ${POOL_FALLOFF.toFixed(3)});
    float sides = 1.0 - smoothstep(${POOL_SOFT_SIDES.toFixed(3)}, 1.0, abs(across));
    // The core: the hit cone, out to the battery stage's range.
    float core = (1.0 - smoothstep(flashCoreHalfAngle * 0.75, flashCoreHalfAngle, abs(angle)))
      * (1.0 - smoothstep(0.8, 1.0, distance * ${POOL_REACH.toFixed(3)} / origin.w));
    vec3 toLens = normalize(vec3(origin.x, flashLensY, origin.y) - world);
    float facing = smoothstep(-0.1, 0.3, dot(normal, toLens));
    total += (${POOL_INTENSITY.toFixed(3)} * sides + ${POOL_CORE_BOOST.toFixed(3)} * core) * fade * wall * facing * flashOn[slot];
  }
  return total;
}`)
    .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
reflectedLight.directDiffuse += diffuseColor.rgb * flashColor * vfxFlashlight(vFlashWorld, normalize(vFlashNormal));`);
}

// A soft round shadow on the floor: black, fading out from the centre. Drawn on a unit circle
// lying flat, scaled to the thing it sits under.
export function createBlobShadowMaterial(creature = false): ShaderMaterial {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { opacity: { value: creature ? CREATURE_BLOB_SHADOW_OPACITY : BLOB_SHADOW_OPACITY } },
    vertexShader: /* glsl */ `
varying vec2 vOffset;
void main() {
  vOffset = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`,
    fragmentShader: /* glsl */ `
uniform float opacity;
varying vec2 vOffset;
void main() {
  gl_FragColor = vec4(0.0, 0.0, 0.0, opacity * (1.0 - smoothstep(0.35, 1.0, length(vOffset))));
}`,
  });
}

// The volumetric beam: an open cone from the lens, drawn additively on both sides. It is
// densest where the view looks straight through it, fades toward its silhouette and over the
// last part of its length (from BEAM_FADE_START) and into the floor, and is cut where the flashlight's rays meet a wall: `reaches` holds the distance
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
  float fade = 1.0 - smoothstep(${BEAM_FADE_START.toFixed(3)}, 1.0, along);
  float facingView = abs(dot(normalize(vViewNormal), normalize(-vViewPosition)));
  float floorFade = smoothstep(0.0, ${BEAM_FLOOR_SOFT.toFixed(1)}, vWorld.y - floorY);
  float strength = ${BEAM_INTENSITY.toFixed(3)} * facingView * facingView * fade * wall * floorFade;
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
