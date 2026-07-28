#version 300 es
// Framebuffer / Frame Memory — 1-frame delay buffer, feedback loop, and temporal difference node.
// Uses engine `history: true` to store state across iterations in `uPrev`.

precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uColor;      // Current live image input
uniform sampler2D uHold;       // Optional hold / freeze mask
uniform sampler2D uPrev;       // Previous frame buffer (engine provided)
uniform vec2  uResolution;
uniform float uTime;
uniform float uFirst;          // 1.0 on initial frame / reset

// Controls
uniform float uMode;           // 0=Delayed 1 Frame, 1=Abs Difference, 2=Signed Difference, 3=Motion Mask, 4=Temporal Blend, 5=Freeze Snapshot
uniform float uFreeze;         // 1 = Lock / Freeze current buffer
uniform float uDecay;          // Feedback persistence (0..1)
uniform float uMix;            // Feed amount / mix rate (0..1)
uniform float uGain;           // Sensitivity multiplier for difference (1..10)
uniform float uThreshold;      // Noise floor threshold (0..1)
uniform float uColorStyle;     // 0=RGB, 1=Grayscale, 2=Heatmap
uniform float uInvert;         // 1 = Invert output

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

vec3 colormapHeatmap(float t) {
    vec3 a = vec3(0.02, 0.01, 0.05);
    vec3 b = vec3(0.95, 0.25, 0.15);
    vec3 c = vec3(1.0, 0.9, 0.3);
    return mix(a, mix(b, c, sin(t * 3.14159 * 0.5)), clamp(t, 0.0, 1.0));
}

void main() {
    vec4 currentFrame = texture(uColor, vUv);

    // On first frame after reset, previous frame equals current frame
    vec4 prevFrame = (uFirst > 0.5) ? currentFrame : texture(uPrev, vUv);

    // Check hold mask or freeze toggle
    float holdVal = luma(texture(uHold, vUv).rgb);
    bool isFrozen = (uFreeze > 0.5) || (holdVal > 0.5);

    // Calculate persistent history state
    vec4 historyState;
    if (isFrozen) {
        historyState = prevFrame;
    } else {
        // Blend current frame into history buffer
        vec3 decayedPrev = prevFrame.rgb * uDecay;
        historyState = vec4(mix(decayedPrev, currentFrame.rgb, clamp(uMix, 0.001, 1.0)), currentFrame.a);
    }

    vec3 outRgb;

    if (uMode < 0.5) {
        // MODE 0: Delayed 1 Frame (Output previous buffer state)
        outRgb = historyState.rgb;

    } else if (uMode < 1.5) {
        // MODE 1: Absolute Frame Difference (|Current - Previous|)
        vec3 diff = abs(currentFrame.rgb - prevFrame.rgb) * uGain;
        if (uThreshold > 0.0) {
            diff = max(vec3(0.0), diff - vec3(uThreshold));
        }

        if (uColorStyle < 0.5) {
            outRgb = diff;
        } else if (uColorStyle < 1.5) {
            outRgb = vec3(luma(diff));
        } else {
            outRgb = colormapHeatmap(luma(diff));
        }

    } else if (uMode < 2.5) {
        // MODE 2: Signed Difference (Current - Previous + 0.5)
        vec3 sDiff = (currentFrame.rgb - prevFrame.rgb) * uGain * 0.5 + vec3(0.5);
        outRgb = clamp(sDiff, 0.0, 1.0);

    } else if (uMode < 3.5) {
        // MODE 3: Motion Mask (Binary change detector)
        float dLuma = abs(luma(currentFrame.rgb) - luma(prevFrame.rgb)) * uGain;
        float mask = step(uThreshold, dLuma);
        outRgb = vec3(mask);

    } else if (uMode < 4.5) {
        // MODE 4: Temporal Blend / Accumulate
        outRgb = historyState.rgb;

    } else {
        // MODE 5: Freeze Snapshot Comparison (Live minus Snapshot)
        vec3 snapDiff = abs(currentFrame.rgb - prevFrame.rgb) * uGain;
        outRgb = snapDiff;
    }

    if (uInvert > 0.5) {
        outRgb = 1.0 - outRgb;
    }

    fragColor = vec4(outRgb, currentFrame.a);
}
