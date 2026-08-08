#version 300 es

precision highp float;

in vec3 vColor;
in float vAlpha;
out vec4 fragColor;

void main()
{
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float d = dot(p, p);
    float shape = 1.0 - smoothstep(0.15, 1.0, d);

    fragColor = vec4(vColor, shape * vAlpha);
}