#version 300 es
// Kuramoto oscillator field — a grid of phase oscillators that locally couple to
// their 8 neighbours with a Sakaguchi phase lag (alpha). Runs as a GPU ping-pong
// simulation through three passes selected by uPass:
//     2 = seed the phase field   1 = display it   0 = advance one step
// Two image inputs drive the dynamics by pixel brightness:
//     Image A (uColor) -> natural frequency,  Image B (uDepth) -> local coupling.
// Adapted from David's p5 sketch "Splendid jeans".
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uColor;   // Image A — natural-frequency map
uniform sampler2D uDepth;   // Image B — coupling map
uniform sampler2D uState;   // phase field, R = theta in [0, 2pi)
uniform vec2  uResolution;  // current pass viewport (unused but provided by engine)
uniform vec2  uSimRes;      // simulation grid size
uniform float uPass;        // 0 step · 1 display · 2 seed
uniform float uTime;

uniform float uK;           // coupling strength
uniform float uAlpha;       // phase lag
uniform float uDt;          // time step
uniform float uNoise;       // natural-frequency spread (random per cell)
uniform float uFreqA;       // Image A brightness -> frequency amount
uniform float uCoupB;       // Image B brightness -> coupling amount (0 uniform .. 1 full)
uniform float uSeedA;       // 1 = seed phase from Image A brightness, else random
uniform float uDisplayMode; // 0 hue · 1 wave · 2 sync

const float TAU = 6.28318530718;

float hash(vec2 p) { p = fract(p * vec2(127.1, 311.7)); p += dot(p, p + 34.56); return fract(p.x * p.y); }
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}
int wrap(int a, int n) { return (a % n + n) % n; }
float phaseAt(ivec2 c, ivec2 sz) { return texelFetch(uState, ivec2(wrap(c.x, sz.x), wrap(c.y, sz.y)), 0).r; }

void main() {
    ivec2 sz = ivec2(uSimRes);

    // ---- SEED ----
    if (uPass > 1.5) {
        ivec2 ic = ivec2(gl_FragCoord.xy);
        vec2 uv = (vec2(ic) + 0.5) / uSimRes;
        float a = luma(texture(uColor, uv).rgb);
        float phase = (uSeedA > 0.5 && a > 0.004) ? a * TAU : hash(vec2(ic)) * TAU;
        fragColor = vec4(phase, 0.0, 0.0, 1.0);
        return;
    }

    // ---- STEP ----
    if (uPass < 0.5) {
        ivec2 ic = ivec2(gl_FragCoord.xy);
        vec2 uv = (vec2(ic) + 0.5) / uSimRes;
        float theta = phaseAt(ic, sz);
        float a = luma(texture(uColor, uv).rgb);
        float b = luma(texture(uDepth, uv).rgb);
        float sum = 0.0;
        for (int dx = -1; dx <= 1; dx++)
            for (int dy = -1; dy <= 1; dy++) {
                if (dx == 0 && dy == 0) continue;
                sum += sin(phaseAt(ic + ivec2(dx, dy), sz) - theta - uAlpha);
            }
        float omega = uNoise * (hash(vec2(ic)) * 2.0 - 1.0) + uFreqA * (a - 0.5) * 2.0;
        float K = uK * mix(1.0, b, uCoupB);
        float dTheta = omega + (K / 8.0) * sum;
        float nv = mod(theta + dTheta * uDt, TAU);
        fragColor = vec4(nv < 0.0 ? nv + TAU : nv, 0.0, 0.0, 1.0);
        return;
    }

    // ---- DISPLAY: smooth the phase by interpolating unit vectors (no 2pi seams) ----
    vec2 fc = vUv * uSimRes - 0.5;
    ivec2 i0 = ivec2(floor(fc));
    vec2 f = fract(fc);
    float t00 = phaseAt(i0 + ivec2(0, 0), sz), t10 = phaseAt(i0 + ivec2(1, 0), sz);
    float t01 = phaseAt(i0 + ivec2(0, 1), sz), t11 = phaseAt(i0 + ivec2(1, 1), sz);
    vec2 vv = mix(mix(vec2(cos(t00), sin(t00)), vec2(cos(t10), sin(t10)), f.x),
                  mix(vec2(cos(t01), sin(t01)), vec2(cos(t11), sin(t11)), f.x), f.y);
    float theta = atan(vv.y, vv.x);
    float hue = theta / TAU; hue = hue - floor(hue);
    float sync = clamp(length(vv), 0.0, 1.0);

    vec3 col;
    if (uDisplayMode < 0.5)       col = hsv2rgb(vec3(hue, 1.0, 1.0));
    else if (uDisplayMode < 1.5)  col = vec3(0.5 + 0.5 * cos(theta));
    else                          col = hsv2rgb(vec3(hue, 1.0, sync));
    fragColor = vec4(col, 1.0);
}
