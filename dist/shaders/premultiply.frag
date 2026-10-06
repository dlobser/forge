#version 300 es
// Premultiply — rgb × alpha (or ÷ alpha to undo it), optionally flattening to opaque.
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uColor;    // image
uniform float uMode;         // 0 = premultiply, 1 = unpremultiply
uniform float uAlphaOut;     // 0 = keep alpha, 1 = opaque

void main() {
    vec4 c = texture(uColor, vUv);
    vec3 rgb = uMode < 0.5
        ? c.rgb * c.a
        : (c.a > 1e-4 ? c.rgb / c.a : vec3(0.0));
    fragColor = vec4(clamp(rgb, 0.0, 1.0), uAlphaOut > 0.5 ? 1.0 : c.a);
}
