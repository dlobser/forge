#version 300 es
// Sine Wave — sin(luma*freq*2pi + time*speed) * Mult + Add. Not clamped, so Mult/Add
// can push the result well outside 0..1 on purpose.
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uColor;
uniform vec2  uResolution;
uniform float uTime;
uniform float uFreq;
uniform float uSpeed;
uniform float uMult;
uniform float uAdd;
const float TAU = 6.28318530718;
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
void main() {
    float v = luma(texture(uColor, vUv).rgb);
    float s = sin(v * uFreq * TAU + uTime * uSpeed);
    fragColor = vec4(vec3(s * uMult + uAdd), 1.0);
}
