#version 300 es
// SDF — circle / square / triangle / torus distance field from a centre, mapped to
// brightness by exp(-|d|*dropoff). Aspect-corrected so circles stay round.
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform vec2  uResolution;
uniform sampler2D uDistort;   // optional: warps the field UVs along its luminance gradient
uniform float uDistortAmt;
uniform float uShape;
uniform float uCenterX;
uniform float uCenterY;
uniform float uScale;
uniform float uDropoff;
uniform float uRing;
uniform float uInvert;

// equilateral triangle SDF (iq)
float sdTriangle(vec2 p) {
    const float k = 1.7320508;   // sqrt(3)
    p.x = abs(p.x) - 1.0;
    p.y = p.y + 1.0 / k;
    if (p.x + k * p.y > 0.0) p = vec2(p.x - k * p.y, -k * p.x - p.y) / 2.0;
    p.x -= clamp(p.x, -2.0, 0.0);
    return -length(p) * sign(p.y);
}

void main() {
    // optional warp: push the field UVs along the gradient of the distort input
    vec3 W = vec3(0.299, 0.587, 0.114);
    vec2 ge = 1.5 / uResolution;
    float gx = dot(texture(uDistort, vUv + vec2(ge.x, 0.0)).rgb, W) - dot(texture(uDistort, vUv - vec2(ge.x, 0.0)).rgb, W);
    float gy = dot(texture(uDistort, vUv + vec2(0.0, ge.y)).rgb, W) - dot(texture(uDistort, vUv - vec2(0.0, ge.y)).rgb, W);
    vec2 wuv = vUv + vec2(gx, gy) * uDistortAmt;
    float s = max(uScale, 1e-3);
    vec2 p = (wuv - vec2(uCenterX, uCenterY)) / s;
    float d;
    if (uShape < 0.5) {
        d = length(p);                                    // circle
    } else if (uShape < 1.5) {
        vec2 q = abs(p) - vec2(1.0);                      // square (box, half-size 1)
        d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
    } else if (uShape < 2.5) {
        d = sdTriangle(p);                                // triangle
    } else {
        d = abs(length(p) - uRing / s);                   // torus / ring
    }
    float v = exp(-abs(d) * uDropoff);
    if (uInvert > 0.5) v = 1.0 - v;
    fragColor = vec4(vec3(v), 1.0);
}
