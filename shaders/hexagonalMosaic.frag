#version 300 es
// hexagonalMosaic — realtime center-sampled hex mosaic.

precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uColor;
uniform vec2 uResolution;

uniform float uTileSize;
uniform float uEdge;
uniform float uEdgeWidth;
uniform float uMix;

const float SQRT3 = 1.73205080757;

// Approximate nearest hex center in pixel space.
vec2 hexCenter(vec2 p, float r) {
    float w = SQRT3 * r;
    float h = 1.5 * r;

    float row = floor(p.y / h);
    float xOffset = mod(row, 2.0) * 0.5 * w;

    vec2 centerA;
    centerA.y = row * h;
    centerA.x = (floor((p.x - xOffset) / w) + 0.5) * w + xOffset;

    vec2 centerB;
    centerB.y = (row + 1.0) * h;
    float xOffsetB = mod(row + 1.0, 2.0) * 0.5 * w;
    centerB.x = (floor((p.x - xOffsetB) / w) + 0.5) * w + xOffsetB;

    float dA = distance(p, centerA);
    float dB = distance(p, centerB);

    return dA < dB ? centerA : centerB;
}

void main() {
    vec2 uv = vUv;
    vec2 p = uv * uResolution;

    float r = max(uTileSize, 1.0);

    vec2 c = hexCenter(p, r);
    vec2 sampleUV = c / uResolution;
    sampleUV = clamp(sampleUV, vec2(0.0), vec2(1.0));

    vec4 original = texture(uColor, uv);
    vec4 mosaic = texture(uColor, sampleUV);

    // simple hex boundary from distance to center
    float d = distance(p, c);
    float hexRadius = r * 0.95;
    float edgeLine = smoothstep(hexRadius * (1.0 - uEdgeWidth), hexRadius, d);

    if (uEdge > 0.5) {
        mosaic.rgb = mix(mosaic.rgb, vec3(0.03), edgeLine * 0.45);
    }

    fragColor = mix(original, mosaic, uMix);
}