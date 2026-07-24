#version 300 es
// Distort — offset the colour UVs along the gradient of the distort input's
// luminance (central differences). Positive Amount pushes toward brighter areas.
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uColor;
uniform sampler2D uDistort;
uniform vec2  uResolution;
uniform float uAmount;
uniform float uSample;
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
void main() {
    vec2 e = uSample / uResolution;
    float gx = luma(texture(uDistort, vUv + vec2(e.x, 0.0)).rgb) - luma(texture(uDistort, vUv - vec2(e.x, 0.0)).rgb);
    float gy = luma(texture(uDistort, vUv + vec2(0.0, e.y)).rgb) - luma(texture(uDistort, vUv - vec2(0.0, e.y)).rgb);
    vec2 duv = vUv + vec2(gx, gy) * uAmount;
    fragColor = texture(uColor, duv);
}
