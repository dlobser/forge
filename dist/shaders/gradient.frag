#version 300 es
// gradient — linear & radial gradient with position controls, 2-4 color stops, alpha, & optional distort.
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform vec2      uResolution;
uniform sampler2D uDistort;       // optional: warps the gradient UV coordinates
uniform float     uDistortAmt;

uniform float     uType;         // 0: Linear, 1: Radial
uniform float     uNumStops;     // 0: 2 Colors, 1: 3 Colors, 2: 4 Colors

uniform float     uPoint1X;
uniform float     uPoint1Y;
uniform float     uPoint2X;
uniform float     uPoint2Y;

uniform vec3      uColor1;
uniform float     uAlpha1;
uniform float     uPos1;

uniform vec3      uColor2;
uniform float     uAlpha2;
uniform float     uPos2;

uniform vec3      uColor3;
uniform float     uAlpha3;
uniform float     uPos3;

uniform vec3      uColor4;
uniform float     uAlpha4;
uniform float     uPos4;

uniform float     uExtend;       // 0: Clamp, 1: Repeat, 2: Mirror
uniform float     uAspect;       // 0: Ignore aspect, 1: Correct aspect ratio

struct ColorStop {
    vec4 color;
    float pos;
};

void main() {
    vec2 wuv = vUv;
    if (abs(uDistortAmt) > 0.0001) {
        vec3 W = vec3(0.299, 0.587, 0.114);
        vec2 ge = 1.5 / uResolution;
        float gx = dot(texture(uDistort, vUv + vec2(ge.x, 0.0)).rgb, W) - dot(texture(uDistort, vUv - vec2(ge.x, 0.0)).rgb, W);
        float gy = dot(texture(uDistort, vUv + vec2(0.0, ge.y)).rgb, W) - dot(texture(uDistort, vUv - vec2(0.0, ge.y)).rgb, W);
        wuv += vec2(gx, gy) * uDistortAmt;
    }

    float aspect = uAspect > 0.5 ? (uResolution.x / max(uResolution.y, 1.0)) : 1.0;

    vec2 p  = wuv * vec2(aspect, 1.0);
    vec2 p1 = vec2(uPoint1X, uPoint1Y) * vec2(aspect, 1.0);
    vec2 p2 = vec2(uPoint2X, uPoint2Y) * vec2(aspect, 1.0);

    float t = 0.0;
    vec2 dir = p2 - p1;

    if (uType < 0.5) {
        // Linear gradient
        float lenSq = dot(dir, dir);
        if (lenSq > 1e-7) {
            t = dot(p - p1, dir) / lenSq;
        }
    } else {
        // Radial gradient
        float r = length(dir);
        if (r > 1e-5) {
            t = length(p - p1) / r;
        }
    }

    // Gradient extension mode
    if (uExtend < 0.5) {
        t = clamp(t, 0.0, 1.0);
    } else if (uExtend < 1.5) {
        t = fract(t);
    } else {
        t = 1.0 - abs(mod(t, 2.0) - 1.0);
    }

    // Set up color stops
    ColorStop stops[4];
    int count = 2;
    stops[0] = ColorStop(vec4(uColor1, uAlpha1), uPos1);
    stops[1] = ColorStop(vec4(uColor2, uAlpha2), uPos2);

    if (uNumStops > 0.5) {
        stops[2] = ColorStop(vec4(uColor3, uAlpha3), uPos3);
        count = 3;
    }
    if (uNumStops > 1.5) {
        stops[3] = ColorStop(vec4(uColor4, uAlpha4), uPos4);
        count = 4;
    }

    // Sort stops by position using bubble sort
    for (int i = 0; i < 3; i++) {
        for (int j = 0; j < 3; j++) {
            if (j < count - 1) {
                if (stops[j].pos > stops[j + 1].pos) {
                    ColorStop tmp = stops[j];
                    stops[j] = stops[j + 1];
                    stops[j + 1] = tmp;
                }
            }
        }
    }

    // Interpolate color along sorted stops
    vec4 result = stops[0].color;
    if (t <= stops[0].pos) {
        result = stops[0].color;
    } else if (t >= stops[count - 1].pos) {
        result = stops[count - 1].color;
    } else {
        for (int i = 0; i < 3; i++) {
            if (i < count - 1) {
                if (t >= stops[i].pos && t <= stops[i + 1].pos) {
                    float range = max(stops[i + 1].pos - stops[i].pos, 1e-5);
                    float f = clamp((t - stops[i].pos) / range, 0.0, 1.0);
                    result = mix(stops[i].color, stops[i + 1].color, f);
                    break;
                }
            }
        }
    }

    fragColor = result;
}
