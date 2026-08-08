#version 300 es

precision highp float;

in vec2 vUv;
layout(location = 0) out vec4 outMotion;
layout(location = 1) out vec4 outLife;
layout(location = 2) out vec4 outSpawn;

// Particle state is split across three RGBA32F textures:
//   uState0: position.xy, velocity.xy
//   uState1: picked-up source colour.rgb, age
//   uState2: spawn uv.xy, lifetime, per-particle size factor
uniform sampler2D uState0;
uniform sampler2D uState1;
uniform sampler2D uState2;

uniform sampler2D uImage;
uniform sampler2D uProperties;
uniform sampler2D uDirection;
uniform sampler2D uForce;

uniform vec2 uSimRes;
uniform float uReset;
uniform float uDeltaTime;
uniform float uSeed;

uniform float uSpeed;
uniform float uAngle;
uniform float uSpread;
uniform float uEmission;
uniform float uLifetime;
uniform float uLifetimeVariation;
uniform float uDrag;
uniform float uForceStrength;

const float PI = 3.14159265359;

float hash12(vec2 p)
{
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

vec2 rotate2D(vec2 v, float a)
{
    float c = cos(a);
    float s = sin(a);
    return mat2(c, -s, s, c) * v;
}

void writeDead(vec2 spawnUv)
{
    outMotion = vec4(spawnUv, 0.0, 0.0);
    outLife = vec4(0.0);
    outSpawn = vec4(spawnUv, 0.0, 0.0);
}

void spawnParticle(vec2 id, float randomOffset, bool initialSeed)
{
    vec2 spawnUv = (id + 0.5) / uSimRes;
    vec4 source = texture(uImage, spawnUv);
    vec3 properties = texture(uProperties, spawnUv).rgb;

    // David's suggested RGB property map:
    // R = size, G = speed, B = emission amount.
    float emission = clamp(uEmission * properties.b * source.a, 0.0, 1.0);
    float rEmit = hash12(id + vec2(11.0, 53.0) + uSeed * 1.71 + randomOffset);

    // On reset, B behaves like particle density. Afterwards, inactive particles
    // retry gradually, which makes low emission values feel like emission rate
    // rather than permanently deleting the same particles.
    float chance = initialSeed
    ? emission
    : 1.0 - exp(-emission * 6.0 * max(uDeltaTime, 0.0));

    if (rEmit > chance)
    {
        writeDead(spawnUv);
        return;
    }

    vec2 mapDirection = texture(uDirection, spawnUv).rg * 2.0 - 1.0;
    float mapLength = length(mapDirection);

    float angle = radians(uAngle);
    vec2 direction = vec2(cos(angle), sin(angle));
    if (mapLength > 0.05)
    direction = mapDirection / mapLength;

    float rSpread = hash12(id + vec2(71.0, 19.0) + uSeed * 2.31 + randomOffset * 1.37);
    direction = rotate2D(direction, (rSpread - 0.5) * uSpread * PI);

    float rSpeed = hash12(id + vec2(37.0, 97.0) + uSeed * 0.83 + randomOffset * 2.11);
    float speed = uSpeed * properties.g * mix(0.75, 1.25, rSpeed);

    float rLife = hash12(id + vec2(101.0, 7.0) + uSeed * 3.17 + randomOffset * 0.73);
    float variation = mix(1.0 - uLifetimeVariation, 1.0 + uLifetimeVariation, rLife);
    float lifetime = max(0.01, uLifetime * variation);

    outMotion = vec4(spawnUv, direction * speed);
    outLife = vec4(source.rgb, 0.0);
    outSpawn = vec4(spawnUv, lifetime, properties.r);
}

void main()
{
    ivec2 coord = ivec2(gl_FragCoord.xy);
    vec2 id = vec2(coord);

    if (uReset > 0.5)
    {
        spawnParticle(id, 0.0, true);
        return;
    }

    vec4 motion = texelFetch(uState0, coord, 0);
    vec4 life = texelFetch(uState1, coord, 0);
    vec4 spawn = texelFetch(uState2, coord, 0);

    vec2 position = motion.xy;
    vec2 velocity = motion.zw;
    vec3 colour = life.rgb;
    float age = life.a;
    float lifetime = spawn.z;

    if (lifetime <= 0.0)
    {
        spawnParticle(id, uSeed * 13.0, false);
        return;
    }

    age += uDeltaTime;

    bool outside =
    position.x < -0.05 ||
    position.x > 1.05 ||
    position.y < -0.05 ||
    position.y > 1.05;

    if (age >= lifetime || outside)
    {
        spawnParticle(id, uSeed + 23.0, false);
        return;
    }

    vec2 field = texture(uForce, clamp(position, 0.0, 1.0)).rg * 2.0 - 1.0;
    if (length(field) < 0.01) field = vec2(0.0);
    velocity += field * uForceStrength * uDeltaTime;
    velocity *= exp(-max(0.0, uDrag) * uDeltaTime);
    position += velocity * uDeltaTime;

    outMotion = vec4(position, velocity);
    outLife = vec4(colour, age);
    outSpawn = spawn;
}
