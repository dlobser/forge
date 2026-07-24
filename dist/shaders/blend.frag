#version 300 es
// Blend — mixes image A (COLOR slot) with image B (DEPTH slot) using one of five
// classic blend modes. uMix fades from the base toward the blended result.
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uColor;   // image A (base)
uniform sampler2D uDepth;   // image B (blend)
uniform vec2  uResolution;
uniform float uMode;        // 0 add, 1 multiply, 2 difference, 3 overlay, 4 screen
uniform float uMix;         // 0 = base only, 1 = full blend
uniform float uSwap;        // 1 = swap A/B

void main() {
    vec3 a = texture(uColor, vUv).rgb;
    vec3 b = texture(uDepth, vUv).rgb;
    if (uSwap > 0.5) { vec3 t = a; a = b; b = t; }

    vec3 r;
    if (uMode < 0.5)      r = a + b;                                              // add
    else if (uMode < 1.5) r = a * b;                                             // multiply
    else if (uMode < 2.5) r = abs(a - b);                                        // difference
    else if (uMode < 3.5) r = mix(2.0 * a * b, 1.0 - 2.0 * (1.0 - a) * (1.0 - b), step(0.5, a)); // overlay
    else                  r = 1.0 - (1.0 - a) * (1.0 - b);                       // screen

    r = clamp(r, 0.0, 1.0);
    fragColor = vec4(mix(a, r, uMix), 1.0);
}
