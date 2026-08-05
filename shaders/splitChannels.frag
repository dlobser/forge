#version 300 es
// Split Channels — one channel of the input as a black-and-white image.
//
// The node has five outputs and renders this shader once per output, with uOutput
// set to the slot's index (0 = Selected, 1..4 = R/G/B/A). Slot 0 follows the
// Channel control, which is what the node's own thumbnail shows; the other four
// are always their own channel, so one node can feed four different chains.
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uColor;
uniform float uOutput;    // which output slot is being drawn (set by the engine)
uniform float uChannel;   // 0 R · 1 G · 2 B · 3 A · 4 Luminance — drives slot 0
uniform float uInvert;
uniform float uGain;
uniform float uOffset;
uniform float uToAlpha;   // also write the value into alpha (handy as a mask)

float pick(vec4 c, float ch) {
    if (ch < 0.5) return c.r;
    if (ch < 1.5) return c.g;
    if (ch < 2.5) return c.b;
    if (ch < 3.5) return c.a;
    return dot(c.rgb, vec3(0.299, 0.587, 0.114));
}

void main() {
    vec4 c = texture(uColor, vUv);
    // slot 0 follows the Channel control; slots 1-4 are R, G, B, A
    float v = pick(c, uOutput < 0.5 ? uChannel : uOutput - 1.0);
    v = v * uGain + uOffset;
    if (uInvert > 0.5) v = 1.0 - v;
    v = clamp(v, 0.0, 1.0);
    fragColor = vec4(vec3(v), uToAlpha > 0.5 ? v : 1.0);
}
