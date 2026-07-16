#version 300 es
// histogramScan — grayscale histogram scan / threshold shaping.
//
// Smooth mode:
//   Uses smoothstep around uPosition.
//
// Binary mode:
//   Outputs strict 0 or 1.
//   This is recommended before Flood Fill.

precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uColor;
uniform vec2 uResolution;

uniform float uPosition;
uniform float uContrast;
uniform float uBinary;
uniform float uInvert;

float luminance(vec3 color) {
    return dot(color, vec3(0.299, 0.587, 0.114));
}

void main() {
    vec3 src = texture(uColor, vUv).rgb;

    float v = luminance(src);

    float result;

    // ── strict binary mode ────────────────────────────────────────────────────
    if (uBinary > 0.5) {
        result = step(uPosition, v);
    }

    // ── smooth histogram scan ─────────────────────────────────────────────────
    else {
        float width = 0.5 / max(uContrast + 1.0, 1.0);

        width = max(width, 0.0005);

        result = smoothstep(uPosition - width, uPosition + width, v);
    }

    if (uInvert > 0.5) {
        result = 1.0 - result;
    }

    fragColor = vec4(vec3(result), 1.0);
}
