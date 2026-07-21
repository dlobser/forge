#version 300 es
// raymarch — ray-marches a heightfield built directly from the input image.
// Height map brightness at each (x,z) position becomes elevation. A separate
// color input can be sampled onto the ray-marched surface.
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform vec2  uResolution;
uniform sampler2D uColor;
uniform sampler2D uHeightMap;
uniform float uHeightScale;
uniform float uTerrainSize;   // world-space width/depth of the sampled area

uniform float uCamYaw;      // camera orbit angle around the scene, radians
uniform float uCamPitch;    // camera height angle, radians
uniform float uCamDist;     // camera distance from the scene
uniform float uFov;         // vertical field of view, radians

uniform float uLightYaw;
uniform float uLightPitch;

const int MAX_STEPS = 160;
const int REFINE_STEPS = 6;
const float MAX_DIST = 30.0;
const float HIT_EPS = 0.0015;
const float STEP_SCALE = 0.55;

const vec3 LUMA = vec3(0.299, 0.587, 0.114);

// sample the height map as luminance so colored height images also work correctly
float sampleHeight(vec2 uv) {
    vec3 color = texture(uHeightMap, clamp(uv, 0.0, 1.0)).rgb;
    return dot(color, LUMA) * uHeightScale;
}

// signed vertical distance from the heightfield surface. This is not an exact
// Euclidean SDF, so marching uses conservative steps and crossing refinement.
float mapHeightfield(vec3 p) {
    vec2 uv = p.xz / uTerrainSize + 0.5;

    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
        return p.y;   // flat ground outside the sampled image
    }

    return p.y - sampleHeight(uv);
}

// refine the hit position after a marching step crosses the surface
float refineHit(vec3 rayOrigin, vec3 rayDir, float nearT, float farT) {
    float a = nearT;
    float b = farT;

    for (int i = 0; i < REFINE_STEPS; i++) {
        float mid = (a + b) * 0.5;
        float d = mapHeightfield(rayOrigin + rayDir * mid);

        if (d > 0.0) {
            a = mid;
        } else {
            b = mid;
        }
    }

    return (a + b) * 0.5;
}

// surface normal from the gradient of the heightfield distance
vec3 calcNormal(vec3 p) {
    float maxResolution = max(max(uResolution.x, uResolution.y), 1.0);
    float normalEps = max(uTerrainSize / maxResolution, 0.0005);
    vec2 e = vec2(normalEps, 0.0);

    return normalize(vec3(
            mapHeightfield(p + e.xyy) - mapHeightfield(p - e.xyy),
            mapHeightfield(p + e.yxy) - mapHeightfield(p - e.yxy),
            mapHeightfield(p + e.yyx) - mapHeightfield(p - e.yyx)
    ));
}

mat3 lookAtMatrix(vec3 eye, vec3 target, vec3 up) {
    vec3 f = normalize(target - eye);
    vec3 r = normalize(cross(f, up));
    vec3 u = cross(r, f);
    return mat3(r, u, f);
}

void main() {
    vec2 uv = vUv * 2.0 - 1.0;
    uv.x *= uResolution.x / max(uResolution.y, 1.0);

    // orbiting camera, automatically aimed toward the middle of the terrain
    vec3 target = vec3(0.0, uHeightScale * 0.35, 0.0);
    vec3 camPos = target + uCamDist * vec3(
            cos(uCamPitch) * sin(uCamYaw),
            sin(uCamPitch),
            cos(uCamPitch) * cos(uCamYaw)
    );
    mat3 cam = lookAtMatrix(camPos, target, vec3(0.0, 1.0, 0.0));
    float focal = 1.0 / tan(uFov * 0.5);
    vec3 rayDir = cam * normalize(vec3(uv, focal));
    vec3 rayOrigin = camPos;

    // conservative heightfield ray marching with surface-crossing refinement
    float t = 0.0;
    float previousT = 0.0;
    float previousD = mapHeightfield(rayOrigin);
    bool hit = false;

    for (int i = 0; i < MAX_STEPS; i++) {
        vec3 p = rayOrigin + rayDir * t;
        float d = mapHeightfield(p);

        if (abs(d) < HIT_EPS) {
            hit = true;
            break;
        }

        if (d < 0.0 && previousD > 0.0) {
            t = refineHit(rayOrigin, rayDir, previousT, t);
            hit = true;
            break;
        }

        previousT = t;
        previousD = d;

        float stepDistance = max(d * STEP_SCALE, HIT_EPS * 0.5);
        t += stepDistance;

        if (t > MAX_DIST) break;
    }

    vec3 color;
    if (hit) {
        vec3 p = rayOrigin + rayDir * t;
        vec3 n = calcNormal(p);
        vec3 lightDir = normalize(vec3(
                cos(uLightPitch) * sin(uLightYaw),
                sin(uLightPitch),
                cos(uLightPitch) * cos(uLightYaw)
        ));

        float diff = max(dot(n, lightDir), 0.0);
        float ambient = 0.18;
        float shade = ambient + diff * 0.82;

        vec2 surfaceUv = clamp(p.xz / uTerrainSize + 0.5, 0.0, 1.0);
        vec3 baseColor = texture(uColor, surfaceUv).rgb;

        color = baseColor * shade;
    } else {
        // background: simple vertical gradient
        float bg = 0.05 + 0.05 * uv.y;
        color = vec3(bg);
    }

    fragColor = vec4(color, 1.0);
}