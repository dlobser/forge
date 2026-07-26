#version 300 es
// Video Feedback — the classic camera-pointed-at-its-own-monitor loop, done right.
//
// Each frame this node samples its OWN previous output (uPrev, supplied by the
// engine's `history: true` path at full output resolution), dims it by uDecay, and
// composites the incoming image on top. Because the previous output already
// contained the one before it, the picture accumulates trails that fade at a rate
// you set. Three things happen to the feedback buffer before it is re-shown, and
// they compose in this order:
//
//   1. a per-iteration TRANSFORM  — translate / rotate / scale, so the trails
//      spiral, drift or zoom instead of sitting still;
//   2. a WARP from a third image  — its red channel displaces horizontally, green
//      vertically. 0.5 is neutral, 0 pushes negative, 1 pushes positive;
//   3. DECAY                      — multiply by uDecay (1.0 = infinite trails).
//
// The MASK input then decides where the incoming image simply wins: white =
// this pixel is replaced outright (live video, no history), black = pure feedback.
// Grey cross-fades. Feed it a shape and the shape stays sharp while everything
// around it smears.
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uColor;   // the incoming image
uniform sampler2D uMask;    // white = replace with the incoming image
uniform sampler2D uWarp;    // r/g = per-pixel warp of the feedback (0.5 = neutral)
uniform sampler2D uPrev;    // this node's previous output (engine-provided)
uniform vec2  uResolution;
uniform float uTime;
uniform float uFirst;       // 1.0 on the first frame after a reset

uniform float uDecay;       // per-frame multiply of the feedback  (0..1.02)
uniform float uGain;        // how strongly the incoming image is added in
uniform float uBlendMode;   // 0 add · 1 screen · 2 max · 3 over · 4 difference
uniform float uWarpAmount;  // warp scale, in fractions of the frame
uniform float uMaskGain;    // multiplies the mask before use
uniform float uMaskInvert;  // 1 = flip the mask
uniform float uTransX;      // per-iteration translate, fractions of the frame
uniform float uTransY;
uniform float uRotate;      // per-iteration rotation, degrees
uniform float uScale;       // per-iteration scale (1 = none)
uniform float uEdge;        // 0 clamp · 1 wrap · 2 mirror · 3 black
uniform float uHueShift;    // per-iteration hue rotation of the feedback

const float PI = 3.14159265359;

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

// Every texture in Forge is point-filtered, which is what you want almost
// everywhere — but not here. A feedback loop resamples itself at sub-pixel offsets
// thousands of times; nearest-neighbour turns that into blocky stair-stepping that
// then feeds back and compounds. So do the bilinear fetch by hand.
vec4 bilinear(sampler2D tex, vec2 uv, vec2 res) {
    vec2 p = uv * res - 0.5;
    vec2 f = fract(p);
    vec2 base = (floor(p) + 0.5) / res;
    vec2 texel = 1.0 / res;
    vec4 a = texture(tex, base);
    vec4 b = texture(tex, base + vec2(texel.x, 0.0));
    vec4 c = texture(tex, base + vec2(0.0, texel.y));
    vec4 d = texture(tex, base + texel);
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// Apply the chosen edge rule, returning false when the sample should read as black.
bool wrapUv(inout vec2 uv) {
    if (uEdge < 0.5) { uv = clamp(uv, 0.0, 1.0); return true; }
    if (uEdge < 1.5) { uv = fract(uv); return true; }
    if (uEdge < 2.5) { uv = abs(fract(uv * 0.5 + 0.5) * 2.0 - 1.0); return true; }
    return all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0)));
}

vec3 blend(vec3 fb, vec3 img) {
    if (uBlendMode < 0.5) return fb + img;                       // add
    if (uBlendMode < 1.5) return 1.0 - (1.0 - fb) * (1.0 - img);  // screen
    if (uBlendMode < 2.5) return max(fb, img);                    // max
    if (uBlendMode < 3.5) return mix(fb, img, clamp(luma(img), 0.0, 1.0)); // over, keyed on brightness
    return abs(fb - img);                                         // difference
}

vec3 hueRotate(vec3 c, float turns) {
    if (abs(turns) < 1e-5) return c;
    float a = turns * 2.0 * PI;
    float s = sin(a), co = cos(a);
    // luma-preserving rotation about the grey axis
    mat3 m = mat3(
        0.299 + 0.701 * co + 0.168 * s, 0.587 - 0.587 * co + 0.330 * s, 0.114 - 0.114 * co - 0.497 * s,
        0.299 - 0.299 * co - 0.328 * s, 0.587 + 0.413 * co + 0.035 * s, 0.114 - 0.114 * co + 0.292 * s,
        0.299 - 0.300 * co + 1.250 * s, 0.587 - 0.588 * co - 1.050 * s, 0.114 + 0.886 * co - 0.203 * s);
    return clamp(c * m, 0.0, 4.0);
}

void main() {
    vec3 img = texture(uColor, vUv).rgb;

    // ── where does this pixel read the feedback buffer from? ──
    float aspect = max(uResolution.x, 1.0) / max(uResolution.y, 1.0);
    vec2 p = vUv - 0.5;
    p.x *= aspect;

    // Inverse transform: to SHOW the feedback moved by +t / rotated by +angle /
    // scaled by uScale, we must READ it at the opposite transform.
    float ang = -uRotate * PI / 180.0;
    float ca = cos(ang), sa = sin(ang);
    p -= vec2(uTransX * aspect, uTransY);
    p = mat2(ca, -sa, sa, ca) * p;
    p /= max(uScale, 1e-4);

    p.x /= aspect;
    vec2 src = p + 0.5;

    // warp map: 0.5 neutral, >0.5 pushes the feedback in +uv, <0.5 in -uv
    vec2 warp = (texture(uWarp, vUv).rg - 0.5) * 2.0 * uWarpAmount;
    src -= warp;

    vec3 fb = vec3(0.0);
    if (wrapUv(src) && uFirst < 0.5) {
        fb = bilinear(uPrev, src, uResolution).rgb * uDecay;
        fb = hueRotate(fb, uHueShift);
    }

    vec3 col = blend(fb, img * uGain);

    // mask: white = this pixel is the incoming image outright, no history
    float m = luma(texture(uMask, vUv).rgb) * uMaskGain;
    if (uMaskInvert > 0.5) m = 1.0 - m;
    col = mix(col, img, clamp(m, 0.0, 1.0));

    fragColor = vec4(col, 1.0);
}
