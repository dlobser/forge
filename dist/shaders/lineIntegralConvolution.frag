#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uColor;
uniform vec2 uResolution;

uniform float uSteps;
uniform float uStepSize;
uniform float uContrast;

const int MAX_STEPS = 32;


vec2 decodeField(vec2 uv)
{
    vec2 encodedField = texture(uColor, uv).rg;
    return encodedField * 2.0 - 1.0;
}


float randomNoise(vec2 uv)
{
    vec2 pixel = floor(uv * uResolution);

    return fract(sin(dot(pixel, vec2(127.1, 311.7))) * 43758.5453123);
}


bool outsideImage(vec2 uv)
{
    return uv.x < 0.0 ||
    uv.x > 1.0 ||
    uv.y < 0.0 ||
    uv.y > 1.0;
}


void traceDirection(
        vec2 startUv,
        float directionSign,
        inout float accumulatedNoise,
        inout float accumulatedWeight
)
{
    vec2 currentUv = startUv;

    for (int i = 0; i < MAX_STEPS; i++)
    {
        if (float(i) >= uSteps)
        {
            break;
        }

        vec2 field = decodeField(currentUv);
        float magnitude = length(field);

        if (magnitude < 1e-5)
        {
            break;
        }

        vec2 direction = field / magnitude;
        vec2 pixelStep = direction * directionSign * uStepSize;
        currentUv += pixelStep / uResolution;

        if (outsideImage(currentUv))
        {
            break;
        }

        float progress = (float(i) + 1.0) / max(uSteps, 1.0);

        float weight = 0.5 + 0.5 * cos(progress * 3.14159265359);

        accumulatedNoise += randomNoise(currentUv) * weight;
        accumulatedWeight += weight;
    }
}


void main()
{
    float accumulatedNoise = randomNoise(vUv);
    float accumulatedWeight = 1.0;

    traceDirection(
            vUv,
            1.0,
            accumulatedNoise,
            accumulatedWeight
    );

    traceDirection(
            vUv,
            -1.0,
            accumulatedNoise,
            accumulatedWeight
    );

    float lic = accumulatedNoise / max(accumulatedWeight, 1e-5);

    lic = (lic - 0.5) * uContrast + 0.5;
    lic = clamp(lic, 0.0, 1.0);

    fragColor = vec4(vec3(lic), 1.0);
}