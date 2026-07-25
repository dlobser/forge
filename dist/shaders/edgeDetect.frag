#version 300 es
// edgeDetect — realtime Sobel edge detection.

precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uColor;
uniform vec2 uResolution;

uniform float uStrength;
uniform float uThreshold;
uniform float uThickness;
uniform float uSoftness;
uniform float uInvert;
uniform float uPreserveColor;

float luminance(vec3 color) {
    return dot(color, vec3(0.299, 0.587, 0.114));
}

void main() {
    vec2 texel = uThickness / max(uResolution, vec2(1.0));

    float tl = luminance(texture(uColor, vUv + texel * vec2(-1.0,  1.0)).rgb);
    float tc = luminance(texture(uColor, vUv + texel * vec2( 0.0,  1.0)).rgb);
    float tr = luminance(texture(uColor, vUv + texel * vec2( 1.0,  1.0)).rgb);

    float ml = luminance(texture(uColor, vUv + texel * vec2(-1.0,  0.0)).rgb);
    float mr = luminance(texture(uColor, vUv + texel * vec2( 1.0,  0.0)).rgb);

    float bl = luminance(texture(uColor, vUv + texel * vec2(-1.0, -1.0)).rgb);
    float bc = luminance(texture(uColor, vUv + texel * vec2( 0.0, -1.0)).rgb);
    float br = luminance(texture(uColor, vUv + texel * vec2( 1.0, -1.0)).rgb);

    float gx =
        -tl + tr +
        -2.0 * ml + 2.0 * mr +
        -bl + br;

    float gy =
         tl + 2.0 * tc + tr +
        -bl - 2.0 * bc - br;

    float edge = length(vec2(gx, gy)) * uStrength;

    edge = smoothstep(
        uThreshold,
        uThreshold + max(uSoftness, 0.0001),
        edge
    );

    if (uInvert > 0.5) {
        edge = 1.0 - edge;
    }

    vec3 result;

    if (uPreserveColor > 0.5) {
        vec3 sourceColor = texture(uColor, vUv).rgb;
        result = sourceColor * edge;
    } else {
        result = vec3(edge);
    }

    fragColor = vec4(result, 1.0);
}