#version 300 es
// Line Integral Convolution 2 — smears whatever is on the image input along a
// flow field by averaging it over a short streamline through every pixel.
//
// Three things kill the moiré the first LIC node suffered from:
//
//   1. BILINEAR fetches. Every texture in Forge is point-filtered, so a
//      streamline walking across the grid snapped to texel centres; the step
//      lattice then beat against the pixel lattice into those radial fringes.
//      Both the field and the signal are reconstructed bilinearly here.
//   2. RK2 (midpoint) integration instead of forward Euler, so a curving
//      streamline stays on the curve instead of drifting off it by a fixed
//      per-step error that is itself a function of direction.
//   3. A per-pixel JITTER of the sampling phase. Neighbouring pixels start
//      their walk at a random fraction of a step, so the taps of adjacent
//      streamlines interleave instead of landing on the same lattice. This is
//      the one that actually removes the fringes — turn it to 0 to see them.
//
// The convolved signal is the image itself by default (Signal = Image), which
// is the thing the old node could not do: it always convolved its own noise.
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uColor;   // the image being smeared
uniform sampler2D uField;   // optional vector field
uniform vec2  uResolution;

uniform float uFieldMode;
uniform float uFieldBlur;
uniform float uRotate;
uniform float uMagSpeed;
uniform float uSteps;
uniform float uStepSize;
uniform float uJitter;
uniform float uAlign;
uniform float uSignal;
uniform float uNoiseAmount;
uniform float uNoiseScale;
uniform float uSeed;
uniform float uSharpen;
uniform float uContrast;
uniform float uMix;
uniform float uEdge;

const int   MAX_STEPS = 48;
const float PI  = 3.14159265359;
const float TAU = 6.28318530718;
// width of the second, narrow kernel used for the detail term, as a fraction of
// the full one. Small enough to hold the streak's own texture, wide enough that
// it is still an average and not just the centre pixel.
const float NARROW = 0.34;
// Below this the field counts as absent. It has to clear the encoded neutral: an
// unconnected input reads solid 128, which decodes to 0.0055, not to zero — a
// tighter epsilon lets that round-off drive a diagonal smear across the frame.
const float DEAD = 0.01;

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

// Sub-texel reconstruction. The whole effect samples at continuous positions
// along a streamline, so this — not texture() — is the fetch it has to use.
vec3 bilinear(sampler2D tex, vec2 uv) {
    vec2 res   = vec2(textureSize(tex, 0));
    vec2 p     = uv * res - 0.5;
    vec2 f     = fract(p);
    vec2 base  = (floor(p) + 0.5) / res;
    vec2 texel = 1.0 / res;
    vec3 a = texture(tex, base).rgb;
    vec3 b = texture(tex, base + vec2(texel.x, 0.0)).rgb;
    vec3 c = texture(tex, base + vec2(0.0, texel.y)).rgb;
    vec3 d = texture(tex, base + texel).rgb;
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

vec2 fixUv(vec2 uv) {
    if (uEdge < 0.5) return clamp(uv, 0.0, 1.0);
    if (uEdge < 1.5) return fract(uv);
    return abs(fract(uv * 0.5 + 0.5) * 2.0 - 1.0);
}

// ── the field ───────────────────────────────────────────────────────────────
// Sobel on the image's luminance, from bilinear samples so the gradient stays
// continuous as the streamline slides between texels, and at a settable radius
// because a plain 1-texel difference follows grain and fine detail instead of
// the shapes. Sobel rather than a central difference for the same reason: the
// 2-1 column smooths across the direction being differenced.
vec2 lumaGradient(vec2 uv) {
    vec2 r = max(uFieldBlur, 0.5) / uResolution;
    float tl = luma(bilinear(uColor, fixUv(uv + vec2(-r.x,  r.y))));
    float tc = luma(bilinear(uColor, fixUv(uv + vec2( 0.0,  r.y))));
    float tr = luma(bilinear(uColor, fixUv(uv + vec2( r.x,  r.y))));
    float ml = luma(bilinear(uColor, fixUv(uv + vec2(-r.x,  0.0))));
    float mr = luma(bilinear(uColor, fixUv(uv + vec2( r.x,  0.0))));
    float bl = luma(bilinear(uColor, fixUv(uv + vec2(-r.x, -r.y))));
    float bc = luma(bilinear(uColor, fixUv(uv + vec2( 0.0, -r.y))));
    float br = luma(bilinear(uColor, fixUv(uv + vec2( r.x, -r.y))));
    float gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
    float gy = (tl + 2.0 * tc + tr) - (bl + 2.0 * bc + br);
    return vec2(gx, gy) * 0.5;   // ±1 per axis on a hard black/white edge
}

vec2 fieldAt(vec2 uv) {
    int m = int(uFieldMode + 0.5);
    vec2 v;
    if (m == 0) {                                  // along the image's contours
        vec2 g = lumaGradient(uv);
        v = vec2(-g.y, g.x);
    } else if (m == 1) {                           // straight up the gradient
        v = lumaGradient(uv);
    } else if (m == 2) {                           // RG encoded, 0.5 = zero
        v = bilinear(uField, uv).rg * 2.0 - 1.0;
    } else if (m == 3) {                           // RG raw (signed float buffers)
        v = bilinear(uField, uv).rg;
    } else {                                       // R as an angle
        float a = bilinear(uField, uv).r * TAU;
        v = vec2(cos(a), sin(a));
    }
    float c = cos(uRotate), s = sin(uRotate);
    return vec2(v.x * c - v.y * s, v.x * s + v.y * c);
}

// Which way this hop travels. A vector field has a sign, so forward runs with it
// and backward against it; a line field (Sobel directions, structure tensors,
// anything ± ambiguous) does not, so Align instead keeps each hop on the same
// side as the previous one and the streamline stops folding back on itself.
vec2 travelDir(vec2 f, vec2 prev, float sgn) {
    float m = length(f);
    if (m < DEAD) return prev;                     // dead spot: coast, don't stall
    vec2 d = f / m;
    if (uAlign > 0.5) return (dot(d, prev) < 0.0) ? -d : d;
    return d * sgn;
}

// ── the signal being convolved ──────────────────────────────────────────────
float hash21(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
}

// Value noise rather than a per-pixel hash: band-limited, and it reads at
// continuous positions, so it does not re-introduce a lattice of its own.
float valueNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float noiseAt(vec2 uv) {
    return valueNoise(uv * uResolution / max(uNoiseScale, 0.25) + uSeed * 137.0);
}

vec3 signalAt(vec2 uv) {
    int m = int(uSignal + 0.5);
    if (m == 1) return vec3(noiseAt(uv));
    vec3 img = bilinear(uColor, uv);
    if (m == 0) return img;
    return img * mix(1.0, noiseAt(uv) * 2.0, uNoiseAmount);   // noise grain, image colour
}

// ── the convolution ─────────────────────────────────────────────────────────
// Walks one half of the streamline, accumulating the signal under two Hann
// kernels at once: the full length, and a narrow one for the detail term.
void trace(
        vec2 f0,                       // the field at vUv, which main already has
        float sgn,
        float phase,
        inout vec3 accWide, inout float wWide,
        inout vec3 accNarrow, inout float wNarrow
) {
    int   steps = int(clamp(uSteps, 1.0, float(MAX_STEPS)) + 0.5);
    float total = float(steps) * uStepSize;
    vec2  texel = 1.0 / uResolution;

    vec2  dir = normalize(f0) * sgn;
    vec2  p   = vUv;
    float arc = 0.0;

    for (int i = 0; i < MAX_STEPS; i++) {
        if (i >= steps) break;

        // the first hop is the short one that carries this pixel's phase; every
        // hop after it is a full step, so the taps stay evenly spaced
        float h = uStepSize * ((i == 0) ? phase : 1.0);

        // RK2: sample the field at the hop's midpoint, step with that
        vec2  f1 = (i == 0) ? f0 : fieldAt(p);   // i == 0 is still standing on vUv
        vec2  d1 = travelDir(f1, dir, sgn);
        float s1 = mix(1.0, clamp(length(f1), 0.0, 1.0), uMagSpeed);
        vec2  mid = fixUv(p + d1 * (h * s1 * 0.5) * texel);

        vec2  f2 = fieldAt(mid);
        vec2  d2 = travelDir(f2, d1, sgn);
        float s2 = mix(1.0, clamp(length(f2), 0.0, 1.0), uMagSpeed);

        p   = fixUv(p + d2 * (h * s2) * texel);
        dir = d2;
        arc += h;

        vec3 sig = signalAt(p);

        float t  = clamp(arc / max(total, 1e-5), 0.0, 1.0);
        float ww = 0.5 + 0.5 * cos(PI * t);
        accWide += sig * ww;
        wWide   += ww;

        float tn = arc / max(total * NARROW, 1e-5);
        if (tn < 1.0) {
            float wn = 0.5 + 0.5 * cos(PI * tn);
            accNarrow += sig * wn;
            wNarrow   += wn;
        }
    }
}

void main() {
    vec3 src = bilinear(uColor, vUv);

    // Nowhere to walk — an unconnected field, or a flat patch of an image the
    // gradient modes read as featureless. Pass the pixel through rather than
    // picking an arbitrary direction and smearing it sideways.
    vec2 f0 = fieldAt(vUv);
    if (length(f0) < DEAD) {
        fragColor = vec4(clamp(src, 0.0, 1.0), 1.0);
        return;
    }

    // per-pixel sampling phase: forward starts a fraction of a step in, backward
    // takes the complement, so the two halves together are one evenly spaced set
    // of taps whose offset is random from pixel to pixel
    float rnd   = hash21(floor(vUv * uResolution) + uSeed * 7.0);
    float phase = clamp(mix(0.5, rnd, clamp(uJitter, 0.0, 1.0)), 0.02, 0.98);

    vec3  accWide = vec3(0.0), accNarrow = vec3(0.0);
    float wWide = 0.0, wNarrow = 0.0;

    trace(f0,  1.0, phase,       accWide, wWide, accNarrow, wNarrow);
    trace(f0, -1.0, 1.0 - phase, accWide, wWide, accNarrow, wNarrow);

    vec3 wide   = accWide / max(wWide, 1e-5);
    vec3 narrow = (wNarrow > 1e-5) ? accNarrow / wNarrow : wide;

    // unsharp along the flow: adding back what the long kernel averaged away
    // gives the streaks their relief without touching them across the flow
    vec3 c = wide + (narrow - wide) * uSharpen;

    c = (c - 0.5) * uContrast + 0.5;
    c = mix(src, c, clamp(uMix, 0.0, 1.0));

    fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
