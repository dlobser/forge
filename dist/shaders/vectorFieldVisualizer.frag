#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uColor;
uniform vec2 uResolution;

uniform float uMagnitudeScale;
uniform float uGridDensity;
uniform float uArrowSize;
uniform float uArrowThickness;


vec2 decodeField(vec2 uv)
{
    vec2 encodedField = texture(uColor, uv).rg;
    return encodedField * 2.0 - 1.0;
}


float sdSegment(vec2 p, vec2 a, vec2 b)
{
    vec2 pa = p - a;
    vec2 ba = b - a;

    float h = clamp(
            dot(pa, ba) / max(dot(ba, ba), 1e-6),
            0.0,
            1.0
    );

    return length(pa - ba * h);
}


float arrowMask(vec2 localP, float angle, float magnitude)
{
    float presence = smoothstep(0.01, 0.05, magnitude);
    if (presence <= 0.0)
    {
        return 0.0;
    }
    
    float c = cos(angle);
    float s = sin(angle);

    mat2 invRot = mat2(
            c, s,
            -s, c
    );

    vec2 p = invRot * localP;
    float magVis = clamp(magnitude * uMagnitudeScale, 0.0, 1.0);
    float len = mix(0.20, 0.42, magVis) * uArrowSize;

    float thickness = uArrowThickness;
    vec2 shaftA = vec2(-len * 0.55, 0.0);
    vec2 shaftB = vec2( len * 0.25, 0.0);
    
    vec2 tip   = vec2( len * 0.50, 0.0);
    vec2 headA = vec2( len * 0.18,  len * 0.24);
    vec2 headB = vec2( len * 0.18, -len * 0.24);

    float dShaft = sdSegment(p, shaftA, shaftB);
    float dHead1 = sdSegment(p, tip, headA);
    float dHead2 = sdSegment(p, tip, headB);

    float d = min(dShaft, min(dHead1, dHead2));

    float aa = fwidth(d) * 1.5 + 1e-4;

    float mask = 1.0 - smoothstep(
            thickness,
            thickness + aa,
            d
    );

    return mask * presence;
}


void main()
{
    float cells = max(uGridDensity, 1.0);
    
    vec2 gridUv = vUv * cells;
    vec2 cellId = floor(gridUv);
    vec2 localP = fract(gridUv) - 0.5;
    
    vec2 sampleUv = (cellId + 0.5) / cells;
    vec2 field = decodeField(sampleUv);

    float magnitude = length(field);
    float angle = atan(field.y, field.x);

    float mask = arrowMask(localP, angle, magnitude);
    float brightness = clamp(magnitude * uMagnitudeScale, 0.0, 1.0);

    vec3 color = vec3(mask * brightness);

    fragColor = vec4(color, 1.0);
}