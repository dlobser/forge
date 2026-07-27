#version 300 es
// Cellular Automata — four self-organising pattern engines on one ping-pong grid.
// Runs as a GPU simulation through three passes selected by uPass:
//     2 = seed the grid   1 = display it   0 = advance one step
// Image A (uColor) steers the *rules* (not just the speed), so different parts of
// the picture settle into different pattern regimes. Image B (uDepth) is a mask
// that can freeze the sim where it is dark.
//
//   0 SmoothLife  — continuous Conway. Inner disc says "am I alive", outer annulus
//                   says "how crowded". Gliders, amoebas, dividing blobs.
//   1 Multi-Scale Turing — McCabe's algorithm. A cascade of blurs at growing
//                   scales; each pixel steps toward whichever scale is quietest,
//                   so structure nests inside structure (spots inside mazes).
//   2 Gray-Scott  — reaction-diffusion. Image A paints a map of feed/kill rates,
//                   so one frame holds coral, mitosis, worms and spots at once.
//   3 Contour Flow— semi-Lagrangian advection along the image's contour lines
//                   plus anti-diffusion, which pulls the smear back into filaments.
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uColor;      // Image A — drives the rules
uniform sampler2D uDepth;      // Image B — mask / rate multiplier
uniform sampler2D uState;      // sim state, channel use depends on mode
uniform vec2  uResolution;
uniform vec2  uSimRes;         // sim grid size
uniform float uPass;           // 0 step · 1 display · 2 seed
uniform float uTime;

// ── controls ────────────────────────────────────────────────────────────────
uniform float uMode;           // 0 SmoothLife · 1 Turing · 2 Gray-Scott · 3 Flow
uniform float uRadius;         // neighbourhood radius / base pattern scale
uniform float uDt;             // time step (rescaled per mode)
uniform float uSharp;          // rule sharpness — soft blobs vs crisp cells
uniform float uImageDrive;     // Image A -> rule bias
uniform float uContrastDrive;  // Image A edge energy -> local activity
uniform float uMaskB;          // Image B -> freeze mask
uniform float uSpark;          // random agitation (keeps a dead field alive)
uniform float uDecay;          // slow bleed toward empty

uniform float uBirthMin;       // SmoothLife b1
uniform float uBirthMax;       // SmoothLife b2
uniform float uSurvMin;        // SmoothLife d1
uniform float uSurvMax;        // SmoothLife d2

uniform float uFeedRate;       // Gray-Scott F
uniform float uKillRate;       // Gray-Scott k

uniform float uFlow;           // Flow: advection along image contours
uniform float uCurl;           // Flow: self-generated swirl
uniform float uAntiDiff;       // Flow: filament sharpening

uniform float uSeedMode;       // 0 luma · 1 edges+noise · 2 noise · 3 blobs
uniform float uDisplayMode;    // 0 tint · 1 mono · 2 relief · 3 neon · 4 overlay · 5 contours
uniform float uSharpness;      // display contrast curve
uniform float uMix;            // blend with Image A

const int   MAXR = 12;
const float PI   = 3.14159265;

// ── small helpers ───────────────────────────────────────────────────────────
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
float hash21(vec2 p) { p = fract(p * vec2(127.1, 311.7)); p += dot(p, p + 34.56); return fract(p.x * p.y); }

float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i), b = hash21(i + vec2(1, 0));
    float c = hash21(i + vec2(0, 1)), d = hash21(i + vec2(1, 1));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

ivec2 wrapC(ivec2 c, ivec2 sz) { return (c % sz + sz) % sz; }
vec4  S(ivec2 c, ivec2 sz)     { return texelFetch(uState, wrapC(c, sz), 0); }

// bilinear state fetch at fractional grid coordinates (the state texture is
// NEAREST, so both advection and the display upscale have to filter by hand)
vec4 Sbi(vec2 p, ivec2 sz) {
    vec2 g = p - 0.5;
    ivec2 i0 = ivec2(floor(g));
    vec2 f = g - floor(g);
    vec4 a = mix(S(i0, sz),               S(i0 + ivec2(1, 0), sz), f.x);
    vec4 b = mix(S(i0 + ivec2(0, 1), sz), S(i0 + ivec2(1, 1), sz), f.x);
    return mix(a, b, f.y);
}

// 3x3 gaussian, variance 0.5 per axis — one diffusion step for every channel
vec4 blur9(ivec2 c, ivec2 sz) {
    vec4 s = S(c, sz) * 4.0;
    s += (S(c + ivec2(1, 0), sz) + S(c + ivec2(-1, 0), sz)
        + S(c + ivec2(0, 1), sz) + S(c + ivec2(0, -1), sz)) * 2.0;
    s +=  S(c + ivec2(1, 1), sz) + S(c + ivec2(1, -1), sz)
        + S(c + ivec2(-1, 1), sz) + S(c + ivec2(-1, -1), sz);
    return s / 16.0;
}

// 9-point laplacian (neighbour weights sum to 1, centre -1)
vec4 lap9(ivec2 c, ivec2 sz) {
    vec4 s = -S(c, sz);
    s += 0.20 * (S(c + ivec2(1, 0), sz) + S(c + ivec2(-1, 0), sz)
               + S(c + ivec2(0, 1), sz) + S(c + ivec2(0, -1), sz));
    s += 0.05 * (S(c + ivec2(1, 1), sz) + S(c + ivec2(1, -1), sz)
               + S(c + ivec2(-1, 1), sz) + S(c + ivec2(-1, -1), sz));
    return s;
}

// Image A probe: centre luma, Sobel gradient, edge magnitude
vec4 imgProbe(vec2 uv, vec2 px) {
    float l00 = luma(texture(uColor, uv + vec2(-px.x, -px.y)).rgb);
    float l10 = luma(texture(uColor, uv + vec2( 0.0,  -px.y)).rgb);
    float l20 = luma(texture(uColor, uv + vec2( px.x, -px.y)).rgb);
    float l01 = luma(texture(uColor, uv + vec2(-px.x,   0.0)).rgb);
    float l11 = luma(texture(uColor, uv).rgb);
    float l21 = luma(texture(uColor, uv + vec2( px.x,   0.0)).rgb);
    float l02 = luma(texture(uColor, uv + vec2(-px.x,  px.y)).rgb);
    float l12 = luma(texture(uColor, uv + vec2( 0.0,   px.y)).rgb);
    float l22 = luma(texture(uColor, uv + vec2( px.x,  px.y)).rgb);
    float gx = (l20 + 2.0 * l21 + l22) - (l00 + 2.0 * l01 + l02);
    float gy = (l02 + 2.0 * l12 + l22) - (l00 + 2.0 * l10 + l20);
    return vec4(l11, gx * 0.25, gy * 0.25, length(vec2(gx, gy)) * 0.25);
}

// logistic step and interval used by SmoothLife
float sig(float x, float a, float w) { return 1.0 / (1.0 + exp(-(x - a) * 4.0 / max(w, 1e-4))); }
float sigIn(float x, float lo, float hi, float w) { return sig(x, lo, w) * (1.0 - sig(x, hi, w)); }

// ── palettes ────────────────────────────────────────────────────────────────
vec3 palNeon(float t) {
    t = clamp(t, 0.0, 1.0);
    vec3 a = vec3(0.03, 0.01, 0.10);
    vec3 b = vec3(0.65, 0.10, 0.55);
    vec3 c = vec3(0.10, 0.85, 0.95);
    vec3 d = vec3(1.00, 0.95, 0.80);
    vec3 col = mix(a, b, smoothstep(0.0, 0.45, t));
    col = mix(col, c, smoothstep(0.4, 0.8, t));
    col = mix(col, d, smoothstep(0.82, 1.0, t));
    return col;
}

float seedValue(ivec2 ic, vec2 uv, vec4 img) {
    float rnd = hash21(vec2(ic) + vec2(uTime * 13.1 + 1.7, uTime * 7.3 + 4.2));
    if (uSeedMode < 0.5)      return img.x;
    else if (uSeedMode < 1.5) return step(0.15, img.w) * rnd + img.x * 0.25;
    else if (uSeedMode < 2.5) return step(0.6, rnd);
    // low-frequency blobs — the friendliest start for SmoothLife
    return smoothstep(0.45, 0.62, vnoise(uv * 9.0 + vec2(uTime * 3.0, 0.0)));
}

void main() {
    ivec2 sz = ivec2(uSimRes);
    vec2 px = 1.0 / uSimRes;

    // ═══════════════════════════════════════════════════════════════════════
    // PASS 2 — SEED
    // ═══════════════════════════════════════════════════════════════════════
    if (uPass > 1.5) {
        ivec2 ic = ivec2(gl_FragCoord.xy);
        vec2 uv = (vec2(ic) + 0.5) / uSimRes;
        vec4 img = imgProbe(uv, px);
        float v = clamp(seedValue(ic, uv, img), 0.0, 1.0);

        if (uMode < 0.5) {                       // SmoothLife
            fragColor = vec4(v, 0.0, 0.0, 1.0);
        } else if (uMode < 1.5) {                // Turing — signed field + cascade
            float f = v * 2.0 - 1.0;
            fragColor = vec4(f, f, f, f);
        } else if (uMode < 2.5) {                // Gray-Scott — U full, V in patches
            float vv = smoothstep(0.5, 0.75, v) * 0.5;
            fragColor = vec4(1.0 - vv, vv, 0.0, 1.0);
        } else {                                 // Flow
            fragColor = vec4(v, 0.0, 0.0, 1.0);
        }
        return;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PASS 0 — STEP
    // ═══════════════════════════════════════════════════════════════════════
    if (uPass < 0.5) {
        ivec2 ic = ivec2(gl_FragCoord.xy);
        vec2 uv = (vec2(ic) + 0.5) / uSimRes;
        vec4 st  = S(ic, sz);
        vec4 img = imgProbe(uv, px);

        // Local activity: edges speed the sim up, Image B can freeze it.
        float maskB = mix(1.0, luma(texture(uDepth, uv).rgb), uMaskB);
        float rate  = maskB * (1.0 + uContrastDrive * img.w * 2.0);
        float rnd   = hash21(vec2(ic) + fract(uTime * 0.37) * vec2(311.7, 127.1));

        vec4 outState = st;

        // ── MODE 0 — SmoothLife ────────────────────────────────────────────
        if (uMode < 0.5) {
            float f  = clamp(st.r, 0.0, 1.0);
            float ra = clamp(uRadius, 3.0, float(MAXR));
            float ri = ra / 3.0;
            int   rmax = int(ceil(ra + 0.5));

            // Antialiased inner disc + outer annulus. The 1px feathering is what
            // keeps creatures gliding smoothly instead of crawling on the lattice.
            float sIn = 0.0, wIn = 0.0, sOut = 0.0, wOut = 0.0;
            for (int dy = -MAXR; dy <= MAXR; dy++) {
                if (dy < -rmax || dy > rmax) continue;
                for (int dx = -MAXR; dx <= MAXR; dx++) {
                    if (dx < -rmax || dx > rmax) continue;
                    float d  = length(vec2(float(dx), float(dy)));
                    float wi = clamp(ri + 0.5 - d, 0.0, 1.0);
                    float wo = clamp(ra + 0.5 - d, 0.0, 1.0) - wi;
                    if (wi + wo <= 0.0) continue;
                    float v = clamp(S(ic + ivec2(dx, dy), sz).r, 0.0, 1.0);
                    sIn  += v * wi; wIn  += wi;
                    sOut += v * wo; wOut += wo;
                }
            }
            float m = sIn  / max(wIn,  1e-5);   // inner disc fill  -> alive?
            float n = sOut / max(wOut, 1e-5);   // outer ring fill  -> crowded?

            // Image A shifts the whole rule window. Bright areas want denser
            // neighbourhoods, so texture in the picture becomes texture in the CA.
            float bias = uImageDrive * img.x * 0.18;
            float aM = 0.147;
            float aN = mix(0.09, 0.012, clamp(uSharp, 0.0, 1.0));
            float alive = sig(m, 0.5, aM);
            float lo = mix(uBirthMin, uSurvMin, alive) + bias;
            float hi = mix(uBirthMax, uSurvMax, alive) + bias;
            float s  = sigIn(n, lo, hi, aN);

            f += (2.0 * s - 1.0) * uDt * rate;
            f += (rnd - 0.5) * uSpark * 0.25 * uDt;
            f -= uDecay * 0.1 * uDt;
            outState = vec4(clamp(f, 0.0, 1.0), m, n, 1.0);

        // ── MODE 1 — Multi-Scale Turing (McCabe) ───────────────────────────
        } else if (uMode < 1.5) {
            float f = clamp(st.r, -1.0, 1.0);
            vec4  b = blur9(ic, sz);

            // Three blur levels held in g/b/a. Each relaxes toward the level
            // below while diffusing, so its steady state is a gaussian of
            // length L: solve 0.5/lambda = L^2 for each incremental scale.
            float L1 = max(1.0, uRadius * 0.45);
            float L2 = L1 * 2.2;
            float L3 = L2 * 2.2;
            float lam1 = clamp(0.5 / (L1 * L1), 0.0, 1.0);
            float lam2 = clamp(0.5 / max(L2 * L2 - L1 * L1, 1.0), 0.0, 1.0);
            float lam3 = clamp(0.5 / max(L3 * L3 - L2 * L2, 1.0), 0.0, 1.0);
            float g1 = mix(b.g, f,   lam1);
            float g2 = mix(b.b, b.g, lam2);
            float g3 = mix(b.a, b.b, lam3);

            // Step toward whichever scale currently varies least — that is the
            // scale still "undecided" here, and committing it grows structure
            // nested inside the structure the coarser scales already made.
            float d1 = f  - g1;
            float d2 = g1 - g2;
            float d3 = g2 - g3;
            float a1 = abs(d1), a2 = abs(d2), a3 = abs(d3);
            float dsel, amt;
            if (a1 <= a2 && a1 <= a3)  { dsel = d1; amt = 0.020; }
            else if (a2 <= a3)         { dsel = d2; amt = 0.045; }
            else                       { dsel = d3; amt = 0.090; }

            float bias = uImageDrive * (img.x - 0.35) * 0.30;
            float dir  = clamp((dsel + bias) * mix(6.0, 60.0, clamp(uSharp, 0.0, 1.0)), -1.0, 1.0);

            f += dir * amt * uDt * 8.0 * rate;
            f += (rnd - 0.5) * uSpark * 0.15;
            f -= f * uDecay * 0.05;
            outState = vec4(clamp(f, -1.0, 1.0), g1, g2, g3);

        // ── MODE 2 — Gray-Scott reaction-diffusion ─────────────────────────
        } else if (uMode < 2.5) {
            float u = clamp(st.r, 0.0, 1.0);
            float v = clamp(st.g, 0.0, 1.0);
            vec4  L = lap9(ic, sz);

            // The picture paints a map of rate constants: brightness moves F,
            // edge energy moves k, so each region lands in a different regime
            // of the Gray-Scott zoo instead of all doing the same thing.
            float F = clamp(uFeedRate + uImageDrive * img.x * 0.030, 0.004, 0.11);
            float k = clamp(uKillRate + uImageDrive * img.w * 0.020
                                      + uContrastDrive * img.w * 0.004, 0.028, 0.075);

            float dt  = clamp(uDt * 6.0, 0.0, 1.0) * maskB;
            float uvv = u * v * v;
            float du = 1.0 * L.r - uvv + F * (1.0 - u);
            float dv = 0.5 * L.g + uvv - (F + k) * v;
            u = clamp(u + du * dt, 0.0, 1.0);
            v = clamp(v + dv * dt, 0.0, 1.0);

            // sparse re-seeding so the field can never flatline
            if (rnd > 1.0 - uSpark * 0.004) v = min(1.0, v + 0.5);
            outState = vec4(u, v, 0.0, 1.0);

        // ── MODE 3 — Contour Flow ──────────────────────────────────────────
        } else {
            float f = clamp(st.r, 0.0, 1.0);

            // Velocity = along the image's contour lines (perpendicular to its
            // gradient) plus the curl of the field itself, which is what makes
            // the smear roll up into vortices instead of just sliding.
            vec2 gI = img.yz;
            vec2 tang = vec2(-gI.y, gI.x);
            float sr = S(ic + ivec2(1, 0), sz).r, sl = S(ic + ivec2(-1, 0), sz).r;
            float su = S(ic + ivec2(0, 1), sz).r, sd = S(ic + ivec2(0, -1), sz).r;
            vec2 gS = vec2(sr - sl, su - sd) * 0.5;
            vec2 vel = tang * uFlow * 6.0 + vec2(-gS.y, gS.x) * uCurl * 10.0;

            vec2 p = vec2(ic) + 0.5 - vel * uDt * 4.0 * maskB;
            float adv = clamp(Sbi(p, sz).r, 0.0, 1.0);

            // Anti-diffusion: subtract the blur back out. Advection alone turns
            // everything to mush; this pulls it back into filaments.
            float bl = blur9(ic, sz).r;
            float sharpen = adv + uAntiDiff * (adv - bl) * 2.0;
            sharpen = mix(sharpen, smoothstep(0.35, 0.65, sharpen), clamp(uSharp, 0.0, 1.0) * 0.35);

            // inject fresh material where the image has edges, so the flow keeps
            // being fed by the picture rather than washing out
            float inject = clamp(uContrastDrive * img.w * 0.5, 0.0, 1.0) * uDt * 2.0;
            f = mix(sharpen, img.x, clamp(inject + uImageDrive * uDt * 0.15, 0.0, 1.0));
            f += (rnd - 0.5) * uSpark * 0.2 * uDt;
            f -= uDecay * 0.1 * uDt;
            outState = vec4(clamp(f, 0.0, 1.0), 0.0, 0.0, 1.0);
        }

        fragColor = outState;
        return;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PASS 1 — DISPLAY  (output resolution: sample the grid through vUv)
    // ═══════════════════════════════════════════════════════════════════════
    vec2 fc = vUv * uSimRes;
    vec4 s  = Sbi(fc, sz);
    vec4 origColor = texture(uColor, vUv);

    float val;
    if (uMode < 0.5)        val = s.r;
    else if (uMode < 1.5)   val = s.r * 0.5 + 0.5;
    else if (uMode < 2.5)   val = clamp(s.g * 4.0, 0.0, 1.0);
    else                    val = s.r;

    if (uSharpness > 0.01) {
        float w = mix(0.5, 0.02, clamp(uSharpness, 0.0, 1.0));
        val = smoothstep(0.5 - w, 0.5 + w, val);
    }

    // slope of the field, for relief shading and contour lines
    float vx0, vx1, vy0, vy1;
    if (uMode < 1.5) { // r channel, signed or not — only the difference matters
        vx0 = Sbi(fc + vec2(-1.0, 0.0), sz).r; vx1 = Sbi(fc + vec2(1.0, 0.0), sz).r;
        vy0 = Sbi(fc + vec2(0.0, -1.0), sz).r; vy1 = Sbi(fc + vec2(0.0, 1.0), sz).r;
    } else if (uMode < 2.5) {
        vx0 = Sbi(fc + vec2(-1.0, 0.0), sz).g; vx1 = Sbi(fc + vec2(1.0, 0.0), sz).g;
        vy0 = Sbi(fc + vec2(0.0, -1.0), sz).g; vy1 = Sbi(fc + vec2(0.0, 1.0), sz).g;
    } else {
        vx0 = Sbi(fc + vec2(-1.0, 0.0), sz).r; vx1 = Sbi(fc + vec2(1.0, 0.0), sz).r;
        vy0 = Sbi(fc + vec2(0.0, -1.0), sz).r; vy1 = Sbi(fc + vec2(0.0, 1.0), sz).r;
    }
    vec2 slope = vec2(vx1 - vx0, vy1 - vy0) * 0.5;

    vec3 caRgb;
    if (uDisplayMode < 0.5) {
        // Image tint — the CA acts as lighting on the picture, not a multiply
        // to black, so dark areas of the image still read.
        caRgb = origColor.rgb * mix(0.25, 1.8, val);
    } else if (uDisplayMode < 1.5) {
        caRgb = vec3(val);
    } else if (uDisplayMode < 2.5) {
        // Relief — treat the field as a height map and light it
        vec3 nrm = normalize(vec3(-slope * 14.0, 1.0));
        vec3 lit = normalize(vec3(0.55, 0.65, 0.52));
        float diff = clamp(dot(nrm, lit), 0.0, 1.0);
        float spec = pow(clamp(dot(reflect(-lit, nrm), vec3(0.0, 0.0, 1.0)), 0.0, 1.0), 24.0);
        vec3 base = mix(origColor.rgb * 0.9 + 0.1, vec3(0.55, 0.6, 0.68), 0.45);
        caRgb = base * (0.25 + 0.9 * diff) + spec * 0.5;
    } else if (uDisplayMode < 3.5) {
        caRgb = palNeon(val);
    } else if (uDisplayMode < 4.5) {
        caRgb = mix(origColor.rgb, vec3(val), 0.6);
    } else {
        // Contour lines — iso-lines of the field over the image
        float bands = 7.0;
        float t = fract(val * bands);
        float w = fwidth(val * bands) * 1.2 + 1e-4;
        float line = 1.0 - smoothstep(0.0, w, min(t, 1.0 - t));
        caRgb = mix(origColor.rgb * 0.55, vec3(1.0), line);
    }

    fragColor = vec4(mix(origColor.rgb, caRgb, uMix), 1.0);
}
