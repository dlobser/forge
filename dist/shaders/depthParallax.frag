#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uColor;
uniform sampler2D uDepth;
uniform vec2  uResolution;
uniform float uAmplitude;
uniform float uOffsetX;
uniform float uOffsetY;

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

void main() {
    float d = luma(texture(uDepth, vUv).rgb) - 0.5;
    vec2 off = d * uAmplitude * vec2(uOffsetX, uOffsetY);
    fragColor = vec4(texture(uColor, vUv + off).rgb, 1.0);
}
