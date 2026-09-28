#version 300 es

precision highp float;

uniform sampler2D uState0;
uniform sampler2D uState1;
uniform sampler2D uState2;
uniform vec2 uSimRes;

uniform float uPointSize;
uniform float uSizeStart;
uniform float uSizeEnd;
uniform vec3 uTint;
uniform vec3 uColorStart;
uniform vec3 uColorEnd;
uniform float uAlphaStart;
uniform float uAlphaEnd;

out vec3 vColor;
out float vAlpha;

void main()
{
    int simWidth = int(uSimRes.x);
    int x = gl_VertexID % simWidth;
    int y = gl_VertexID / simWidth;
    ivec2 coord = ivec2(x, y);

    vec4 motion = texelFetch(uState0, coord, 0);
    vec4 life = texelFetch(uState1, coord, 0);
    vec4 spawn = texelFetch(uState2, coord, 0);

    vec2 position = motion.xy;
    vec3 sourceColor = life.rgb;
    float age = life.a;
    float lifetime = spawn.z;
    float sizeFactor = spawn.w;

    if (lifetime <= 0.0)
    {
        gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
        gl_PointSize = 1.0;
        vColor = vec3(0.0);
        vAlpha = 0.0;
        return;
    }

    float t = clamp(age / max(lifetime, 0.0001), 0.0, 1.0);
    float lifeSize = mix(uSizeStart, uSizeEnd, t);
    vec3 lifeColor = mix(uColorStart, uColorEnd, t);

    vec2 clipPosition = position * 2.0 - 1.0;
    gl_Position = vec4(clipPosition, 0.0, 1.0);
    gl_PointSize = max(1.0, uPointSize * sizeFactor * lifeSize);

    vColor = sourceColor * uTint * lifeColor;
    vAlpha = mix(uAlphaStart, uAlphaEnd, t);
}
