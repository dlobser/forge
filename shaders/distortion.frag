#version 300 es
// Distortion — displaces the COLOR image along the gradient of the B&W field in
// the DEPTH slot. The gradient is the 2D "normal" of the field; sampling the
// colour at uv + grad*strength drags content from the bright side toward the
// dark side, so a white-centre / black-edge radial field pushes pixels outward.
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uColor;       // image being deformed
uniform sampler2D uDepth;       // B&W field that drives the push
uniform vec2  uResolution;
uniform float uStrength;        // uv push per unit gradient (signed)
uniform float uSampleRadius;    // texel offset for the gradient estimate
uniform float uMode;            // 0 deformed, 1 gradient, 2 field

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
float field(vec2 uv) { return luma(texture(uDepth, uv).rgb); }

// Central-difference gradient, normalised to "per uv" so the push is
// resolution-independent (preview matches the saved render).
vec2 gradient(vec2 uv) {
    vec2 texel = uSampleRadius / uResolution;
    float gx = field(uv + vec2(texel.x, 0.0)) - field(uv - vec2(texel.x, 0.0));
    float gy = field(uv + vec2(0.0, texel.y)) - field(uv - vec2(0.0, texel.y));
    return vec2(gx, gy) / (2.0 * texel);
}

void main() {
    vec2 g = gradient(vUv);

    if (uMode > 1.5) {                       // show the raw field
        fragColor = vec4(vec3(field(vUv)), 1.0);
        return;
    }
    if (uMode > 0.5) {                       // visualise the gradient direction
        vec2 d = g * 0.5 + 0.5;
        fragColor = vec4(d, 0.5, 1.0);
        return;
    }

    vec2 uv = clamp(vUv + g * uStrength, 0.0, 1.0);
    fragColor = vec4(texture(uColor, uv).rgb, 1.0);
}
