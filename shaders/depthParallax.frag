#version 300 es
// Depth Parallax — an ANIMATED effect. Offsets the color lookup by the depth
// value over time, giving a subtle 3D wobble. Demonstrates the uTime uniform and
// the animation → sequence → ffmpeg pipeline.
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uColor;
uniform sampler2D uDepth;
uniform vec2  uResolution;
uniform float uTime;
uniform float uAmplitude;   // how far near/far pixels swing
uniform float uSpeed;       // wobble speed

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

void main() {
    float d = luma(texture(uDepth, vUv).rgb) - 0.5;
    vec2 off = d * uAmplitude * vec2(sin(uTime * uSpeed), cos(uTime * uSpeed * 0.92));
    fragColor = vec4(texture(uColor, vUv + off).rgb, 1.0);
}
