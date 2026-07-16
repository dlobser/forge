#version 300 es
// floodFill — iterative connected-region labeling.
//
// Pass 2:
// Initialize every non-barrier pixel with its own UV label.
//
// Pass 0:
// Propagate the smallest neighboring label through connected regions.
//
// Pass 1:
// Convert labels into stable debug colors.
//
// Simulation state:
//   R,G = region label / seed UV
//   B   = valid region flag
//   A   = 1.0

precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uColor;
uniform sampler2D uState;

uniform vec2 uResolution;
uniform vec2 uSimRes;

uniform float uPass;
uniform float uBarrierThreshold;
uniform float uInvertBarrier;

float luminance(vec3 color) {
  return dot(color, vec3(0.299, 0.587, 0.114));
}

bool isBarrier(float value) {
  if (uInvertBarrier > 0.5) {
    return value <= uBarrierThreshold;
  }

  return value >= uBarrierThreshold;
}

bool isValidLabel(vec4 stateValue) {
  return stateValue.z > 0.5;
}

bool labelLess(vec2 a, vec2 b) {
  if (a.y < b.y) {
    return true;
  }

  if (a.y > b.y) {
    return false;
  }

  return a.x < b.x;
}

float hash12(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

vec3 labelToColor(vec2 label) {
  vec2 pixelLabel = floor(label * uSimRes + 0.5);

  float r = hash12(pixelLabel + vec2(1.23, 4.56));
  float g = hash12(pixelLabel + vec2(7.89, 0.12));
  float b = hash12(pixelLabel + vec2(3.45, 6.78));

  return vec3(r, g, b);
}

void tryCandidate(inout vec2 bestLabel, inout bool hasBest, vec4 candidate) {
  if (!isValidLabel(candidate)) {
    return;
  }

  vec2 candidateLabel = candidate.xy;

  if (!hasBest || labelLess(candidateLabel, bestLabel)) {
    bestLabel = candidateLabel;
    hasBest = true;
  }
}

void main() {
  // ── Pass 2: initialize ─────────────────────────────────────────────────────
  if (uPass > 1.5) {
    float maskValue = luminance(texture(uColor, vUv).rgb);

    if (isBarrier(maskValue)) {
      fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    } else {
      fragColor = vec4(vUv, 1.0, 1.0);
    }

    return;
  }

  // ── Pass 0: propagate labels ───────────────────────────────────────────────
  if (uPass < 0.5) {
    float maskValue = luminance(texture(uColor, vUv).rgb);

    if (isBarrier(maskValue)) {
      fragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }

    vec2 texel = 1.0 / max(uSimRes, vec2(1.0));

    vec2 bestLabel = vec2(0.0);
    bool hasBest = false;

    tryCandidate(bestLabel, hasBest, texture(uState, vUv));

    tryCandidate(bestLabel, hasBest, texture(uState, vUv + texel * vec2(-1.0, 0.0)));

    tryCandidate(bestLabel, hasBest, texture(uState, vUv + texel * vec2(1.0, 0.0)));

    tryCandidate(bestLabel, hasBest, texture(uState, vUv + texel * vec2(0.0, -1.0)));

    tryCandidate(bestLabel, hasBest, texture(uState, vUv + texel * vec2(0.0, 1.0)));

    tryCandidate(bestLabel, hasBest, texture(uState, vUv + texel * vec2(-1.0, -1.0)));

    tryCandidate(bestLabel, hasBest, texture(uState, vUv + texel * vec2(1.0, -1.0)));

    tryCandidate(bestLabel, hasBest, texture(uState, vUv + texel * vec2(-1.0, 1.0)));

    tryCandidate(bestLabel, hasBest, texture(uState, vUv + texel * vec2(1.0, 1.0)));

    if (hasBest) {
      fragColor = vec4(bestLabel, 1.0, 1.0);
    } else {
      fragColor = vec4(vUv, 1.0, 1.0);
    }

    return;
  }

  // ── Pass 1: debug display ──────────────────────────────────────────────────
  vec4 stateValue = texture(uState, vUv);

  if (!isValidLabel(stateValue)) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  fragColor = vec4(labelToColor(stateValue.xy), 1.0);
}
