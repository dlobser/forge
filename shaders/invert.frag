#version 300 es
// Invert — invert color channels, luminance, or HSV value with mix and channel toggles.
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uColor;       // Base image input
uniform float uMix;             // 0 = original, 1 = inverted
uniform float uMode;            // 0 = RGB Channels, 1 = Luminance, 2 = HSV Value
uniform float uInvertR;         // 1 = invert Red
uniform float uInvertG;         // 1 = invert Green
uniform float uInvertB;         // 1 = invert Blue
uniform float uInvertAlpha;     // 1 = invert Alpha

vec3 rgb2hsv(vec3 c) {
    vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
    vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
    vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));

    float d = q.x - min(q.w, q.y);
    float e = 1.0e-10;
    return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

void main() {
    vec4 tex = texture(uColor, vUv);
    vec3 originalRgb = tex.rgb;
    vec3 invertedRgb;

    if (uMode < 0.5) {
        // Channel mode: invert selected channels
        invertedRgb = vec3(
            uInvertR > 0.5 ? (1.0 - originalRgb.r) : originalRgb.r,
            uInvertG > 0.5 ? (1.0 - originalRgb.g) : originalRgb.g,
            uInvertB > 0.5 ? (1.0 - originalRgb.b) : originalRgb.b
        );
    } else if (uMode < 1.5) {
        // Luminance mode: invert brightness, preserve color ratios
        float luma = dot(originalRgb, vec3(0.299, 0.587, 0.114));
        float invLuma = 1.0 - luma;
        invertedRgb = luma > 1.0e-5 ? clamp(originalRgb * (invLuma / luma), 0.0, 1.0) : vec3(invLuma);
    } else {
        // HSV Value mode: invert brightness value in HSV space
        vec3 hsv = rgb2hsv(originalRgb);
        hsv.z = 1.0 - hsv.z;
        invertedRgb = hsv2rgb(hsv);
    }

    vec3 finalRgb = mix(originalRgb, invertedRgb, uMix);

    float finalAlpha = tex.a;
    if (uInvertAlpha > 0.5) {
        finalAlpha = mix(tex.a, 1.0 - tex.a, uMix);
    }

    fragColor = vec4(finalRgb, finalAlpha);
}
