#version 300 es
// Wilson-Cowan V1 Orientation Field simulation.
// Maps a 16-orientation simulation onto a packed 4x4 grid of 2D tiles
// within a single standard 2D float texture.
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uColor; // Image A -> External spatial drive
uniform sampler2D uDepth; // Image B -> Nu modulation (optional)
uniform sampler2D uState; // packed 4x4 simulation state texture
uniform vec2 uResolution; // screen size in display pass, simSize in step/seed pass
uniform float uPass;      // 0 step, 1 display, 2 seed
uniform float uTime;      // noise seed and animations

// Control parameters from JS configuration
uniform float uDt;
uniform float uAlpha;
uniform float uMu;
uniform float uNu;
uniform float uRho;
uniform float uDrive;
uniform float uDriveImage;
uniform float uNuDepth;
uniform float uNoise;
uniform float uBeta;
uniform float uTheta;

// Local Orientation Kernel
uniform float uLocalExcAmp;
uniform float uLocalExcWidth;
uniform float uLocalInhAmp;
uniform float uLocalInhWidth;
uniform float uLocalShift;

// Lateral Kernel
uniform float uLateralExcAmp;
uniform float uLateralExcSigma;
uniform float uLateralInhAmp;
uniform float uLateralInhSigma;
uniform float uLateralRadius;
uniform float uLateralShift;

// Perpendicular Kernel
uniform float uPerpExcAmp;
uniform float uPerpExcSigma;
uniform float uPerpInhAmp;
uniform float uPerpInhSigma;
uniform float uPerpRadius;
uniform float uPerpShift;

// Display parameters
uniform float uExposure;
uniform float uOsiScale;
uniform float uDisplayMode;

const float PI = 3.14159265358979323846;
const float HALF_PI = 1.5707963267948966;
const float EPSILON = 1e-9;

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

float sigmoid(float a) {
    float x = clamp(uBeta * (a - uTheta), -50.0, 50.0);
    return 1.0 / (1.0 + exp(-x));
}

float gaussian(float x, float sigma) {
    float width = max(abs(sigma), 0.000001);
    return exp(-(x * x) / (2.0 * width * width));
}

float effectiveInhibition(float excitation, float inhibition) {
    return min(max(inhibition, 0.0), max(excitation * 0.95, 0.0));
}

float rawMexicanHat(float x, float shift, float excAmp, float excSigma, float inhAmp, float inhSigma) {
    float d = x - shift;
    float cappedInh = effectiveInhibition(excAmp, inhAmp);
    return excAmp * gaussian(d, excSigma) - cappedInh * gaussian(d, inhSigma);
}

float computeLocalNorm(float shift, float excAmp, float excSigma, float inhAmp, float inhSigma) {
    float peak = 0.000001;
    float xMin = -PI * 0.5;
    float xMax = PI * 0.5;
    for (int i = 0; i < 64; i++) {
        float t = float(i) / 63.0;
        float x = xMin + (xMax - xMin) * t;
        float val = rawMexicanHat(x, shift, excAmp, excSigma, inhAmp, inhSigma);
        peak = max(peak, val);
    }
    return peak;
}

float computeLateralNorm(float shift, float excAmp, float excSigma, float inhAmp, float inhSigma, int radius) {
    float peak = 0.000001;
    float xMin = -float(radius);
    float xMax = float(radius);
    int samples = radius * 8 + 1;
    for (int i = 0; i <= 150; i++) {
        if (i > samples) break;
        float t = float(i) / float(samples - 1);
        float x = xMin + (xMax - xMin) * t;
        float val = rawMexicanHat(x, shift, excAmp, excSigma, inhAmp, inhSigma);
        peak = max(peak, val);
    }
    return peak;
}

float hash(vec2 p) {
    p = fract(p * vec2(127.1, 311.7));
    p += dot(p, p + 34.56);
    return fract(p.x * p.y);
}

// Convert HSV to RGB
vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

vec3 heatColor(float t) {
    vec3 dark = vec3(14.0, 18.0, 19.0) / 255.0;
    vec3 teal = vec3(43.0, 118.0, 122.0) / 255.0;
    vec3 gold = vec3(244.0, 196.0, 74.0) / 255.0;
    if (t < 0.62) {
        return mix(dark, teal, clamp(t / 0.62, 0.0, 1.0));
    }
    return mix(teal, gold, clamp((t - 0.62) / 0.38, 0.0, 1.0));
}

int wrapInt(int value, int size) {
    int wrapped = value % size;
    return wrapped < 0 ? wrapped + size : wrapped;
}

// Read activity from packed 4x4 tiles
float readActivity(int x, int y, int orientation, int gridSize) {
    int tileX = orientation % 4;
    int tileY = orientation / 4;
    int wx = wrapInt(x, gridSize);
    int wy = wrapInt(y, gridSize);
    return texelFetch(uState, ivec2(tileX * gridSize + wx, tileY * gridSize + wy), 0).r;
}

// Bilinear interpolation wrapper over packed tiles
float bilinearFiring(int layer, vec2 coord, int gridSize) {
    vec2 wrapped = mod(coord, vec2(float(gridSize)));
    wrapped += vec2(wrapped.x < 0.0 ? float(gridSize) : 0.0, wrapped.y < 0.0 ? float(gridSize) : 0.0);
    ivec2 p0 = ivec2(floor(wrapped));
    ivec2 p1 = ivec2((p0.x + 1) % gridSize, (p0.y + 1) % gridSize);
    vec2 t = fract(wrapped);

    float a00 = sigmoid(readActivity(p0.x, p0.y, layer, gridSize));
    float a10 = sigmoid(readActivity(p1.x, p0.y, layer, gridSize));
    float a01 = sigmoid(readActivity(p0.x, p1.y, layer, gridSize));
    float a11 = sigmoid(readActivity(p1.x, p1.y, layer, gridSize));
    return mix(mix(a00, a10, t.x), mix(a01, a11, t.x), t.y);
}

void main() {
    // Determine grid size from current simulation texture
    ivec2 simSize = textureSize(uState, 0);
    int gridSize = simSize.x / 4;
    if (gridSize <= 0) gridSize = 128; // fallback protection

    // ---- SEED PASS ----
    if (uPass > 1.5) {
        ivec2 ic = ivec2(gl_FragCoord.xy);
        int x = ic.x % gridSize;
        int y = ic.y % gridSize;
        int tileX = ic.x / gridSize;
        int tileY = ic.y / gridSize;
        int orientation = tileY * 4 + tileX;

        // Map to visual drive image coordinates
        vec2 uv = (vec2(x, y) + 0.5) / float(gridSize);
        float imgVal = luma(texture(uColor, uv).rgb);
        
        // Add random gaussian-like noise centered around threshold
        float noise = (hash(vec2(ic) + uTime) - 0.5) * 0.22;
        float seedVal = uTheta + noise;
        if (imgVal > 0.01) {
            seedVal += imgVal * 0.5;
        }
        
        fragColor = vec4(max(0.0, seedVal), 0.0, 0.0, 1.0);
        return;
    }

    // ---- DISPLAY PASS ----
    if (abs(uPass - 1.0) < 0.1) {
        if (uDisplayMode < 0.5) {
            // Heatmap mode (mean firing rate)
            int x = int(vUv.x * float(gridSize));
            int y = int(vUv.y * float(gridSize));
            float mean = 0.0;
            for (int k = 0; k < 16; k++) {
                mean += sigmoid(readActivity(x, y, k, gridSize));
            }
            mean /= 16.0;
            float t = clamp(1.0 - exp(-mean * uExposure), 0.0, 1.0);
            fragColor = vec4(heatColor(t), 1.0);
        }
        else if (uDisplayMode < 1.5) {
            // Neuroscience V1 Optical Imaging Map
            int x = int(vUv.x * float(gridSize));
            int y = int(vUv.y * float(gridSize));
            vec2 orientVec = vec2(0.0);
            float totalFiring = 0.0;
            for (int k = 0; k < 16; k++) {
                float phi = float(k) * PI / 16.0;
                float firing = sigmoid(readActivity(x, y, k, gridSize));
                orientVec += firing * vec2(cos(2.0 * phi), sin(2.0 * phi));
                totalFiring += firing;
            }
            float osi = length(orientVec) / max(totalFiring, 0.0001);
            float prefAngle = 0.5 * atan(orientVec.y, orientVec.x);
            float hue = (prefAngle + HALF_PI) / PI;
            hue = fract(hue);
            vec3 col = hsv2rgb(vec3(hue, clamp(osi * uOsiScale, 0.0, 1.0), clamp(totalFiring * uExposure / 16.0, 0.0, 1.0)));
            fragColor = vec4(col, 1.0);
        }
        else {
            // Raw 4x4 packed texture mode
            fragColor = vec4(texture(uState, vUv).rgb, 1.0);
        }
        return;
    }

    // ---- STEP PASS ----
    ivec2 ic = ivec2(gl_FragCoord.xy);
    int x = ic.x % gridSize;
    int y = ic.y % gridSize;
    int tileX = ic.x / gridSize;
    int tileY = ic.y / gridSize;
    int orientation = tileY * 4 + tileX;

    float a = readActivity(x, y, orientation, gridSize);

    // Convert degrees to radians for Mexican hat calculations
    float localExcWidthRad = uLocalExcWidth * PI / 180.0;
    float localInhWidthRad = uLocalInhWidth * PI / 180.0;
    float localShiftRad = uLocalShift * PI / 180.0;

    // Normalizations computed on the fly on GPU
    float localNorm = computeLocalNorm(localShiftRad, uLocalExcAmp, localExcWidthRad, uLocalInhAmp, localInhWidthRad);
    float lateralNorm = computeLateralNorm(uLateralShift, uLateralExcAmp, uLateralExcSigma, uLateralInhAmp, uLateralInhSigma, int(uLateralRadius));
    float perpNorm = computeLateralNorm(uPerpShift, uPerpExcAmp, uPerpExcSigma, uPerpInhAmp, uPerpInhSigma, int(uPerpRadius));

    // 1. Local hypercolumn coupling
    float local = 0.0;
    float phi = float(orientation) * PI / 16.0;
    for (int kp = 0; kp < 16; kp++) {
        float phip = float(kp) * PI / 16.0;
        float dphi = mod(phip - phi + PI * 1.5, PI) - PI * 0.5;
        float weight = rawMexicanHat(dphi, localShiftRad, uLocalExcAmp, localExcWidthRad, uLocalInhAmp, localInhWidthRad) / max(localNorm, 0.000001);
        local += weight * sigmoid(readActivity(x, y, kp, gridSize)) * (PI / 16.0);
    }

    // 2. Long-range lateral and perpendicular coupling
    float lateral = 0.0;
    float perpendicular = 0.0;
    vec2 direction = vec2(cos(phi), sin(phi));
    vec2 perpDirection = vec2(-sin(phi), cos(phi));
    
    int latRad = int(uLateralRadius);
    int perpRad = int(uPerpRadius);
    
    // Bounds restricted to max 18 to support static loop unrolling in standard GLSL ES 3.0
    for (int s = -18; s <= 18; s++) {
        if (s != 0) {
            float sf = float(s);
            if (abs(s) <= latRad) {
                float weight = rawMexicanHat(sf, uLateralShift, uLateralExcAmp, uLateralExcSigma, uLateralInhAmp, uLateralInhSigma) / max(lateralNorm, 0.000001);
                lateral += weight * bilinearFiring(orientation, vec2(x, y) + sf * direction, gridSize);
            }
            if (abs(s) <= perpRad) {
                float weight = rawMexicanHat(sf, uPerpShift, uPerpExcAmp, uPerpExcSigma, uPerpInhAmp, uPerpInhSigma) / max(perpNorm, 0.000001);
                perpendicular += weight * bilinearFiring(orientation, vec2(x, y) + sf * perpDirection, gridSize);
            }
        }
    }

    // Visual external drive from Image A (uColor)
    vec2 uv = (vec2(x, y) + 0.5) / float(gridSize);
    float imgDrive = luma(texture(uColor, uv).rgb);
    float totalDrive = uDrive + uDriveImage * imgDrive;

    // Spatial connection modulation from Image B (uDepth)
    float depthVal = luma(texture(uDepth, uv).rgb);
    float modulatedNu = uNu * mix(1.0, depthVal, uNuDepth);

    float dA = -uAlpha * a + uMu * local + modulatedNu * lateral + uRho * perpendicular + totalDrive;
    
    // Symmetric noise addition
    float noiseVal = uNoise * (hash(vec2(ic) + vec2(uTime, uTime * 1.5)) * 2.0 - 1.0);
    
    float nextVal = clamp(a + uDt * dA + noiseVal, 0.0, 8.0);
    fragColor = vec4(nextVal, 0.0, 0.0, 1.0);
}
