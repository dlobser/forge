#version 300 es
// Navier-Stokes fluid — an incompressible 2D solver on a square ping-pong grid.
//
// State lives in two RGBA32F buffers (manifest: simBuffers: 2), written together
// by MRT on every pass:
//     uState0   xy = velocity (grid cells per unit time) · z = pressure · w = divergence
//     uState1   rgb = dye, PREMULTIPLIED by density · a = density
// Dye is premultiplied so advection stays correct: interpolating a straight colour
// against an empty cell would drag that cell's meaningless colour into the result,
// while interpolating colour*density against 0 correctly fades toward nothing.
//
// One frame is five passes, selected by uStage (manifest: simPasses):
//     1  advect velocity + dye, inject from the image/mask, apply gravity & noise
//     2  vorticity confinement — puts the small curls back that advection smeared
//     3  divergence of the velocity field
//     4  pressure, Jacobi (repeated "Solver Quality" times)
//     5  project: subtract the pressure gradient, so the field is divergence-free
// plus uPass 2 = seed and uPass 1 = display.
//
// Inputs: Image (the dye's colour), Mask (where it is emitted), Obstacle (solid
// walls the fluid flows around). Output carries real alpha — the dye's density —
// so it composites over anything downstream.
precision highp float;

in vec2 vUv;
layout(location = 0) out vec4 outVel;    // also the display pass's colour
layout(location = 1) out vec4 outDye;

uniform sampler2D uColor;      // image → dye colour
uniform sampler2D uMask;       // where dye is emitted (white = emit)
uniform sampler2D uObstacle;   // solid cells the fluid cannot enter
uniform sampler2D uState0;     // velocity.xy, pressure.z, divergence.w
uniform sampler2D uState1;     // dye.rgb (premultiplied), density.a

uniform vec2  uResolution;     // viewport of the current pass
uniform vec2  uSimRes;         // simulation grid size
uniform float uPass;           // 0 step · 1 display · 2 seed
uniform float uStage;          // which step pass (see header)
uniform float uIter;           // repeat index within a stage
uniform float uTime;

// emission
uniform float uEmitMode;       // 0 continuous · 1 seed only · 2 pulse
uniform float uEmitRate;
uniform float uEmitThreshold;  // mask level below which nothing is emitted
uniform float uEmitSoft;       // softness of that threshold
uniform float uImageGate;      // image brightness also gates emission
uniform float uEmitSpeed;      // velocity the emitter drives the fluid at
uniform float uEmitAngle;      // degrees; 0 = right, 90 = up
uniform float uEmitSpread;     // random angle jitter
uniform float uPulseRate;
uniform vec3  uTint;
uniform float uSaturate;
uniform float uRainbow;        // cycle the dye hue over time and space

// forces
uniform float uGravityX;
uniform float uGravityY;
uniform float uBuoyancy;       // bright dye rises
uniform float uVorticity;      // detail: how hard small curls are re-injected
uniform float uNoiseForce;     // curl-noise stirring
uniform float uNoiseScale;
uniform float uSwirlSpeed;

// fluid
uniform float uDt;
uniform float uVelDamp;
uniform float uDissipation;
uniform float uPressureIters;  // read by the engine as stage 4's repeat count
uniform float uEdgeMode;       // 0 walls · 1 open · 2 wrap
uniform float uObstacleThresh;
uniform float uObstacleInvert;

// display
uniform float uDisplayMode;    // 0 dye+alpha · 1 over image · 2 on black · 3 velocity · 4 pressure · 5 curl
uniform float uGain;
uniform float uAlphaGain;
uniform float uAlphaGamma;

const float PI = 3.14159265359;

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
ivec2 gsize() { return ivec2(uSimRes + 0.5); }

float hash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash21(i), hash21(i + vec2(1, 0)), f.x),
               mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) {
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 3; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; }
    return s;
}
// Curl of a scalar noise potential — divergence-free by construction, so stirring
// with it adds swirl without fighting the pressure solve.
vec2 curlNoise(vec2 p) {
    float e = 0.09;
    return vec2(fbm(p + vec2(0.0, e)) - fbm(p - vec2(0.0, e)),
                fbm(p - vec2(e, 0.0)) - fbm(p + vec2(e, 0.0))) / (2.0 * e);
}
vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

// ── grid access, with the edge rule applied ───────────────────────────────────
// Wrap makes the grid a torus; walls and open both clamp, which is a zero-gradient
// (Neumann) ghost cell — for open edges that lets fluid leave, and for walls the
// normal velocity component is flipped below so it bounces instead.
ivec2 edgeC(ivec2 c) {
    ivec2 sz = gsize();
    if (uEdgeMode > 1.5) return ivec2((c.x % sz.x + sz.x) % sz.x, (c.y % sz.y + sz.y) % sz.y);
    return clamp(c, ivec2(0), sz - ivec2(1));
}
bool outside(ivec2 c) { ivec2 sz = gsize(); return c.x < 0 || c.y < 0 || c.x >= sz.x || c.y >= sz.y; }

float solidAt(ivec2 c) {
    if (uEdgeMode < 0.5 && outside(c)) return 1.0;        // closed edges are walls
    vec2 uv = (vec2(edgeC(c)) + 0.5) / uSimRes;
    float m = luma(texture(uObstacle, uv).rgb);
    if (uObstacleInvert > 0.5) m = 1.0 - m;
    return step(uObstacleThresh, m);
}

vec4 F0(ivec2 c) {
    vec4 v = texelFetch(uState0, edgeC(c), 0);
    if (uEdgeMode < 0.5) {
        ivec2 sz = gsize();
        if (c.x < 0 || c.x >= sz.x) v.x = -v.x;
        if (c.y < 0 || c.y >= sz.y) v.y = -v.y;
    }
    return v;
}
vec4 F1(ivec2 c) { return texelFetch(uState1, edgeC(c), 0); }

// Sim textures are point-filtered (every texture in Forge is), so advection does
// its own bilinear fetch — that interpolation IS the semi-Lagrangian step.
vec4 bilerp0(vec2 p) {
    vec2 f = floor(p), t = p - f; ivec2 i = ivec2(f);
    return mix(mix(F0(i), F0(i + ivec2(1, 0)), t.x),
               mix(F0(i + ivec2(0, 1)), F0(i + ivec2(1, 1)), t.x), t.y);
}
vec4 bilerp1(vec2 p) {
    vec2 f = floor(p), t = p - f; ivec2 i = ivec2(f);
    return mix(mix(F1(i), F1(i + ivec2(1, 0)), t.x),
               mix(F1(i + ivec2(0, 1)), F1(i + ivec2(1, 1)), t.x), t.y);
}

// velocity of a neighbour, reading 0 inside solids (no-slip walls)
vec2 velN(ivec2 c) { return F0(c).xy * (1.0 - solidAt(c)); }
// pressure of a neighbour; a solid gets the centre's own pressure (Neumann)
float presN(ivec2 c, float pc) { return mix(F0(c).z, pc, solidAt(c)); }

float curlAt(ivec2 c) {
    return 0.5 * (velN(c + ivec2(1, 0)).y - velN(c - ivec2(1, 0)).y)
         - 0.5 * (velN(c + ivec2(0, 1)).x - velN(c - ivec2(0, 1)).x);
}

// ── emission ─────────────────────────────────────────────────────────────────
float maskAt(vec2 uv) {
    float m = luma(texture(uMask, uv).rgb);
    float g = smoothstep(uEmitThreshold, uEmitThreshold + max(uEmitSoft, 1e-3), m);
    float img = luma(texture(uColor, uv).rgb);
    return g * mix(1.0, smoothstep(0.0, 0.35, img), uImageGate);
}

vec3 dyeColorAt(vec2 uv) {
    vec3 c = texture(uColor, uv).rgb;
    float l = luma(c);
    c = mix(vec3(l), c, uSaturate);                       // saturation push
    if (uRainbow > 0.001) {
        float hue = fract(uv.x * 0.6 + uv.y * 0.35 + uTime * 0.06 + l * 0.4);
        c = mix(c, hsv2rgb(vec3(hue, 0.9, max(l, 0.55))), uRainbow);
    }
    return max(c * uTint, 0.0);
}

float emitEnvelope() {
    if (uEmitMode > 1.5) return max(0.0, sin(uTime * uPulseRate * 2.0 * PI));
    if (uEmitMode > 0.5) return 0.0;                      // seed-only: nothing after the seed
    return 1.0;
}

void main() {
    // ── SEED ──────────────────────────────────────────────────────────────────
    if (uPass > 1.5) {
        ivec2 c = ivec2(gl_FragCoord.xy);
        vec2 uv = (vec2(c) + 0.5) / uSimRes;
        outVel = vec4(0.0);
        // "Seed only" turns the picture itself into the fluid: the whole masked
        // image becomes dye once, then just moves. Other modes start empty.
        if (uEmitMode > 0.5 && uEmitMode < 1.5) {
            float g = maskAt(uv) * (1.0 - solidAt(c));
            outDye = vec4(dyeColorAt(uv) * g, g);
        } else {
            outDye = vec4(0.0);
        }
        return;
    }

    // ── DISPLAY ───────────────────────────────────────────────────────────────
    if (uPass > 0.5) {
        vec2 p = vUv * uSimRes - 0.5;
        vec4 d = bilerp1(p);
        vec4 s = bilerp0(p);
        float dens = max(d.a, 0.0);
        vec3 col = dens > 1e-4 ? d.rgb / dens : vec3(0.0);
        float a = clamp(pow(clamp(dens * uAlphaGain, 0.0, 1.0), max(uAlphaGamma, 0.01)), 0.0, 1.0);
        col *= uGain;

        if (uDisplayMode < 0.5) {                          // dye with real alpha
            outVel = vec4(col, a);
        } else if (uDisplayMode < 1.5) {                   // composited over the image
            outVel = vec4(mix(texture(uColor, vUv).rgb, col, a), 1.0);
        } else if (uDisplayMode < 2.5) {                   // on black, opaque
            outVel = vec4(col * a, 1.0);
        } else if (uDisplayMode < 3.5) {                   // velocity field
            outVel = vec4(0.5 + s.xy * 0.02 * uGain, 0.5, 1.0);
        } else if (uDisplayMode < 4.5) {                   // pressure
            float pr = s.z * uGain;
            outVel = vec4(max(pr, 0.0), 0.0, max(-pr, 0.0), 1.0);
        } else {                                           // curl (vorticity)
            float w = curlAt(ivec2(clamp(p, vec2(0.0), uSimRes - 1.0))) * 0.1 * uGain;
            outVel = vec4(max(w, 0.0), abs(w) * 0.3, max(-w, 0.0), 1.0);
        }
        outDye = vec4(0.0);
        return;
    }

    // ── STEP ──────────────────────────────────────────────────────────────────
    ivec2 c = ivec2(gl_FragCoord.xy);
    vec2 uv = (vec2(c) + 0.5) / uSimRes;
    vec2 pos = gl_FragCoord.xy - 0.5;
    vec4 s0 = F0(c), s1 = F1(c);
    float sol = solidAt(c);
    outVel = s0; outDye = s1;                              // default: pass through

    // 1 ── advect, inject, external forces
    if (uStage < 1.5) {
        vec2 back = pos - s0.xy * uDt;
        vec2 vel = bilerp0(back).xy;
        vec4 dye = bilerp1(back);

        vel *= max(0.0, 1.0 - uVelDamp * uDt);
        dye *= max(0.0, 1.0 - uDissipation * uDt);

        // gravity pulls on the dye's mass; buoyancy lifts the bright parts
        float dens = max(dye.a, 0.0);
        float lum = dens > 1e-4 ? luma(dye.rgb / dens) : 0.0;
        vel += vec2(uGravityX, uGravityY) * dens * uDt;
        vel.y += uBuoyancy * lum * dens * uDt;

        if (uNoiseForce > 0.0001)
            vel += curlNoise(uv * uNoiseScale + vec2(uTime * uSwirlSpeed, uTime * uSwirlSpeed * 0.7))
                 * uNoiseForce * uDt;

        float g = maskAt(uv) * emitEnvelope();
        if (g > 0.0001) {
            float add = uEmitRate * g * uDt;
            dye.rgb += dyeColorAt(uv) * add;
            dye.a += add;
            float ang = radians(uEmitAngle)
                      + (hash21(vec2(c) + uTime * 7.3) - 0.5) * uEmitSpread * PI;
            vel = mix(vel, vec2(cos(ang), sin(ang)) * uEmitSpeed, clamp(g * uDt * 8.0, 0.0, 1.0));
        }

        dye = clamp(dye, vec4(0.0), vec4(6.0, 6.0, 6.0, 3.0));
        if (sol > 0.5) { vel = vec2(0.0); dye = vec4(0.0); }
        outVel = vec4(vel, s0.z, s0.w);
        outDye = dye;
        return;
    }

    // 2 ── vorticity confinement: push velocity along the gradient of |curl|, which
    //      feeds energy back into the eddies semi-Lagrangian advection washes out.
    if (uStage < 2.5) {
        if (uVorticity > 0.0001 && sol < 0.5) {
            float w = curlAt(c);
            vec2 g = vec2(abs(curlAt(c + ivec2(1, 0))) - abs(curlAt(c - ivec2(1, 0))),
                          abs(curlAt(c + ivec2(0, 1))) - abs(curlAt(c - ivec2(0, 1)))) * 0.5;
            g /= length(g) + 1e-5;
            outVel = vec4(s0.xy + vec2(g.y, -g.x) * w * uVorticity * uDt, s0.z, s0.w);
        }
        return;
    }

    // 3 ── divergence of the (still compressible) velocity field
    if (uStage < 3.5) {
        float div = 0.5 * ((velN(c + ivec2(1, 0)).x - velN(c - ivec2(1, 0)).x)
                         + (velN(c + ivec2(0, 1)).y - velN(c - ivec2(0, 1)).y));
        outVel = vec4(s0.xy, s0.z, div);
        return;
    }

    // 4 ── pressure: one Jacobi sweep of  ∇²p = ∇·v  (run "Solver Quality" times)
    if (uStage < 4.5) {
        float pc = s0.z;
        float p = (presN(c - ivec2(1, 0), pc) + presN(c + ivec2(1, 0), pc)
                 + presN(c - ivec2(0, 1), pc) + presN(c + ivec2(0, 1), pc) - s0.w) * 0.25;
        outVel = vec4(s0.xy, p, s0.w);
        return;
    }

    // 5 ── project: subtract the pressure gradient → a divergence-free field
    float pc = s0.z;
    vec2 grad = 0.5 * vec2(presN(c + ivec2(1, 0), pc) - presN(c - ivec2(1, 0), pc),
                           presN(c + ivec2(0, 1), pc) - presN(c - ivec2(0, 1), pc));
    vec2 vel = s0.xy - grad;
    // don't let anything flow INTO a wall (leaving one is fine)
    if (solidAt(c + ivec2(1, 0)) > 0.5) vel.x = min(vel.x, 0.0);
    if (solidAt(c - ivec2(1, 0)) > 0.5) vel.x = max(vel.x, 0.0);
    if (solidAt(c + ivec2(0, 1)) > 0.5) vel.y = min(vel.y, 0.0);
    if (solidAt(c - ivec2(0, 1)) > 0.5) vel.y = max(vel.y, 0.0);
    if (sol > 0.5) vel = vec2(0.0);
    outVel = vec4(vel, s0.z, s0.w);
}
