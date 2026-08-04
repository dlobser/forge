#version 300 es

precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uState;

uniform float uReset;
uniform float uDeltaTime;
uniform float uSpeed;
uniform float uSpread;
uniform float uSeed;

float hash12(vec2 p)
{
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

vec4 spawnParticle(vec2 id)
{
    float r0 = hash12(id + vec2(17.0, 41.0) + uSeed);
    float r1 = hash12(id + vec2(73.0, 11.0) + uSeed * 1.37);
    float r2 = hash12(id + vec2(29.0, 97.0) + uSeed * 2.11);

    float angle = r0 * 6.28318530718;
    vec2 direction = vec2(cos(angle), sin(angle));

    vec2 position = vec2(0.5);
    position += direction * (r1 - 0.5) * 0.025 * uSpread;

    vec2 velocity = direction * uSpeed;
    velocity *= mix(0.45, 1.0, r2);

    return vec4(position, velocity);
}

void main()
{
    vec2 id = floor(gl_FragCoord.xy);

    if (uReset > 0.5)
    {
        fragColor = spawnParticle(id);
        return;
    }

    vec4 state = texelFetch(uState, ivec2(id), 0);

    vec2 position = state.rg;
    vec2 velocity = state.ba;

    position += velocity * uDeltaTime;

    bool outside =
    position.x < -0.05 ||
    position.x > 1.05 ||
    position.y < -0.05 ||
    position.y > 1.05;

    if (outside)
    {
        fragColor = spawnParticle(id + vec2(uSeed + 13.0));
        return;
    }

    fragColor = vec4(position, velocity);
}