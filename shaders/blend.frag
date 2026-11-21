#version 300 es
// Blend — lays image B (DEPTH slot) over image A (COLOR slot) with one of nine
// blend modes, honouring both images' alpha (the W3C compositing model):
//
//   where B is transparent you see A, where A is transparent you see B, and where
//   both are opaque you get the mode's result. uMix is B's opacity, and the MASK
//   limits where B applies: white blends, black keeps the base.
//
// A and B default to transparent, so an unconnected one changes nothing. It used
// to ignore alpha and default to grey, which is why Add with nothing in B lifted a
// black A to mid-grey — and why pixels that looked empty (rgb under zero alpha)
// suddenly showed up.
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uColor;   // image A (base / backdrop)
uniform sampler2D uDepth;   // image B (blended on top)
uniform sampler2D uMask;    // white = blend here, black = base only
uniform vec2  uResolution;
uniform float uMode;        // 0 add, 1 multiply, 2 difference, 3 overlay, 4 screen,
                            // 5 normal, 6 subtract, 7 lighten, 8 darken
uniform float uMix;         // B's opacity
uniform float uSwap;        // 1 = swap A/B
uniform float uMaskInvert;  // 1 = flip the mask

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

vec3 blendMode(vec3 a, vec3 b) {
    if (uMode < 0.5) return a + b;                                                    // add
    if (uMode < 1.5) return a * b;                                                    // multiply
    if (uMode < 2.5) return abs(a - b);                                               // difference
    if (uMode < 3.5) return mix(2.0 * a * b, 1.0 - 2.0 * (1.0 - a) * (1.0 - b), step(0.5, a)); // overlay
    if (uMode < 4.5) return 1.0 - (1.0 - a) * (1.0 - b);                              // screen
    if (uMode < 5.5) return b;                                                        // normal
    if (uMode < 6.5) return a - b;                                                    // subtract
    if (uMode < 7.5) return max(a, b);                                                // lighten
    return min(a, b);                                                                 // darken
}

void main() {
    vec4 A = texture(uColor, vUv);
    vec4 B = texture(uDepth, vUv);
    if (uSwap > 0.5) { vec4 t = A; A = B; B = t; }

    float m = clamp(luma(texture(uMask, vUv).rgb), 0.0, 1.0);
    if (uMaskInvert > 0.5) m = 1.0 - m;

    float ab = clamp(A.a, 0.0, 1.0);              // backdrop alpha
    float as = clamp(B.a, 0.0, 1.0) * uMix * m;   // source alpha (B, faded by Mix and the mask)

    // The mode only applies where A is there to blend with; over empty A, B is B.
    vec3 r = clamp(blendMode(A.rgb, B.rgb), 0.0, 1.0);
    vec3 src = mix(B.rgb, r, ab);

    // source-over, premultiplied, then back to straight alpha
    vec3  co = src * as + A.rgb * ab * (1.0 - as);
    float ao = as + ab * (1.0 - as);
    fragColor = ao > 1e-5 ? vec4(co / ao, ao) : vec4(0.0);
}
