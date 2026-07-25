#version 300 es
// key — Chroma & Luma keying with sample position picking, threshold, softness, expand/choke, despill, and compositing.
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform vec2      uResolution;
uniform sampler2D uColor;         // Main foreground image
uniform sampler2D uBg;            // Optional background image

uniform float     uMode;          // 0: Chroma RGB, 1: Chroma Screen, 2: Luma Key
uniform float     uOutput;        // 0: Keyed RGBA, 1: Alpha Mask, 2: Composite
uniform float     uUsePickPos;    // 0: Manual Key Color, 1: Sample at Pick X/Y
uniform float     uPickX;
uniform float     uPickY;
uniform vec3      uKeyColor;
uniform float     uThreshold;
uniform float     uSoftness;
uniform float     uExpand;        // Expand (+) or Choke (-) in pixels
uniform float     uDespill;       // Spill suppression (0 to 1)
uniform float     uInvert;
uniform vec3      uBgColor;

// Convert RGB to YCbCr
vec3 rgb2ycbcr(vec3 c) {
    float y  = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
    float cb = -0.168736 * c.r - 0.331264 * c.g + 0.5 * c.b + 0.5;
    float cr = 0.5 * c.r - 0.418688 * c.g - 0.081312 * c.b + 0.5;
    return vec3(y, cb, cr);
}

// Calculate distance between sample RGB and target key RGB based on mode
float calcKeyDistance(vec3 rgb, vec3 targetKey) {
    if (uMode < 0.5) {
        // Chroma (RGB distance)
        return length(rgb - targetKey) / 1.7320508;
    } else if (uMode < 1.5) {
        // Chroma (Screen / YCbCr Chrominance distance)
        vec3 yuvSample = rgb2ycbcr(rgb);
        vec3 yuvKey    = rgb2ycbcr(targetKey);
        return length(yuvSample.yz - yuvKey.yz) / 0.70710678;
    } else {
        // Luma Key (Luminance difference)
        float lumaSample = dot(rgb, vec3(0.299, 0.587, 0.114));
        float lumaKey    = dot(targetKey, vec3(0.299, 0.587, 0.114));
        return abs(lumaSample - lumaKey);
    }
}

// Raw matte value (0 = keyed out, 1 = kept) from distance
float rawMatte(float dist) {
    float soft = max(uSoftness, 0.0001);
    float m = smoothstep(uThreshold, uThreshold + soft, dist);
    if (uInvert > 0.5) m = 1.0 - m;
    return m;
}

void main() {
    vec4 fgTex = texture(uColor, vUv);
    vec3 fgRgb = fgTex.rgb;

    // Resolve target key color (manual or sampled at Pick X/Y)
    vec3 keyCol = uKeyColor;
    if (uUsePickPos > 0.5) {
        keyCol = texture(uColor, vec2(uPickX, uPickY)).rgb;
    }

    // Base key distance at current pixel
    float dist = calcKeyDistance(fgRgb, keyCol);
    float m = rawMatte(dist);

    // Expand / Choke (Dilation / Erosion)
    if (abs(uExpand) > 0.01) {
        vec2 texel = (1.0 / uResolution) * abs(uExpand);
        float extremeM = m;

        for (int x = -1; x <= 1; x++) {
            for (int y = -1; y <= 1; y++) {
                if (x == 0 && y == 0) continue;
                vec2 sampleUv = vUv + vec2(float(x), float(y)) * texel;
                vec3 sampleRgb = texture(uColor, sampleUv).rgb;
                float dSample = calcKeyDistance(sampleRgb, keyCol);
                float mSample = rawMatte(dSample);

                if (uExpand > 0.0) {
                    extremeM = max(extremeM, mSample); // Dilate (expand opaque)
                } else {
                    extremeM = min(extremeM, mSample); // Erode (choke opaque)
                }
            }
        }
        m = extremeM;
    }

    // Despill / Spill suppression for chroma keying
    if (uDespill > 0.001 && uMode < 1.5) {
        if (keyCol.g > keyCol.r && keyCol.g > keyCol.b) {
            // Green screen despill
            float maxOther = max(fgRgb.r, fgRgb.b);
            if (fgRgb.g > maxOther) {
                fgRgb.g = mix(fgRgb.g, maxOther, uDespill);
            }
        } else if (keyCol.b > keyCol.r && keyCol.b > keyCol.g) {
            // Blue screen despill
            float maxOther = max(fgRgb.r, fgRgb.g);
            if (fgRgb.b > maxOther) {
                fgRgb.b = mix(fgRgb.b, maxOther, uDespill);
            }
        } else {
            // General color despill towards key color
            vec3 despilled = fgRgb - keyCol * clamp(1.0 - dist, 0.0, 1.0) * uDespill;
            fgRgb = max(despilled, vec3(0.0));
        }
    }

    // Output mode selection
    if (uOutput < 0.5) {
        // Keyed RGBA
        fragColor = vec4(fgRgb, m * fgTex.a);
    } else if (uOutput < 1.5) {
        // Alpha Mask
        fragColor = vec4(vec3(m), 1.0);
    } else {
        // Composite onto background
        vec4 bgTex = texture(uBg, vUv);
        vec3 bgRgb = mix(uBgColor, bgTex.rgb, bgTex.a);
        vec3 compositeRgb = mix(bgRgb, fgRgb, m);
        fragColor = vec4(compositeRgb, 1.0);
    }
}
