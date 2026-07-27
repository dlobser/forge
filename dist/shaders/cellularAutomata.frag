#version 300 es
// Cellular Automata — Image Contrast-Driven Self-Organizing Automata
// High-contrast regions in Image A catalyze cellular growth, lattice dithering,
// and fractal structure emergence.
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uColor;      // Image A — base image / contrast driver
uniform sampler2D uDepth;      // Image B — secondary mask / drive
uniform sampler2D uState;      // Sim state buffer (R=state, G=contrast, B=aux, A=aux)
uniform vec2  uResolution;
uniform vec2  uSimRes;         // Grid resolution (e.g. 256x256)
uniform float uPass;           // 0 = Step, 1 = Display, 2 = Seed
uniform float uTime;

// Controls
uniform float uMode;           // 0 = SmoothLife, 1 = Dither Lattice, 2 = Turing R-D, 3 = Contour Advection
uniform float uContrastDrive;  // 0..3: how strongly contrast catalyzes CA
uniform float uDt;             // time step
uniform float uInnerRad;       // 1..3
uniform float uOuterRad;       // 2..6
uniform float uBirthMin;       // 0.2
uniform float uBirthMax;       // 0.4
uniform float uSurvMin;        // 0.25
uniform float uSurvMax;        // 0.75
uniform float uDitherStrength; // 0..1
uniform float uFeed;           // 0..1 image coupling
uniform float uDecay;          // 0..0.2
uniform float uSeedMode;       // 0..2
uniform float uDisplayMode;    // 0..3
uniform float uMix;            // 0..1
uniform float uSharpness;      // 0..1

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
float hash(vec2 p) { p = fract(p * vec2(127.1, 311.7)); p += dot(p, p + 34.56); return fract(p.x * p.y); }

ivec2 wrapCoord(ivec2 c, ivec2 sz) {
    return (c % sz + sz) % sz;
}

float getState(ivec2 c, ivec2 sz) {
    return texelFetch(uState, wrapCoord(c, sz), 0).r;
}

// 4x4 Bayer Dither Matrix normalized to [0, 1]
float bayer4(ivec2 p) {
    int x = p.x % 4;
    int y = p.y % 4;
    int m[16] = int[16](
         0,  8,  2, 10,
        12,  4, 14,  6,
         3, 11,  1,  9,
        15,  7, 13,  5
    );
    return float(m[y * 4 + x]) / 16.0;
}

// Compute Sobel image contrast from uColor
float calcImageContrast(vec2 uv, vec2 px) {
    float l00 = luma(texture(uColor, uv + vec2(-px.x, -px.y)).rgb);
    float l10 = luma(texture(uColor, uv + vec2( 0.0,  -px.y)).rgb);
    float l20 = luma(texture(uColor, uv + vec2( px.x, -px.y)).rgb);
    float l01 = luma(texture(uColor, uv + vec2(-px.x,  0.0 )).rgb);
    float l21 = luma(texture(uColor, uv + vec2( px.x,  0.0 )).rgb);
    float l02 = luma(texture(uColor, uv + vec2(-px.x,  px.y)).rgb);
    float l12 = luma(texture(uColor, uv + vec2( 0.0,   px.y)).rgb);
    float l22 = luma(texture(uColor, uv + vec2( px.x,  px.y)).rgb);

    float gx = (l20 + 2.0*l21 + l22) - (l00 + 2.0*l01 + l02);
    float gy = (l02 + 2.0*l12 + l22) - (l00 + 2.0*l10 + l20);
    return sqrt(gx*gx + gy*gy);
}

// Palette for display
vec3 colormapNeon(float t) {
    vec3 a = vec3(0.05, 0.02, 0.12);
    vec3 b = vec3(0.9, 0.4, 0.8);
    vec3 c = vec3(0.2, 0.9, 0.9);
    return mix(a, mix(b, c, sin(t * 3.14159)), clamp(t, 0.0, 1.0));
}

void main() {
    ivec2 sz = ivec2(uSimRes);
    ivec2 ic = ivec2(gl_FragCoord.xy);
    vec2 uv = (vec2(ic) + 0.5) / uSimRes;
    vec2 px = 1.0 / uSimRes;

    // -------------------------------------------------------------
    // PASS 2: SEED / RESET
    // -------------------------------------------------------------
    if (uPass > 1.5) {
        float imgLuma = luma(texture(uColor, uv).rgb);
        float imgEdge = calcImageContrast(uv, px);
        float rnd = hash(vec2(ic) + vec2(uTime * 13.1, 7.3));

        float initState = 0.0;
        if (uSeedMode < 0.5) {
            initState = imgLuma;
        } else if (uSeedMode < 1.5) {
            initState = step(0.15, imgEdge) * rnd + imgLuma * 0.3;
        } else {
            initState = step(0.7, rnd);
        }

        fragColor = vec4(clamp(initState, 0.0, 1.0), imgEdge, 0.0, 1.0);
        return;
    }

    // -------------------------------------------------------------
    // PASS 0: SIMULATION STEP
    // -------------------------------------------------------------
    if (uPass < 0.5) {
        float curState = getState(ic, sz);
        float imgLuma = luma(texture(uColor, uv).rgb);
        float imgContrast = calcImageContrast(uv, px);

        // Modulated catalyst factor: high contrast areas speed up & focus CA growth
        float catalyst = 0.3 + imgContrast * uContrastDrive * 2.5;

        // Calculate inner disc and outer ring neighborhood sums
        int rIn = int(clamp(uInnerRad, 1.0, 3.0));
        int rOut = int(clamp(uOuterRad, 2.0, 6.0));

        float sumInner = 0.0;
        float countInner = 0.0;
        float sumOuter = 0.0;
        float countOuter = 0.0;

        for (int dy = -6; dy <= 6; dy++) {
            for (int dx = -6; dx <= 6; dx++) {
                float distSq = float(dx * dx + dy * dy);
                if (distSq <= float(rIn * rIn)) {
                    sumInner += getState(ic + ivec2(dx, dy), sz);
                    countInner += 1.0;
                } else if (distSq <= float(rOut * rOut)) {
                    sumOuter += getState(ic + ivec2(dx, dy), sz);
                    countOuter += 1.0;
                }
            }
        }

        float avgInner = countInner > 0.0 ? sumInner / countInner : curState;
        float avgOuter = countOuter > 0.0 ? sumOuter / countOuter : 0.0;

        float nextState = curState;

        if (uMode < 0.5) {
            // MODE 0: Continuous Life (SmoothLife / Lenia-like)
            // Growth is a continuous bell curve based on outer ring density
            float midSurv = (uSurvMin + uSurvMax) * 0.5;
            float widthSurv = max(0.01, (uSurvMax - uSurvMin) * 0.5);
            float survFactor = exp(-pow((avgOuter - midSurv) / widthSurv, 2.0));

            float midBirth = (uBirthMin + uBirthMax) * 0.5;
            float widthBirth = max(0.01, (uBirthMax - uBirthMin) * 0.5);
            float birthFactor = exp(-pow((avgOuter - midBirth) / widthBirth, 2.0));

            // Growth rate modulated by catalyst (contrast)
            float growth = mix(-0.2, 0.4, mix(survFactor, birthFactor, 1.0 - curState));
            nextState = curState + growth * uDt * catalyst;

        } else if (uMode < 1.5) {
            // MODE 1: Dither Lattice Crystallizer
            // Pixels pull toward Bayer matrix thresholds in high-contrast zones
            float ditherVal = bayer4(ic);
            float target = step(ditherVal, avgInner);

            // Contrast controls how strongly pixels crystallize to dither pattern
            float pull = (target - curState) * (0.2 + uDitherStrength * 0.8) * catalyst;
            nextState = curState + pull * uDt * 5.0;

        } else if (uMode < 2.5) {
            // MODE 2: Turing Reaction-Diffusion (Short activation, long inhibition)
            float diff = (avgInner - avgOuter);
            float growth = diff * catalyst * 2.0;
            nextState = curState + growth * uDt;

        } else {
            // MODE 3: Contour Advection Automata
            // Shift state along contrast gradient
            float lR = getState(ic + ivec2(1, 0), sz);
            float lL = getState(ic + ivec2(-1, 0), sz);
            float lU = getState(ic + ivec2(0, 1), sz);
            float lD = getState(ic + ivec2(0, -1), sz);

            vec2 grad = vec2(lR - lL, lU - lD);
            float laplacian = (lL + lR + lU + lD - 4.0 * curState);

            float delta = laplacian * 0.25 + dot(grad, vec2(0.5)) * catalyst;
            nextState = curState + delta * uDt * 4.0;
        }

        // Apply Dither Attractor force across all modes if uDitherStrength > 0
        if (uDitherStrength > 0.05 && uMode != 1.0) {
            float ditherVal = bayer4(ic);
            float ditherTarget = step(ditherVal, nextState);
            nextState = mix(nextState, ditherTarget, uDitherStrength * 0.3 * catalyst);
        }

        // Feed from input image & decay
        nextState = mix(nextState, imgLuma, uFeed * 0.2 * uDt);
        nextState = max(0.0, nextState - uDecay * 0.1 * uDt);

        nextState = clamp(nextState, 0.0, 1.0);

        fragColor = vec4(nextState, imgContrast, 0.0, 1.0);
        return;
    }

    // -------------------------------------------------------------
    // PASS 1: DISPLAY / RENDER
    // -------------------------------------------------------------
    float val = getState(ic, sz);
    vec4 origColor = texture(uColor, uv);

    // Apply sharpness curve
    if (uSharpness > 0.05) {
        val = smoothstep(0.5 - uSharpness * 0.45, 0.5 + uSharpness * 0.45, val);
    }

    vec3 caRgb;
    if (uDisplayMode < 0.5) {
        // Image Colorized: multiply CA density by original image color
        caRgb = origColor.rgb * val * 1.5;
    } else if (uDisplayMode < 1.5) {
        // Neon Cyberpunk Heatmap
        caRgb = colormapNeon(val);
    } else if (uDisplayMode < 2.5) {
        // Monochrome Dither
        caRgb = vec3(val);
    } else {
        // Composite Overlay
        caRgb = mix(origColor.rgb, vec3(val), 0.6);
    }

    vec3 finalRgb = mix(origColor.rgb, caRgb, uMix);
    fragColor = vec4(finalRgb, 1.0);
}
