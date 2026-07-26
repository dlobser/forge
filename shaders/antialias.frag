#version 300 es
// Anti-alias — the smoothing pass to put at the END of a chain.
//
// Every texture in Forge is point-sampled so that a long chain of effects stays
// crisp instead of picking up a little bilinear softness at every hop. The cost is
// hard, stair-stepped edges wherever a shader generated geometry (SDFs, raymarch,
// kaleidoscope seams, high-contrast keys). This node cleans those up without
// touching anything that isn't an edge.
//
//   FXAA      finds the edge direction from local luma and blurs ALONG it, so
//             gradients and texture detail survive while the jaggies go. This is
//             the one you want almost always.
//   Box       plain 3×3 average — a blunt softening pass, occasionally handy.
//   Sharpen   the opposite: unsharp mask, for when a chain came out mushy.
//
// Threshold sets how much local contrast counts as an edge (lower = more pixels
// treated as edges), Amount cross-fades the whole result back against the input.
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uColor;
uniform vec2  uResolution;

uniform float uMode;        // 0 fxaa · 1 box · 2 sharpen
uniform float uThreshold;   // minimum local contrast to treat as an edge
uniform float uAmount;      // 0 = passthrough, 1 = full effect
uniform float uSharpen;     // sharpen strength (mode 2)

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

// Manual bilinear: the input is point-filtered, and FXAA's whole trick is reading
// *between* pixels, so the interpolation has to happen here.
vec3 bil(vec2 uv) {
    vec2 p = uv * uResolution - 0.5;
    vec2 f = fract(p);
    vec2 base = (floor(p) + 0.5) / uResolution;
    vec2 t = 1.0 / uResolution;
    vec3 a = texture(uColor, base).rgb;
    vec3 b = texture(uColor, base + vec2(t.x, 0.0)).rgb;
    vec3 c = texture(uColor, base + vec2(0.0, t.y)).rgb;
    vec3 d = texture(uColor, base + t).rgb;
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

vec3 box3(vec2 uv) {
    vec2 t = 1.0 / uResolution;
    vec3 s = vec3(0.0);
    for (int y = -1; y <= 1; y++)
        for (int x = -1; x <= 1; x++)
            s += texture(uColor, uv + vec2(float(x), float(y)) * t).rgb;
    return s / 9.0;
}

// FXAA, console/"light" formulation: 4 corner taps decide the edge direction, then
// two bilinear taps across it get averaged. Cheap, and it does not need mip levels.
vec3 fxaa(vec2 uv) {
    vec2 t = 1.0 / uResolution;
    vec3 rgbM  = texture(uColor, uv).rgb;
    vec3 rgbNW = texture(uColor, uv + vec2(-t.x, -t.y)).rgb;
    vec3 rgbNE = texture(uColor, uv + vec2( t.x, -t.y)).rgb;
    vec3 rgbSW = texture(uColor, uv + vec2(-t.x,  t.y)).rgb;
    vec3 rgbSE = texture(uColor, uv + vec2( t.x,  t.y)).rgb;

    float lM  = luma(rgbM),  lNW = luma(rgbNW), lNE = luma(rgbNE);
    float lSW = luma(rgbSW), lSE = luma(rgbSE);
    float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
    float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));

    // flat enough? leave it exactly as it was
    if (lMax - lMin < max(uThreshold, lMax * uThreshold)) return rgbM;

    vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
    float dirReduce = max((lNW + lNE + lSW + lSE) * 0.25 * (1.0 / 8.0), 1.0 / 128.0);
    float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
    dir = clamp(dir * rcpDirMin, vec2(-8.0), vec2(8.0)) * t;

    vec3 rgbA = 0.5 * (bil(uv + dir * (1.0 / 3.0 - 0.5)) + bil(uv + dir * (2.0 / 3.0 - 0.5)));
    vec3 rgbB = rgbA * 0.5 + 0.25 * (bil(uv + dir * -0.5) + bil(uv + dir * 0.5));

    // reject the wider filter when it strayed outside the local luma range
    float lB = luma(rgbB);
    return (lB < lMin || lB > lMax) ? rgbA : rgbB;
}

void main() {
    vec3 src = texture(uColor, vUv).rgb;
    vec3 out3;
    if (uMode < 0.5)      out3 = fxaa(vUv);
    else if (uMode < 1.5) out3 = box3(vUv);
    else                  out3 = src + (src - box3(vUv)) * uSharpen;
    fragColor = vec4(mix(src, out3, clamp(uAmount, 0.0, 1.0)), 1.0);
}
