#version 300 es
// Smoothstep — per-channel smoothstep(edge0, edge1, x).
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uColor;
uniform vec2  uResolution;
uniform float uEdge0;
uniform float uEdge1;
void main() {
    vec3 c = texture(uColor, vUv).rgb;
    float e1 = (abs(uEdge1 - uEdge0) < 1e-4) ? uEdge0 + 1e-4 : uEdge1;
    fragColor = vec4(smoothstep(vec3(uEdge0), vec3(e1), c), 1.0);
}
