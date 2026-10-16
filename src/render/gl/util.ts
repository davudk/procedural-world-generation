export function compileProgram(gl: WebGL2RenderingContext, name: string, vsSrc: string, fsSrc: string): WebGLProgram {
  const vs = compileShader(gl, name, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl, name, gl.FRAGMENT_SHADER, fsSrc);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(`[${name}] link failed: ${gl.getProgramInfoLog(prog) ?? ''}`);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return prog;
}

function compileShader(gl: WebGL2RenderingContext, name: string, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) ?? '';
    const numbered = src.split('\n').map((l, i) => `${String(i + 1).padStart(3)}: ${l}`).join('\n');
    throw new Error(`[${name}] ${type === gl.VERTEX_SHADER ? 'vertex' : 'fragment'} shader: ${log}\n${numbered}`);
  }
  return sh;
}

/** Looks up all active uniforms of a program into a name → location record. */
export function uniforms<K extends string>(gl: WebGL2RenderingContext, prog: WebGLProgram, names: readonly K[]): Record<K, WebGLUniformLocation | null> {
  const out = {} as Record<K, WebGLUniformLocation | null>;
  for (const n of names) out[n] = gl.getUniformLocation(prog, n);
  return out;
}

/** Static unit quad as two triangles, corners in [-1, 1]². */
export function createQuadBuffer(gl: WebGL2RenderingContext): WebGLBuffer {
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);
  return buf;
}
