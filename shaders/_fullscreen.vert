#version 300 es
// Shared fullscreen-triangle vertex shader. Any effect that omits its own .vert
// gets this one. Emits vUv in [0,1] with (0,0) at the bottom-left; Forge uploads
// the color/depth textures flipped so images read upright on screen.
precision highp float;
out vec2 vUv;
void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    vUv = p;
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
