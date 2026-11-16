import * as THREE from 'three';
import { AudioInput } from './audio.js';
import { NB, isKick, tension } from './features.js';
import { initUI } from './ui.js';

// The Remnant: a luminous supernova-style cloud on black, all computed in the vertex shader.
//   SHELL     a bumpy skin whose bulges are the spectrum: 48 bands wrap round it (bass left, treble right on the front, mirrored behind), each with its own colour
//   VOLUME    fine specks of the same colours swirling inside the shell, faster at the core
//   CORE      a hot white heart that swells with loudness; every kick sends a shockwave through the cloud
//   EJECTA    debris thrown off by kicks, cooling from white to ember as it flies
// A gap in the beat makes the cloud collapse and spin up; the kick that ends the gap (the drop) detonates it.
// The CPU only sends 48 band levels and a few clocks per frame.
const N = 1500000;
const CONFIG = {
  fov: 30,
  curve: 1.15,          // level contrast: higher = quiet bands stay quiet
  liveTauIn: 0.3, liveTauOut: 0.8,
  kickAt: 0.6,          // bass level that counts as a kick
  kickRise: 0.1,        // and how far it must jump in one frame
  kickCool: 0.35,       // seconds between shockwaves
  shockSpeed: 2.4,      // shockwave radius growth, units per second
  idleShock: 6.5,       // seconds between ghost shockwaves in silence
  dropAt: 0.5,          // tension (see features.js) above which the next kick is a detonation: 0.5 = a 3 s gap in the beat
};

const VS = `
attribute vec4 a_i;     // unused, kind (random), random depth, random
attribute vec4 a_d;     // unit direction, seed
uniform float u_lv[${NB}];
uniform mat3 u_rot;
uniform vec3 u_shape;
uniform vec2 u_off;
uniform float u_time, u_swirlT, u_shockR, u_shockA, u_jolt, u_dens, u_rms, u_chaos, u_sc, u_size, u_dof, u_camDist;
uniform float u_charge, u_swell, u_flash;   // collapse 0..1, shell radius factor, detonation flash
uniform float u_ejT[4], u_ejP[4], u_ejS[4]; // four ejecta bursts: age in seconds, power, pattern seed
uniform vec3 u_ptr;                         // pointer on screen (clip xy) and how strongly it pulls (z)
uniform float u_asp;
varying float v_a;
varying vec3 v_c;
float h11(float n){return fract(sin(n*127.1)*43758.5453);}
float vn(vec3 p){
  vec3 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  float n=i.x+i.y*57.0+i.z*113.0;
  return mix(mix(mix(h11(n),h11(n+1.0),f.x),mix(h11(n+57.0),h11(n+58.0),f.x),f.y),
             mix(mix(h11(n+113.0),h11(n+114.0),f.x),mix(h11(n+170.0),h11(n+171.0),f.x),f.y),f.z);
}
float fbm(vec3 p){return 0.55*vn(p)+0.3*vn(p*2.1+3.3)+0.15*vn(p*4.3+9.1);}
vec3 ry(vec3 p,float a){float c=cos(a),s=sin(a);return vec3(c*p.x+s*p.z,p.y,-s*p.x+c*p.z);}
float tri(float x){return abs(fract(x)-0.5)*4.0-1.0;}
// Band position 0..1 for a direction: bass on the left of the front face, treble on the right, mirrored on the back.
float bandPos(vec3 d){
  vec3 w=d+(vec3(vn(d*2.0+u_time*0.05),vn(d*2.0+5.1),vn(d*2.0+9.7))-0.5)*0.5*u_chaos;   // warped, so the colours flow instead of forming wedges
  return abs(2.0*(atan(w.z,-w.x)/6.2831853+0.5)-1.0);
}
float levelAt(float x){
  float bf=x*${NB - 1}.0; int i0=int(floor(bf)); int i1=min(i0+1,${NB - 1});
  return mix(u_lv[i0],u_lv[i1],fract(bf));
}
vec3 pal(float x){   // bass red, then orange, yellow, green, cyan, blue, violet
  float t=clamp(x,0.0,1.0)*6.0;
  vec3 a=vec3(1.0,0.10,0.07), b=vec3(1.0,0.5,0.06), c=vec3(1.0,0.9,0.22), d=vec3(0.12,0.9,0.4), e=vec3(0.08,0.75,1.0), f=vec3(0.22,0.28,1.0), g=vec3(0.78,0.18,1.0);
  return t<1.0?mix(a,b,t):t<2.0?mix(b,c,t-1.0):t<3.0?mix(c,d,t-2.0):t<4.0?mix(d,e,t-3.0):t<5.0?mix(e,f,t-4.0):mix(f,g,t-5.0);
}
vec3 bb(float h){    // glowing-metal colours by heat: 1 white, then yellow, orange, 0 dull red
  return h>0.75?mix(vec3(1.0,0.85,0.4),vec3(1.0),(h-0.75)*4.0):h>0.45?mix(vec3(1.0,0.42,0.08),vec3(1.0,0.85,0.4),(h-0.45)/0.3):mix(vec3(0.5,0.04,0.02),vec3(1.0,0.42,0.08),h/0.45);
}
float shellR(vec3 dir,float lv,float off){
  float n=fbm(dir*1.8+off+vec3(0.0,u_time*0.04,0.0));
  float ridge=1.0-abs(2.0*vn(dir*5.0+off+u_time*0.03)-1.0);   // thin folds, like the contour lines of a remnant
  float lump=vn(dir*3.5+off+vec3(u_time*0.05,3.0,1.0)); lump*=lump;
  return 0.62*(0.65+0.9*n)+0.09*ridge*u_chaos+0.3*lump*(0.4+lv)+lv*(0.3+0.9*lv);
}
void main(){
  float seed=a_d.w, kind=a_i.y;
  vec3 dir=a_d.xyz, p; vec3 col; float alpha, size, hotness=0.0, keep=1.0;

  if(kind<0.93){
    // OUTER SHELL (<0.3), INNER SHELL (<0.38) and VOLUME (the rest): fine specks.
    float depth=1.0, off=0.0, boost=1.0;
    if(kind>=0.38){
      depth=pow(a_i.z,0.6); dir=ry(dir,u_swirlT*0.7/(0.3+depth));   // inner wisps turn faster than the rim
    } else if(kind>=0.3){
      depth=0.58; off=7.0; boost=0.8;
    }
    float x=bandPos(dir), lv=levelAt(x);
    float ridge=1.0-abs(2.0*vn(dir*5.0+off+u_time*0.03)-1.0);
    float R=shellR(dir,lv,off);
    R*=depth*(1.0+(seed-0.5)*0.05)*u_swell;
    p=dir*R;
    col=pal(pow(x,0.85));
    float lit=0.25+1.1*lv+0.9*lv*lv;                              // quiet bands stay dim, loud ones blaze: that is how the spectrum reads
    alpha=0.42*boost*lit*(0.7+0.6*ridge*(kind<0.3?1.0:0.0))*(0.8+0.5*u_dens);
    size=0.95+1.0*seed;
    hotness=lv*lv*0.3;
  } else if(kind<0.97){
    // EJECTA: debris thrown from the core by a kick. It slows as it flies and cools: white, yellow, orange, red, gone.
    int s=min(int(a_i.w*4.0),3);
    float age=u_ejT[s], pw=u_ejP[s];
    vec3 nd=normalize(dir);
    float sp=(0.25+1.2*vn(nd*4.0+u_ejS[s]))*(0.6+0.4*seed);   // faster in some directions, so it leaves in plumes, not as a ball
    p=nd*(0.06+sp*(0.45+1.1*pw)*(1.0-exp(-age*1.4)));       // on the drop it outruns the shell
    float heat=exp(-age*(0.6+0.9*seed));
    col=bb(heat);
    alpha=(0.5+0.9*pw)*heat*step(0.001,pw);
    size=1.8+1.8*seed;
    keep=0.0;                                                 // the shockwave must not bleach the heat colours
  } else {
    // CORE: a hot heart that swells with the music, tightens and whitens as the cloud collapses, and bursts on the drop.
    float rc=pow(a_i.z,1.7)*(0.05+0.1*u_rms)*(1.0-0.5*u_charge+3.0*u_flash);
    p=dir*rc;
    col=mix(vec3(1.0,0.78,0.45),vec3(1.0),max(0.5+0.5*a_i.z,u_charge));
    alpha=0.12+0.16*u_rms+0.35*u_charge;
    size=1.1+1.0*seed;
    hotness=0.3;
  }

  p=u_rot*(p*u_shape);
  float rad=length(p);
  float dR=rad-u_shockR;
  float pulse=exp(-dR*dR*25.0)*u_shockA;                      // kick shockwave: shoves the cloud outward and lights it up
  float wake=dR<0.0?exp(dR*3.0)*u_shockA:0.0;                 // what the front has crossed keeps glowing for a moment
  p*=1.0+0.1*pulse;
  hotness+=pulse+0.6*u_flash;
  p*=u_sc;

  vec4 mv=modelViewMatrix*vec4(p,1.0);
  gl_Position=projectionMatrix*mv;
  gl_Position.xy+=u_off*gl_Position.w;
  vec2 pd=u_ptr.xy-gl_Position.xy/gl_Position.w, pa=pd*vec2(u_asp,1.0);   // gravity well under the pointer: nearby dust is drawn toward it
  gl_Position.xy+=pd*0.4*exp(-dot(pa,pa)*14.0)*u_ptr.z*gl_Position.w;
  float coc=abs(-mv.z-u_camDist)*u_dof;                       // depth of field: out-of-focus specks are bigger and fainter
  float ps=size*u_size*(1.0+3.0*coc);
  gl_PointSize=max(ps,1.0);                                   // below one pixel a speck cannot get smaller, so it gets fainter instead
  v_a=alpha*(1.0+1.2*pulse+0.5*wake+1.5*u_flash)/(1.0+2.0*coc)*min(1.0,ps*0.9);
  v_c=mix(col,vec3(1.0),clamp(hotness,0.0,0.8)*keep);
}`;

const FS = `
precision highp float;
varying float v_a;
varying vec3 v_c;
void main(){
  vec2 c=gl_PointCoord-0.5;
  float d=sqrt(dot(c,c))*2.0;
  if(d>1.0) discard;
  gl_FragColor=vec4(v_c,v_a*(1.0-smoothstep(0.55,1.0,d)));
}`;

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
renderer.setClearColor(0x05060a, 1);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(CONFIG.fov, 1, 0.1, 40);   // far enough for the stars on the other side of the cloud
const camDist = 1 / Math.tan((CONFIG.fov * Math.PI) / 360) * 0.95;

// Per-speck constants, written once: what kind of speck it is, and its direction from the centre.
const iData = new Float32Array(N * 4), dData = new Float32Array(N * 4);
const gauss = () => Math.sqrt(-2 * Math.log(Math.random() + 1e-9)) * Math.cos(6.2832 * Math.random());
for (let i = 0; i < N; i++) {
  iData[i * 4] = 0; iData[i * 4 + 1] = Math.random();
  iData[i * 4 + 2] = Math.random(); iData[i * 4 + 3] = Math.random();
  const gx = gauss(), gy = gauss(), gz = gauss(), gl = Math.hypot(gx, gy, gz) || 1, rad = Math.random() ** 0.6;
  dData[i * 4] = (gx / gl) * rad; dData[i * 4 + 1] = (gy / gl) * rad; dData[i * 4 + 2] = (gz / gl) * rad; dData[i * 4 + 3] = Math.random();
}
const geo = new THREE.BufferGeometry();
const aI = new THREE.BufferAttribute(iData, 4);
geo.setAttribute('position', aI);   // Three counts vertices from "position"; the shader never reads it, so reuse a_i
geo.setAttribute('a_i', aI);
geo.setAttribute('a_d', new THREE.BufferAttribute(dData, 4));
const rotM = new THREE.Matrix3(), rot4 = new THREE.Matrix4(), axis = new THREE.Vector3(0.3, 1, 0.15).normalize();
const uni = {
  u_lv: { value: new Float32Array(NB) }, u_rot: { value: rotM },
  u_shape: { value: new THREE.Vector3(0.85, 0.6, 0.85) }, u_off: { value: new THREE.Vector2() },
  u_time: { value: 0 }, u_swirlT: { value: 0 }, u_shockR: { value: 0 }, u_shockA: { value: 0 }, u_jolt: { value: 0 }, u_dens: { value: 0 }, u_rms: { value: 0 },
  u_chaos: { value: 1 }, u_sc: { value: 1 }, u_size: { value: 1 }, u_dof: { value: 0.45 }, u_camDist: { value: camDist },
  u_charge: { value: 0 }, u_swell: { value: 1 }, u_flash: { value: 0 }, u_ptr: { value: new THREE.Vector3() }, u_asp: { value: 1 },
  u_ejT: { value: new Float32Array(4).fill(99) }, u_ejP: { value: new Float32Array(4) }, u_ejS: { value: new Float32Array(4) },
};
const points = new THREE.Points(geo, new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, uniforms: uni, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false }));
points.frustumCulled = false;
scene.add(points);

// SPACE: a deep starfield around the cloud so the camera has something to fly past. Layers, far to near: tiny sharp stars,
// a few bright ones, and large faint out-of-focus orbs. Fixed in the world, so orbiting and zooming give real parallax.
const SPACE_VS = `
attribute vec3 a_s;     // random, warm-or-cool, 1 for an out-of-focus orb
uniform float u_time, u_dpr, u_lens, u_asp;
uniform vec2 u_core;    // where the core sits on screen (clip space)
varying vec3 v_c;
varying float v_a, v_soft;
void main(){
  vec4 mv=modelViewMatrix*vec4(position,1.0);
  gl_Position=projectionMatrix*mv;
  vec2 d=gl_Position.xy/gl_Position.w-u_core; d.x*=u_asp;      // gravitational lens: stars near the core are pushed outward, most on a bass hit
  float l=length(d)+0.03; d=d/l*min(u_lens*0.02/l,0.3); d.x/=u_asp;
  gl_Position.xy+=d*gl_Position.w;
  float dist=max(-mv.z,0.5);
  vec3 c=mix(vec3(0.62,0.78,1.0),vec3(1.0,0.74,0.5),a_s.y);
  float tw=0.8+0.2*sin(u_time*(0.8+3.0*a_s.x)+a_s.x*80.0);
  if(a_s.z>0.5){
    gl_PointSize=min((50.0+110.0*a_s.x)*u_dpr*2.5/dist,260.0);
    v_a=0.16+0.14*a_s.x; v_soft=1.0; v_c=c*vec3(0.8,0.7,1.0);
  } else {
    float b=a_s.x*a_s.x*a_s.x;
    gl_PointSize=(1.6+4.2*b)*u_dpr*min(1.0,4.0/dist);
    v_a=(0.75+1.2*b)*tw*min(1.0,6.0/dist); v_soft=0.0; v_c=mix(c,vec3(1.0),0.4);
  }
}`;
const SPACE_FS = `
precision highp float;
varying vec3 v_c;
varying float v_a, v_soft;
void main(){
  float d=length(gl_PointCoord-0.5)*2.0;
  if(d>1.0) discard;
  float shape=mix(1.0-smoothstep(0.4,1.0,d), exp(-3.0*d*d)*(1.0-smoothstep(0.75,1.0,d)), v_soft);
  gl_FragColor=vec4(v_c,v_a*shape);
}`;
const SPACE_N = 16000, ORBS = 140;
const sPos = new Float32Array(SPACE_N * 3), sAttr = new Float32Array(SPACE_N * 3);
for (let i = 0; i < SPACE_N; i++) {
  const orb = i < ORBS, near = !orb && i < ORBS + 300;
  const r = orb ? 3.5 + Math.random() * 10 : near ? 2.8 + Math.random() * 2.5 : 6 + Math.random() * 12;
  const z = Math.random() * 2 - 1, a = Math.random() * 6.2832, k = Math.sqrt(1 - z * z);
  sPos.set([Math.cos(a) * k * r, z * r, Math.sin(a) * k * r], i * 3);
  sAttr.set([Math.random(), Math.random() ** 2, orb ? 1 : 0], i * 3);
}
const spaceGeo = new THREE.BufferGeometry();
spaceGeo.setAttribute('position', new THREE.BufferAttribute(sPos, 3));
spaceGeo.setAttribute('a_s', new THREE.BufferAttribute(sAttr, 3));
const spaceUni = { u_time: { value: 0 }, u_dpr: { value: 1 }, u_lens: { value: 0 }, u_asp: { value: 1 }, u_core: { value: uni.u_off.value } };
const space = new THREE.Points(spaceGeo, new THREE.ShaderMaterial({ vertexShader: SPACE_VS, fragmentShader: SPACE_FS, uniforms: spaceUni, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false }));
space.frustumCulled = false;

// Distant glow: a huge sphere around everything, painted with slow clouds of violet, teal and rose.
const GLOW_VS = `varying vec3 vP; void main(){ vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`;
const GLOW_FS = `
precision highp float;
varying vec3 vP;
uniform float u_time, u_rms;
float h(float n){return fract(sin(n*127.1)*43758.5453);}
float vn(vec3 p){
  vec3 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  float n=i.x+i.y*57.0+i.z*113.0;
  return mix(mix(mix(h(n),h(n+1.0),f.x),mix(h(n+57.0),h(n+58.0),f.x),f.y),
             mix(mix(h(n+113.0),h(n+114.0),f.x),mix(h(n+170.0),h(n+171.0),f.x),f.y),f.z);
}
float fbm(vec3 p){return 0.5*vn(p)+0.3*vn(p*2.07+3.1)+0.2*vn(p*4.3+9.7);}
void main(){
  vec3 d=normalize(vP), t=vec3(0.0,u_time*0.006,0.0);
  float a=fbm(d*2.0+t), b=fbm(d*3.6+11.0-t), c=fbm(d*7.0+23.0);
  float cloud=smoothstep(0.36,0.72,a);                     // wider than before: more of the sky is nebula
  float lane=smoothstep(0.3,0.55,b);                       // dark lanes cut through the glow
  vec3 col=mix(vec3(0.42,0.12,0.72),vec3(0.06,0.5,0.62),smoothstep(0.3,0.7,b));
  col=mix(col,vec3(0.85,0.25,0.4),smoothstep(0.55,0.85,c)*0.6);
  float k=cloud*lane*(0.5+0.8*c)*(0.5+0.25*u_rms)*1.35;
  gl_FragColor=vec4(col*k,1.0);
}`;
const glowUni = { u_time: { value: 0 }, u_rms: { value: 0 } };
const glow = new THREE.Mesh(new THREE.SphereGeometry(14, 32, 16), new THREE.ShaderMaterial({ vertexShader: GLOW_VS, fragmentShader: GLOW_FS, uniforms: glowUni, side: THREE.BackSide, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false }));
glow.frustumCulled = false;
glow.renderOrder = -2;
space.renderOrder = -1;

// Dev flags (?demo ?fake ?debug) only work on localhost.
const q = new URLSearchParams(['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) ? location.search : '');
const audio = new AudioInput();
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const calm = reduce ? 0.6 : 1;   // reduced motion: calmer turbulence, slower turning, no shockwave or camera lurch
let width = 0, height = 0, aspect = 1, dpr = 1;
let time = 0, live = 0, swirlT = 0, shockR = 9, shockA = 0, kickCool = 0, jolt = 0, dens = 0, idleShock = 3;
let sinceKick = 0, charge = 0, blow = 0, flash = 0, ejSlot = 0;   // collapse and detonation state
let poke = false, ptrPull = 0, ptrOn = false;                      // a tap asks for a detonation; mouse hover pulls the dust
let fly = 0, flyHold = 0;                                          // camera fly-in: 0 outside, 1 deep in the cloud
let paused = false, sensitivity = 1, detail = 1, autoDetail = true, govSum = 0, govN = 0;
if (!q.has('nospace')) { scene.add(space); scene.add(glow); }
// Camera: a slow automatic turn, plus drag to orbit (with a little inertia), wheel or pinch to zoom, double-click to reset.
const view = { spin: 0, yaw: 0, pitch: 0, vYaw: 0, vPitch: 0, zoom: 1, dragging: false };
const tune = new Float32Array([1, 1, 1, 1]);   // level gain, speck size, chaos, shockwave strength
const mult = (v, lo) => (v <= 0.5 ? lo + (1 - lo) * (v / 0.5) : 1 + (v - 0.5) * 1.5);
const lvl = new Float32Array(NB);
let prevBass = 0;
const lay = { ox: 0, oy: 0, sc: 1 };   // where the swarm sits on screen

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h || (w === width && h === height && dpr === renderer.getPixelRatio())) return;
  width = w; height = h; aspect = w / h;
  renderer.setPixelRatio(dpr);
  renderer.setSize(w, h, false);
  camera.aspect = aspect; camera.updateProjectionMatrix();
}

// Keeps the swarm in the free part of the first screen: beside the text on wide screens, above it on phones.
const introEl = document.getElementById('intro');
let introRect = { right: 0, top: 0 };
new ResizeObserver(() => { introRect = introEl.getBoundingClientRect(); }).observe(introEl);
function updateLayout(dt, snap) {
  const W = window.innerWidth, H = window.innerHeight;
  let l = -0.94, r = 0.94, yb = -0.62;
  if (!document.body.classList.contains('running')) {
    if (W >= 720) l = (introRect.right / W) * 2 - 1 + 0.06;
    else yb = 1 - (2 * introRect.top) / H + 0.08;
  }
  const t = { ox: (l + r) / 2, oy: (yb + 0.78) / 2, sc: Math.max(0.2, Math.min(((r - l) / 2) * aspect, (0.78 - yb) / 2) * 0.92) };
  const k = snap ? 1 : 1 - Math.exp(-dt / 0.6);
  for (const key in t) lay[key] += (t[key] - lay[key]) * k;
  uni.u_off.value.set(lay.ox, lay.oy);
}

// ?demo: synthetic bands (a kick and a moving mid/high texture) for checking the look without capturing audio.
// ?fake also skips real capture so the UI's running state can be tested: x = share ended, z = toggle silence.
const fake = q.has('fake');
const demo = q.has('demo') || fake;
let demoOn = q.has('demo');
let muted = false, demoDt = 0;
if (fake) window.addEventListener('keydown', (e) => { if (e.key === 'x') audio.onended(); else if (e.key === 'z') muted = !muted; });
const demoF = { rms: 0.6, silent: false, silentFor: 0, bands: new Float32Array(NB) };
function demoFeatures(t) {
  if (muted) { demoF.bands.fill(0); demoF.rms = 0; demoF.silent = true; demoF.silentFor += demoDt; return demoF; }
  demoF.silent = false; demoF.silentFor = 0; demoF.rms = 0.6;
  const kick = t % 16 > 11 ? 0 : Math.exp(-((t * 2) % 1) * 6);   // the beat drops out for 5 s in every 16, so the collapse and the drop can be seen
  for (let i = 0; i < NB; i++) {
    const x = i / NB, pk = (c, w) => Math.exp(-((x - c) ** 2) / w);
    demoF.bands[i] = Math.min(1, 0.95 * pk(0.06, 0.004) * kick + 0.7 * pk(0.3 + 0.1 * Math.sin(t * 0.7), 0.01) * (0.5 + 0.5 * Math.sin(t * 3) ** 2)
      + 0.65 * pk(0.6 + 0.25 * Math.sin(t * 0.4), 0.012) * (0.5 + 0.5 * Math.sin(t * 5) ** 2) + 0.5 * pk(0.9, 0.01) * (0.5 + 0.5 * Math.sin(t * 9) ** 2));
  }
  return demoF;
}

let dbg = null, dbgNext = 0;
if (q.has('debug')) {
  dbg = document.createElement('pre');
  dbg.style.cssText = 'position:fixed;left:8px;top:8px;margin:0;font:11px/1.3 ui-monospace,monospace;color:#F2F0EA;pointer-events:none';
  document.body.appendChild(dbg);
}

let status = 'idle';
function applyDetail(d) { detail = d; geo.setDrawRange(0, Math.floor(N * d)); }
const app = {
  async start(kind) {
    status = 'waiting for your choice';
    if (fake) { muted = false; demoOn = true; return { ok: true }; }
    const r = await audio.start(kind);
    status = r.ok ? `listening (${kind})` : `not started: ${r.code}`;
    return r;
  },
  setPaused(p) { paused = p; audio.paused = p; },
  setTune(v) { tune[0] = mult(v[0], 0.4); tune[1] = mult(v[1], 0.5); tune[2] = mult(v[2], 0.2); tune[3] = mult(v[3], 0); },
  setSensitivity(v) { sensitivity = 0.4 + 1.2 * v; },
  // Auto picks by screen size: a phone draws fewer specks.
  setDetail(v, auto) { autoDetail = auto; applyDetail(auto ? (innerWidth < 720 ? 0.4 : 1) : Math.max(0.25, v)); },
  onEnded: null,
};
audio.onended = () => { status = 'sharing stopped'; if (fake) demoOn = false; app.onEnded?.(); };
const ui = initUI(app);

// Band levels for this frame. In silence the swarm twitches: a few short thorns flick at random.
function updateLevels(f, dt) {
  const active = (audio.active || demoOn) && !f.silent;
  live += ((active ? 1 : 0) - live) * (1 - Math.exp(-dt / (active ? CONFIG.liveTauIn : CONFIG.liveTauOut)));
  const lv = uni.u_lv.value;
  for (let i = 0; i < NB; i++) {
    const raw = Math.min(1, (f.bands?.[i] ?? 0) * sensitivity) ** CONFIG.curve;
    lvl[i] = raw;
    const idle = 0.07 + 0.11 * Math.max(0, Math.sin(time * 0.5 + i * 0.9)) ** 3;
    lv[i] = Math.min(1, idle + live * (raw * tune[0] - idle));
  }
  dens += (live * f.rms - dens) * (1 - Math.exp(-dt / 0.5));
}

// A kick sends a bright shockwave out through the cloud and throws off a burst of ejecta (a ghost shockwave now and then in silence).
// While the beat is missing the cloud collapses; the kick that ends the gap is the drop, and detonates it.
function updateShock(dt) {
  if (reduce) return;
  kickCool -= dt;
  sinceKick = live > 0.3 ? sinceKick + dt : 0;
  const tens = tension(sinceKick);
  const ej = uni.u_ejT.value, ejP = uni.u_ejP.value, ejS = uni.u_ejS.value;
  let bass = 0;
  for (let i = 0; i < 8; i++) bass = Math.max(bass, lvl[i]);
  if (poke || isKick(bass, prevBass, live, kickCool, CONFIG)) {
    const drop = poke ? 1 : tens > CONFIG.dropAt ? tens : 0;
    poke = false;
    if (drop) flyHold = 4;
    shockR = 0.1; shockA = 1 + 1.2 * drop; kickCool = CONFIG.kickCool; jolt += 0.6 + 0.6 * drop;
    blow = Math.max(blow, drop); flash = Math.max(flash, drop);
    // An ordinary kick fires one of the four bursts in turn; the drop fires all four.
    for (let k = drop ? 4 : 1; k > 0; k--) { ejSlot = (ejSlot + 1) % 4; ej[ejSlot] = 0; ejP[ejSlot] = (drop || 0.35) * Math.min(1, tune[3]); ejS[ejSlot] = Math.random() * 100; }
    sinceKick = 0;
  }
  prevBass = bass;
  idleShock -= dt;
  if (live < 0.3 && idleShock <= 0) { shockR = 0.1; shockA = 0.4; idleShock = CONFIG.idleShock * (0.8 + Math.random() * 0.5); }
  shockR += dt * CONFIG.shockSpeed;
  shockA *= Math.exp(-dt / 0.45);
  const want = tension(sinceKick);
  charge += (want - charge) * (1 - Math.exp(-dt / (want > charge ? 0.5 : 0.12)));   // winds up slowly, lets go at once
  blow *= Math.exp(-dt / 0.9);
  flash *= Math.exp(-dt / 0.25);
  for (let k = 0; k < 4; k++) ej[k] += dt;
}

let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  if (document.hidden) { last = now; return; }
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  resize();
  audio.features.sensitivity = sensitivity;
  demoDt = dt;
  const f = demo ? demoFeatures(now / 1000) : audio.update(dt, now);
  ui.frame(uni.u_lv.value, f.silentFor);
  // Auto detail: if frames are slow (under about 36 fps over 1.5 s, after the first 4 s of shader compiling), draw 20% fewer specks, down to a quarter.
  if (autoDetail && !paused && now > 4000 && (govSum += dt, ++govN, govSum > 1.5)) {
    if (govSum / govN > 0.028 && detail > 0.25) { applyDetail(Math.max(0.25, detail * 0.8)); ui.setDetail(detail); }
    govSum = govN = 0;
  }
  updateLayout(dt, false);
  if (!paused) {
    time += dt;
    updateLevels(f, dt);
    updateShock(dt);
    swirlT += dt * (0.25 + 1.2 * dens + 1.5 * charge);   // a collapsing cloud spins up
    flyHold -= dt;
    const flyTo = !reduce && flyHold <= 0 && live > 0.5 && dens > 0.35 && charge < 0.1 ? 1 : 0;   // loud, steady and no collapse: drift in
    fly += (flyTo - fly) * (1 - Math.exp(-dt / (flyTo > fly ? 14 : 0.4)));                          // slow in, quick out (the drop snaps it back)
    jolt *= Math.exp(-dt / 0.6);
  }
  const cg = shockA * tune[3];
  uni.u_time.value = time;
  spaceUni.u_time.value = time; glowUni.u_time.value = time; glowUni.u_rms.value = dens; spaceUni.u_dpr.value = dpr;
  spaceUni.u_asp.value = uni.u_asp.value = aspect;
  ptrPull += ((ptrOn && !view.dragging && !reduce ? 1 : 0) - ptrPull) * (1 - Math.exp(-dt / 0.25));
  uni.u_ptr.value.z = ptrPull;
  spaceUni.u_lens.value = reduce ? 0 : 0.5 + 0.8 * prevBass + 1.5 * charge + cg;   // stronger as the cloud collapses
  uni.u_swirlT.value = swirlT;
  uni.u_shockR.value = shockR;
  uni.u_shockA.value = cg;
  uni.u_rms.value = live * f.rms;
  uni.u_jolt.value = jolt;
  uni.u_charge.value = charge;
  uni.u_swell.value = 1 - 0.45 * charge + 0.4 * blow;
  uni.u_flash.value = flash * Math.min(1, tune[3]);
  uni.u_dens.value = dens;
  uni.u_chaos.value = tune[2] * calm;
  uni.u_size.value = tune[1] * dpr;
  uni.u_sc.value = lay.sc;
  uni.u_shape.value.set(1 + 0.12 * Math.sin(time * 0.05), 1 + 0.1 * Math.sin(time * 0.037 + 1), 1 + 0.12 * Math.sin(time * 0.043 + 2));
  rot4.makeRotationAxis(axis, Math.sin(time * 0.09) * 0.25 * calm + jolt * 0.2);
  rotM.setFromMatrix4(rot4);
  if (!view.dragging) {
    view.yaw += view.vYaw; view.pitch = Math.max(-1.2, Math.min(1.2, view.pitch + view.vPitch));
    const k = Math.exp(-dt / 0.6); view.vYaw *= k; view.vPitch *= k;
    if (!paused) view.spin += dt * 0.08 * calm;
  }
  const yaw = view.spin + view.yaw, pitch = Math.max(-1.45, Math.min(1.45, 1.15 + 0.05 * Math.sin(time * 0.07) + view.pitch)), dist = camDist * view.zoom * (1 - 0.05 * cg - 0.1 * charge - 0.3 * fly);   // creeps in during the collapse, snaps back on the drop
  camera.position.set(Math.sin(yaw) * Math.cos(pitch) * dist, Math.sin(pitch) * dist, Math.cos(yaw) * Math.cos(pitch) * dist);
  camera.lookAt(0, 0, 0);
  uni.u_camDist.value = dist;   // keep the depth-of-field focus on the core as the camera moves
  renderer.render(scene, camera);
  if (dbg && now > dbgNext) {
    dbgNext = now + 100;
    dbg.textContent = `${status}\nlive ${live.toFixed(2)} shock ${shockA.toFixed(2)} charge ${charge.toFixed(2)} fly ${fly.toFixed(2)} fps ${(1 / Math.max(dt, 1e-3)).toFixed(0)}\nbands ${Array.from(lvl, (v) => Math.round(v * 9)).join('')}`;
  }
}

const pointers = new Map();
let pinch = 0;
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  view.dragging = true; view.vYaw = view.vPitch = 0;
  if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); }
});
canvas.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  p.x = e.clientX; p.y = e.clientY;
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinch) view.zoom = Math.max(0.5, Math.min(1.8, view.zoom * (pinch / d)));
    pinch = d;
    return;
  }
  view.vYaw = -dx * 0.006; view.vPitch = dy * 0.005;
  view.yaw += view.vYaw; view.pitch = Math.max(-1.2, Math.min(1.2, view.pitch + view.vPitch));
});
// Mouse over the canvas pulls the dust toward the pointer; a quick tap (no drag) sets off a supernova.
window.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse') return;
  ptrOn = e.target === canvas;
  uni.u_ptr.value.x = (e.clientX / innerWidth) * 2 - 1; uni.u_ptr.value.y = 1 - (e.clientY / innerHeight) * 2;
});
document.addEventListener('pointerleave', () => { ptrOn = false; });
let tap = null;
canvas.addEventListener('pointerdown', (e) => { tap = { x: e.clientX, y: e.clientY, t: performance.now() }; });
const release = (e) => {
  if (tap && e.type === 'pointerup' && pointers.size === 1 && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < 6 && performance.now() - tap.t < 300) poke = true;
  tap = null;
  pointers.delete(e.pointerId); pinch = 0; if (!pointers.size) view.dragging = false;
};
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);
canvas.addEventListener('wheel', (e) => { e.preventDefault(); view.zoom = Math.max(0.5, Math.min(1.8, view.zoom * Math.exp(e.deltaY * 0.001))); }, { passive: false });
canvas.addEventListener('dblclick', () => { view.yaw = view.pitch = 0; view.zoom = 1; });

window.addEventListener('resize', resize);
window.addEventListener('pointerdown', () => { if (audio.ctx?.state === 'suspended') audio.ctx.resume().catch(() => {}); });
window.addEventListener('keydown', () => { if (audio.ctx?.state === 'suspended') audio.ctx.resume().catch(() => {}); });
resize();
updateLayout(0, true);
requestAnimationFrame(frame);
