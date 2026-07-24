#version 300 es
// Remap — U = luma(image), V = angle of the image's luminance gradient. Sample the
// texture input at (U*tileX, V*tileY) with per-axis repeat or mirror.
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uImage;     // drives the lookup UVs
uniform sampler2D uTexture;   // sampled at (U, V)
uniform vec2  uResolution;
uniform float uTileX;
uniform float uTileY;
uniform float uMirrorX;
uniform float uMirrorY;
uniform float uVAmt;
const float TAU = 6.28318530718;
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
float tileAxis(float u, float mirror) {
    return (mirror > 0.5) ? (1.0 - abs(fract(u * 0.5) * 2.0 - 1.0)) : fract(u);
}
void main() {
    float U = luma(texture(uImage, vUv).rgb);
    vec2 e = 1.5 / uResolution;
    float gx = luma(texture(uImage, vUv + vec2(e.x, 0.0)).rgb) - luma(texture(uImage, vUv - vec2(e.x, 0.0)).rgb);
    float gy = luma(texture(uImage, vUv + vec2(0.0, e.y)).rgb) - luma(texture(uImage, vUv - vec2(0.0, e.y)).rgb);
    float V = atan(gy, gx) / TAU + 0.5;          // gradient direction → 0..1
    V = mix(0.5, V, uVAmt);
    vec2 uv = vec2(tileAxis(U * uTileX, uMirrorX), tileAxis(V * uTileY, uMirrorY));
    fragColor = vec4(texture(uTexture, uv).rgb, 1.0);
}
