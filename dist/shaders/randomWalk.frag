#version 300 es
// Random Walk — every pixel wanders. Each frame a pixel reads its colour from a
// randomly chosen nearby position, so over time the image dissolves the way ink
// does in water. How far any given pixel is allowed to wander is set per-pixel by
// the MASK: black = perfectly still, white = full step. Point a gradient or a
// painted shape at the mask and only part of the picture melts.
//
// Two modes, chosen by uAnimate:
//   ANIMATED (default) accumulates the walk in the history buffer, one step per
//   frame — a true random walk, unbounded, and it keeps evolving as long as the
//   transport is playing. uReinject bleeds the source image back in so the walk
//   drifts around a recognisable picture instead of eventually going uniform.
//   STATIC does the whole walk in one pass: uSteps hops taken from the input image
//   in a single frame, with no history at all. Same look, frozen, and it re-renders
//   only when a control changes — which is what you want if you are stepping a
//   sequence out to disk.
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uColor;   // source image
uniform sampler2D uMask;    // per-pixel randomness amount
uniform sampler2D uPrev;    // previous output (engine-provided)
uniform vec2  uResolution;
uniform float uTime;
uniform float uFrame;
uniform float uFirst;

uniform float uStep;        // step length, in fractions of the frame
uniform float uSteps;       // STATIC mode: how many hops to take in one pass
uniform float uAnimate;     // 1 = accumulate in history, 0 = one-pass static walk
uniform float uReinject;    // ANIMATED: how much source image bleeds back each frame
uniform float uSeed;        // shuffles the random field
uniform float uBias;        // 0 = free walk, 1 = drift straight down the mask gradient
uniform float uMaskGain;
uniform float uEdge;        // 0 clamp · 1 wrap · 2 mirror

const float TAU = 6.28318530718;
const int MAX_STEPS = 64;

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

// 2D → 1D hash. Cheap, and decorrelated enough that neighbouring pixels pick
// genuinely different directions rather than marching in formation.
float hash(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
}

vec2 randomStep(vec2 uv, float n) {
    float a = hash(vec3(uv * 311.7, n + uSeed * 17.0)) * TAU;
    float r = 0.35 + 0.65 * hash(vec3(uv * 127.1 + 5.0, n + uSeed * 31.0));
    return vec2(cos(a), sin(a)) * r;
}

float maskAt(vec2 uv) {
    return clamp(luma(texture(uMask, uv).rgb) * uMaskGain, 0.0, 1.0);
}

vec2 fixUv(vec2 uv) {
    if (uEdge < 0.5) return clamp(uv, 0.0, 1.0);
    if (uEdge < 1.5) return fract(uv);
    return abs(fract(uv * 0.5 + 0.5) * 2.0 - 1.0);
}

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

// downhill direction of the mask, for the biased (non-isotropic) walk
vec2 maskGradient(vec2 uv) {
    vec2 t = 1.0 / uResolution;
    float gx = maskAt(uv + vec2(t.x, 0.0)) - maskAt(uv - vec2(t.x, 0.0));
    float gy = maskAt(uv + vec2(0.0, t.y)) - maskAt(uv - vec2(0.0, t.y));
    vec2 g = vec2(gx, gy);
    return length(g) > 1e-5 ? normalize(g) : vec2(0.0);
}

void main() {
    float m = maskAt(vUv);
    vec2 texel = 1.0 / uResolution;

    if (uAnimate < 0.5) {
        // ── static: take the whole walk in one pass, straight from the source ──
        int steps = int(clamp(uSteps, 1.0, float(MAX_STEPS)) + 0.5);
        vec2 p = vUv;
        for (int i = 0; i < MAX_STEPS; i++) {
            if (i >= steps) break;
            vec2 d = randomStep(vUv, float(i) + 1.0);
            d = mix(d, maskGradient(p), uBias);
            p = fixUv(p + d * uStep * m);
        }
        fragColor = vec4(bilinear(uColor, p, uResolution).rgb, 1.0);
        return;
    }

    // ── animated: one hop per frame, accumulated in the history buffer ──
    vec3 src = texture(uColor, vUv).rgb;
    if (uFirst > 0.5) { fragColor = vec4(src, 1.0); return; }

    vec2 d = randomStep(vUv, uFrame + 1.0);
    d = mix(d, maskGradient(vUv), uBias);
    vec2 p = fixUv(vUv + d * uStep * m);
    vec3 prev = bilinear(uPrev, p, uResolution).rgb;
    fragColor = vec4(mix(prev, src, clamp(uReinject, 0.0, 1.0)), 1.0);
}
