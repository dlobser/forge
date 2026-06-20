#version 300 es
// Erosion — distance-field dilation of a B&W mask (in the COLOR slot). For each
// pixel we march outward along 16 directions looking for the nearest "white"
// seed; the closer the seed, the brighter the result, so the white regions bleed
// outward and fade to black at uSpread. uBands turns the smooth falloff into
// discrete darkening rings. uInvert treats the dark pixels as the seeds instead.
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uColor;     // the B&W image
uniform vec2  uResolution;
uniform float uThreshold;     // luma above this counts as a seed
uniform float uSpread;        // max search radius in uv
uniform float uSteps;         // radial samples per direction (quality)
uniform float uFalloff;       // gamma on the distance falloff
uniform float uBands;         // 0 = smooth, >=2 = quantised rings
uniform float uInvert;        // 1 = grow the black pixels instead
uniform vec3  uTint;          // colour applied to the result

const int DIRS = 16;
const int MAX_STEPS = 64;

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

// Seed mask at uv: 1.0 where the image is a seed, else 0.0 (respects Invert).
float seed(vec2 uv) {
    float v = luma(texture(uColor, uv).rgb);
    if (uInvert > 0.5) v = 1.0 - v;
    return step(uThreshold, v);
}

void main() {
    int steps = int(uSteps + 0.5);

    float dist = uSpread;                 // assume "no seed reached" until found
    if (seed(vUv) > 0.5) {
        dist = 0.0;                       // we are a seed
    } else {
        for (int d = 0; d < DIRS; d++) {
            float a = (float(d) / float(DIRS)) * 6.2831853;
            vec2 dir = vec2(cos(a), sin(a));
            for (int s = 1; s <= MAX_STEPS; s++) {
                if (s > steps) break;
                float r = (float(s) / float(steps)) * uSpread;
                if (r >= dist) break;     // already have something closer
                if (seed(vUv + dir * r) > 0.5) { dist = r; break; }
            }
        }
    }

    float b = clamp(1.0 - dist / max(uSpread, 1e-4), 0.0, 1.0);
    b = pow(b, uFalloff);

    if (uBands >= 1.0) {                   // discrete darkening rings
        b = clamp(floor(b * uBands) / max(uBands - 1.0, 1.0), 0.0, 1.0);
    }

    fragColor = vec4(uTint * b, 1.0);
}
