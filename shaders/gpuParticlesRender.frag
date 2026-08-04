#version 300 es

precision highp float;

out vec4 fragColor;

uniform vec3 uParticleColor;

void main()
{
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float d = dot(p, p);

    if (d > 1.0)
    discard;

    float alpha = smoothstep(1.0, 0.15, d);

    fragColor = vec4(uParticleColor, alpha);
}