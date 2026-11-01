// The screen wipe, after Shadertoy wlKfzc: a grid of diamonds grows from the left until it covers
// the window, the page swaps screens behind it, and the diamonds shrink away the same way. It is a
// transparent WebGL canvas over everything (#transition), hidden with nothing running between
// wipes. Without WebGL 2, or with reduced motion asked for, screens swap at once.

// Durations of the three parts, the grid's rows (columns follow the window's shape so the
// diamonds stay square) and the colour of the cover.
export const TRANSITION = {
  COVER_SECONDS: 0.45,
  HOLD_SECONDS: 0.05,
  REVEAL_SECONDS: 0.45,
  ROWS: 15,
  COLOR: '#0d0a10',
};

// The shader's clock. Each cell's diamond is |t − x|³ across (x the cell's column, 0 at the left),
// less CLEAR so that at REST every cell is empty. At ±COVERED from the far edge every diamond fills
// its cell, corners and all. The cover runs t from REST up to 1 + COVERED, the reveal from −COVERED
// up to REST: both sweep left to right.
const REST = 0.5;
const CLEAR = 0.125;
const COVERED = 1.3;

const VERTEX = `#version 300 es
void main() {
  // One triangle over the whole viewport.
  vec2 corner = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  gl_Position = vec4(corner, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform vec2 resolution;
uniform vec2 grid;
uniform float fadeTimer;
uniform vec3 color;
out vec4 fragColor;
void main() {
  vec2 uv = gl_FragCoord.xy / resolution;
  // Two units per cell, so each cell's own coordinates run from -1 to 1 about its centre.
  vec2 posI = uv * grid * 2.0;
  vec2 pos = mod(posI, 2.0) - 1.0;
  float column = floor(posI.x / 2.0) / grid.x;
  float size = pow(abs(fadeTimer - column), 3.0) - ${CLEAR.toFixed(3)};
  if (size <= 0.0) {
    fragColor = vec4(0.0);
    return;
  }
  // A diamond is |x| + |y| < size; its edge is softened by a pixel.
  float distance = abs(pos.x) + abs(pos.y);
  float edge = fwidth(distance);
  float cover = 1.0 - smoothstep(size - edge, size + edge, distance);
  fragColor = vec4(color * cover, cover);
}`;

export type Transition = {
  // Covers the window, calls `swap` at full cover, then reveals. Called again during the cover it
  // only replaces `swap`; during the reveal it is ignored, and `onSettle` runs once the reveal ends
  // so the caller can ask again. Under the page's opening cover it swaps at once.
  run(swap: () => void): void;
  // The page opens covered (index.html); this plays the reveal.
  reveal(): void;
};

export function createTransition(canvas: HTMLCanvasElement, onSettle: () => void): Transition {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let gl = canvas.getContext('webgl2', { alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: true });
  const uniforms = gl ? compile(gl) : null;
  if (!uniforms) gl = null;
  canvas.addEventListener('webglcontextlost', () => { gl = null; });

  type Phase = 'idle' | 'cover' | 'hold' | 'reveal';
  let phase: Phase = 'idle';
  // The page opens covered by the canvas's own background, until reveal().
  let covered = true;
  let phaseStart = 0;
  let swap: (() => void) | null = null;
  let frame = 0;

  const animated = () => gl !== null && !reducedMotion.matches;

  function fit(): void {
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(window.innerWidth * scale));
    const height = Math.max(1, Math.round(window.innerHeight * scale));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  }

  function draw(fadeTimer: number): void {
    if (!gl || !uniforms) return;
    fit();
    const rows = TRANSITION.ROWS;
    const columns = Math.max(1, Math.round(rows * canvas.width / canvas.height));
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(uniforms.resolution, canvas.width, canvas.height);
    gl.uniform2f(uniforms.grid, columns, rows);
    gl.uniform1f(uniforms.fadeTimer, fadeTimer);
    gl.uniform3fv(uniforms.color, rgb(TRANSITION.COLOR));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function begin(next: Phase, now: number): void {
    phase = next;
    phaseStart = now;
  }

  function finish(): void {
    window.cancelAnimationFrame(frame);
    phase = 'idle';
    covered = false;
    canvas.hidden = true;
    canvas.style.background = '';
    onSettle();
  }

  function step(now: number): void {
    if (!animated()) {
      // The context went, or reduced motion was turned on, mid-wipe: finish at once.
      const pending = swap;
      swap = null;
      pending?.();
      finish();
      return;
    }
    const elapsed = (now - phaseStart) / 1000;
    if (phase === 'cover') {
      const progress = Math.min(1, elapsed / TRANSITION.COVER_SECONDS);
      draw(REST + progress * (1 + COVERED - REST));
      if (progress === 1) begin('hold', now);
    } else if (phase === 'hold') {
      if (swap) {
        const pending = swap;
        swap = null;
        pending();
      }
      if (elapsed >= TRANSITION.HOLD_SECONDS) begin('reveal', now);
    } else if (phase === 'reveal') {
      canvas.style.background = '';
      const progress = Math.min(1, elapsed / TRANSITION.REVEAL_SECONDS);
      draw(-COVERED + progress * (REST + COVERED));
      if (progress === 1) return finish();
    }
    frame = window.requestAnimationFrame(step);
  }

  return {
    run(next) {
      if (phase === 'reveal') return;
      if (phase === 'cover' || phase === 'hold') {
        swap = next;
        return;
      }
      // Still under the page's opening cover, or not animating: swap at once.
      if (covered || !animated()) {
        next();
        return;
      }
      swap = next;
      canvas.hidden = false;
      begin('cover', performance.now());
      frame = window.requestAnimationFrame(step);
    },
    reveal() {
      if (!covered || phase !== 'idle') return;
      if (!animated()) {
        covered = false;
        canvas.hidden = true;
        canvas.style.background = '';
        return;
      }
      // Draw the full cover first, so taking the CSS background away shows no gap.
      draw(-COVERED);
      begin('reveal', performance.now());
      frame = window.requestAnimationFrame(step);
    },
  };
}

function compile(gl: WebGL2RenderingContext) {
  const shader = (type: number, source: string) => {
    const result = gl.createShader(type)!;
    gl.shaderSource(result, source);
    gl.compileShader(result);
    return result;
  };
  const program = gl.createProgram();
  gl.attachShader(program, shader(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);
  // The triangle's corners come from gl_VertexID, so no buffers; WebGL 2 still wants a bound array.
  gl.bindVertexArray(gl.createVertexArray());
  gl.clearColor(0, 0, 0, 0);
  return {
    resolution: gl.getUniformLocation(program, 'resolution'),
    grid: gl.getUniformLocation(program, 'grid'),
    fadeTimer: gl.getUniformLocation(program, 'fadeTimer'),
    color: gl.getUniformLocation(program, 'color'),
  };
}

function rgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16 & 255) / 255, (value >> 8 & 255) / 255, (value & 255) / 255];
}
