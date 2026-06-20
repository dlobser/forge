#version 300 es
// Color Grade — hue offset / saturation / contrast / brightness, optionally
// confined to a depth-driven mask. The mask is smoothstep(lo, hi, depth) so you
// can grade only the near or far parts of the image.
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uColor;
uniform sampler2D uDepth;
uniform vec2  uResolution;

uniform float uHue;          // -0.5 .. 0.5 (wraps)
uniform float uSat;          // 0 .. 2
uniform float uContrast;     // 0 .. 2
uniform float uBright;       // 0 .. 2
uniform vec3  uTint;         // tint colour (multiplies the graded result)
uniform float uTintAmt;      // 0 .. 1

uniform float uUseDepthMask; // 0/1
uniform float uMaskLo;       // smoothstep edge 0
uniform float uMaskHi;       // smoothstep edge 1
uniform float uMaskInvert;   // 0/1

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

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

void main() {
    vec3 color = texture(uColor, vUv).rgb;

    vec3 hsv = rgb2hsv(color);
    hsv.x = fract(hsv.x + uHue);
    hsv.y = clamp(hsv.y * uSat, 0.0, 1.0);
    vec3 graded = hsv2rgb(hsv);
    graded *= uBright;
    graded = (graded - 0.5) * uContrast + 0.5;
    graded = clamp(graded, 0.0, 1.0);
    graded *= mix(vec3(1.0), uTint, uTintAmt);

    float mask = 1.0;
    if (uUseDepthMask > 0.5) {
        float d = luma(texture(uDepth, vUv).rgb);
        mask = smoothstep(uMaskLo, uMaskHi, d);
        if (uMaskInvert > 0.5) mask = 1.0 - mask;
    }

    fragColor = vec4(mix(color, graded, mask), 1.0);
}
