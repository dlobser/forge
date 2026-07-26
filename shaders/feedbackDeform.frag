#version 300 es
// Feedback Deform — iterative domain warp. Starting at the current pixel, march
// along the gradient of the B&W field (DEPTH slot), blending the colour sampled
// at each step back toward the running colour (uFeedback). Repeating this is the
// single-pass equivalent of feeding a deformed frame back into itself. uAngle
// rotates the step direction (drive it from a node to animate the flow); uDecay
// shrinks each successive step so the march settles instead of running away.
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uColor;       // image being deformed
uniform sampler2D uDepth;       // B&W distortion field
uniform vec2  uResolution;
uniform float uTime;
uniform float uStrength;        // base step size (uv per unit gradient)
uniform float uIterations;      // how many warp steps to accumulate
uniform float uFeedback;        // how strongly each step blends in (0..1)
uniform float uDecay;           // per-step shrink of the step size
uniform float uAngle;           // static rotation of the flow (drive this from a node)
uniform float uSwirl;           // extra time-driven spin, turns per second
uniform float uSampleRadius;    // texel offset for the gradient estimate

const int MAX_ITER = 48;

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
float field(vec2 uv) { return luma(texture(uDepth, uv).rgb); }

vec2 gradient(vec2 uv) {
    vec2 texel = uSampleRadius / uResolution;
    float gx = field(uv + vec2(texel.x, 0.0)) - field(uv - vec2(texel.x, 0.0));
    float gy = field(uv + vec2(0.0, texel.y)) - field(uv - vec2(0.0, texel.y));
    return vec2(gx, gy) / (2.0 * texel);
}

void main() {
    int iters = int(uIterations + 0.5);

    // Rotation applied to each step's push direction. uAngle is a plain value you
    // set (or pin an Oscillator / Sine node to, which is the point — the animation
    // then lives in a node you can see and re-time, not buried in here). uSwirl adds
    // the old built-in spin on top and defaults to 0.
    float ang = uAngle * 6.28318530718 + uTime * uSwirl;
    float ca = cos(ang), sa = sin(ang);
    mat2 rot = mat2(ca, -sa, sa, ca);

    vec2 p = vUv;
    vec3 col = texture(uColor, p).rgb;
    float stepSize = uStrength;

    for (int i = 0; i < MAX_ITER; i++) {
        if (i >= iters) break;
        vec2 g = rot * gradient(p);
        p = clamp(p + g * stepSize, 0.0, 1.0);
        vec3 s = texture(uColor, p).rgb;
        col = mix(col, s, uFeedback);       // deform + mix back in
        stepSize *= uDecay;                  // settle the march
    }

    fragColor = vec4(col, 1.0);
}
