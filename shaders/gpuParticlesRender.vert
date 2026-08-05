#version 300 es

precision highp float;

uniform sampler2D uState;
uniform vec2 uSimRes;
uniform float uPointSize;

void main()
{
    int simWidth = int(uSimRes.x);
    int x = gl_VertexID % simWidth;
    int y = gl_VertexID / simWidth;

    vec2 position = texelFetch(uState, ivec2(x, y), 0).rg;

    vec2 clipPosition = position * 2.0 - 1.0;

    gl_Position = vec4(clipPosition, 0.0, 1.0);
    gl_PointSize = max(1.0, uPointSize);
}