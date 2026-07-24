#version 300 es
// blur — Gaussian-like blur using a Golden Angle spiral pattern.
// Supports an optional per-pixel mask (uDepth).
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uColor;   // the image to blur
uniform sampler2D uDepth;   // the optional mask
uniform vec2  uResolution;
uniform float uRadius;      // max blur radius in pixels
uniform float uQuality;     // sample quality (defines number of steps)
uniform float uUseMask;     // 1.0 = modulate radius by mask luma, 0.0 = full blur
uniform float uInvert;      // 1.0 = invert mask luma, 0.0 = normal

float luma(vec3 c) {
    return dot(c, vec3(0.299, 0.587, 0.114));
}

void main() {
    float maskVal = 1.0;
    if (uUseMask > 0.5) {
        maskVal = luma(texture(uDepth, vUv).rgb);
        if (uInvert > 0.5) {
            maskVal = 1.0 - maskVal;
        }
    }

    float radius = uRadius * maskVal;
    if (radius < 0.1) {
        fragColor = texture(uColor, vUv);
        return;
    }

    vec4 sum = vec4(0.0);
    float totalWeight = 0.0;

    // Golden angle spiral sampling
    // We scale sample count by uQuality (e.g. 4 * uQuality)
    int samples = int(uQuality) * 4;
    
    // We set a safe upper bound for WebGL loop iteration limits
    for (int i = 0; i < 64; i++) {
        if (i >= samples) break;
        
        float t = (float(i) + 0.5) / float(samples);
        float theta = float(i) * 2.39996323; // Golden angle in radians
        float r = radius * sqrt(t);
        
        vec2 offset = vec2(cos(theta), sin(theta)) * r / uResolution;
        float w = exp(-4.0 * t * t); // Gaussian-like weight falloff
        
        sum += texture(uColor, vUv + offset) * w;
        totalWeight += w;
    }

    fragColor = sum / totalWeight;
}
