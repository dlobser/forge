#version 300 es
// kaleidoscope — realtime mirrored rotational sampling.

precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uColor;
uniform vec2  uResolution;

uniform float uSegments;
uniform float uZoom;
uniform float uRotation;
uniform float uCenterX;
uniform float uCenterY;
uniform float uMirror;

void main() {
    vec2 uv = vUv;

    vec2 center = vec2(uCenterX, uCenterY);
    vec2 p = uv - center;

    float r = length(p);
    float a = atan(p.y, p.x);

    a += uRotation;

    float tau = 6.28318530718;
    float segCount = max(uSegments, 1.0);
    float segAngle = tau / segCount;

    // Fold angle into one segment
    a = mod(a, segAngle);

    // Mirror within each segment for kaleidoscope symmetry
    if (uMirror > 0.5) {
        a = abs(a - segAngle * 0.5);
    }

    r = r / max(uZoom, 0.001);

    vec2 sampleUV = vec2(cos(a), sin(a)) * r + center;

    // Avoid ugly black hard edges by softly clamping UV
    sampleUV = clamp(sampleUV, vec2(0.0), vec2(1.0));

    fragColor = texture(uColor, sampleUV);
}