#version 300 es
// Depth Edges — a Laplacian edge detector run on the DEPTH image, blended back
// over the COLOR image. uEdgeMix slides from pure color (0) to pure edges (1).
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uColor;     // original image
uniform sampler2D uDepth;     // depth map
uniform vec2  uResolution;
uniform float uEdgeMix;       // 0 = color, 1 = edges
uniform float uEdgeScale;     // edge gain
uniform float uThreshold;     // soft cutoff
uniform vec3  uEdgeColor;     // tint of the edges

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

float depthAt(vec2 uv) { return luma(texture(uDepth, uv).rgb); }

void main() {
    vec2 texel = 1.0 / uResolution;
    // 8-neighbour Laplacian on the depth map
    float c = depthAt(vUv);
    float lap =
          depthAt(vUv + texel * vec2(-1.0, -1.0))
        + depthAt(vUv + texel * vec2( 0.0, -1.0))
        + depthAt(vUv + texel * vec2( 1.0, -1.0))
        + depthAt(vUv + texel * vec2(-1.0,  0.0))
        + depthAt(vUv + texel * vec2( 1.0,  0.0))
        + depthAt(vUv + texel * vec2(-1.0,  1.0))
        + depthAt(vUv + texel * vec2( 0.0,  1.0))
        + depthAt(vUv + texel * vec2( 1.0,  1.0))
        - 8.0 * c;

    float edge = abs(lap) * uEdgeScale;
    edge = smoothstep(uThreshold, uThreshold + 0.15, edge);

    vec3 color = texture(uColor, vUv).rgb;
    vec3 edges = uEdgeColor * edge;
    fragColor = vec4(mix(color, edges, uEdgeMix), 1.0);
}
