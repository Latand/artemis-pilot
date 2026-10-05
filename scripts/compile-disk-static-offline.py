# Compile/link only in surfaceless Mesa GLES. No draw, browser or timing gate.
import ctypes as c, re, json, pathlib, subprocess, hashlib, sys
root=pathlib.Path(sys.argv[1]).resolve(); capture=pathlib.Path(sys.argv[2]).resolve(); dest=pathlib.Path(sys.argv[3]).resolve()
sha=lambda b:hashlib.sha256(b).hexdigest()
assert sha(capture.read_bytes())=='299549f8614478dfd9b20e9faa8d816fe6d0d04792fe2b95951c1039637b5ee0'
evidence=json.loads(capture.read_text());assert evidence['candidateRevision']=='a21d5d137659d81193a196414e31c8c0012718ff'
program=evidence['selectionNative']['settled']['programs'][0]
fs=next(s['source'] for s in program['shaders'] if s['type']==35632);vs=next(s['source'] for s in program['shaders'] if s['type']==35633)
old=subprocess.check_output(['git','show','a21d5d137659d81193a196414e31c8c0012718ff:src/holeOptics.js'],cwd=root,text=True);current=(root/'src/holeOptics.js').read_text()
def block(s):
 a=s.index('        if (uDiskOn > 0.5 && abs(rd.z) > 1e-7) {');b=s.index('                vec3 p = ro+hit*rd;',a);return s[a:b]
def fragment(s):
 a=s.index('const analyticFragment =');a=s.index('`',a)+1;b=s.index('\n`;',a);return s[a:b]
assert fragment(old).replace(block(old),'BLOCK')==fragment(current).replace(block(current),'BLOCK')
assert fs.count(block(old))==1
candidate=fs.replace(block(old),block(current))
def variant(mode,precision='highp'):
 s=candidate.replace('#define HOLE_LAYER 1',f'#define HOLE_LAYER 1\n#define DISK_UNCLIPPED {mode}')
 if precision!='highp':s=s.replace('#define HIGH_PRECISION', '#define MEDIUM_PRECISION' if precision=='mediump' else '// no known precision macro').replace('precision highp','precision mediump')
 return s
def preprocess(s):
 return subprocess.check_output(['cpp','-P','-undef'],input=re.sub(r'^#(?:version|extension).*\n','',s,flags=re.M),text=True)
fast=preprocess(variant(1));normal=preprocess(variant(0));medium=preprocess(variant(1,'mediump'));unknown=preprocess(variant(1,'unknown'))
assert 'halfSupport' not in fast and 'halfWidth' not in fast and 'uDiskUnclipped <' not in fast
for body in [normal,medium,unknown]:assert 'halfSupport' in body and 'halfWidth' in body and 'coverage = clamp' in body
# Negative control: omitting the effective-precision guard would erase required
# normalized support from a real lower-precision program.
mutant=variant(1,'mediump').replace(' || !defined(HIGH_PRECISION)','')
assert 'halfSupport' not in preprocess(mutant)
# Removing only the old uniform condition from the captured fast body leaves
# precisely the same arithmetic as the specialized body (comments/whitespace aside).
start=fs.index('            if (uDiskUnclipped < .5) {');end=fs.index('            if (exitHit > entry',start)
old_fast=fs[:start]+fs[end:]
canon=lambda s:re.sub(r'\s+','',s)
assert canon(preprocess(old_fast))==canon(fast),'Static fast body exactly matches old uniform=1 body'
old_normal=fs.replace('            if (uDiskUnclipped < .5) {','').replace('            }\n            if (exitHit > entry','            if (exitHit > entry')
assert canon(preprocess(old_normal))==canon(normal),'Static fallback arithmetic exactly matches old uniform=0 body'
E=c.CDLL('/lib/x86_64-linux-gnu/libEGL.so.1');P=c.c_void_p;I=c.c_int;U=c.c_uint
for n,rest,args in [('eglGetPlatformDisplay',P,[U,P,c.POINTER(I)]),('eglInitialize',U,[P,c.POINTER(I),c.POINTER(I)]),('eglBindAPI',U,[U]),('eglChooseConfig',U,[P,c.POINTER(I),c.POINTER(P),I,c.POINTER(I)]),('eglCreateContext',P,[P,P,P,c.POINTER(I)]),('eglMakeCurrent',U,[P,P,P,P]),('eglGetProcAddress',P,[c.c_char_p]),('eglDestroyContext',U,[P,P]),('eglTerminate',U,[P])]:
 f=getattr(E,n);f.restype=rest;f.argtypes=args
d=E.eglGetPlatformDisplay(0x31DD,None,None);major=I();minor=I();assert E.eglInitialize(d,c.byref(major),c.byref(minor));assert E.eglBindAPI(0x30A0)
attrs=(I*7)(0x3040,0x0040,0x3033,1,0x3024,8,0x3038);cfg=P();count=I();assert E.eglChooseConfig(d,attrs,c.byref(cfg),1,c.byref(count)) and count.value
ctx=E.eglCreateContext(d,cfg,None,(I*3)(0x3098,3,0x3038));assert ctx and E.eglMakeCurrent(d,None,None,ctx)
def gl(name,ret,*args):
 p=E.eglGetProcAddress(name.encode());assert p,name;return c.CFUNCTYPE(ret,*args)(p)
get=gl('glGetString',c.c_char_p,U);create=gl('glCreateShader',U,U);source=gl('glShaderSource',None,U,I,c.POINTER(c.c_char_p),c.POINTER(I));compile_=gl('glCompileShader',None,U);param=gl('glGetShaderiv',None,U,U,c.POINTER(I));log=gl('glGetShaderInfoLog',None,U,I,c.POINTER(I),c.c_char_p)
def compile_shader(kind,code):
 sh=create(kind);b=code.encode();ptr=c.c_char_p(b);source(sh,1,c.byref(ptr),None);compile_(sh);ok=I();size=I();param(sh,0x8B81,c.byref(ok));param(sh,0x8B84,c.byref(size));buf=c.create_string_buffer(max(1,size.value));log(sh,len(buf),None,buf);assert ok.value,buf.value.decode();return sh
new=gl('glCreateProgram',U);attach=gl('glAttachShader',None,U,U);link=gl('glLinkProgram',None,U);getprog=gl('glGetProgramiv',None,U,U,c.POINTER(I));programLog=gl('glGetProgramInfoLog',None,U,I,c.POINTER(I),c.c_char_p);location=gl('glGetUniformLocation',I,U,c.c_char_p);results=[]
try:
 for label,code in [('old-uniform-highp',fs),('static-normal-highp',variant(0)),('static-fast-highp',variant(1)),('static-requested-fast-mediump',variant(1,'mediump')),('static-requested-fast-unknown',variant(1,'unknown'))]:
  vertex=vs if label.endswith('highp') else vs.replace('precision highp','precision mediump').replace('#define HIGH_PRECISION','#define MEDIUM_PRECISION')
  prog=new();attach(prog,compile_shader(0x8B31,vertex));attach(prog,compile_shader(0x8B30,code));link(prog);linked=I();getprog(prog,0x8B82,c.byref(linked));buf=c.create_string_buffer(4096);programLog(prog,len(buf),None,buf);assert linked.value,(label,buf.value.decode())
  loc=location(prog,b'uDiskUnclipped');assert (loc>=0)==label.startswith('old-')
  body=preprocess(code);results.append(dict(label=label,compiled=True,linked=True,fragmentSha256=sha(code.encode()),preprocessedSha256=sha(body.encode()),preprocessedBytes=len(body.encode()),runtimeBranchUniformActive=loc>=0,normalizedSupportPresent='halfSupport' in body))
 report=dict(kind='Offline surfaceless Mesa GLES compile/link and preprocessing. No draw/browser/pixel/performance execution.',head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),tree=subprocess.check_output(['git','rev-parse','HEAD^{tree}'],cwd=root,text=True).strip(),trackedClean=not subprocess.check_output(['git','diff','HEAD','--'],cwd=root,text=True).strip(),holeSha256=sha(current.encode()),renderer=get(0x1F01).decode(),version=get(0x1F02).decode(),capturedReportSha256=sha(capture.read_bytes()),compilerScriptSha256=sha(pathlib.Path(__file__).read_bytes()),precisionGuardNegative=True,fastAndFallbackArithmeticIdentical=True,results=results)
 dest.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
finally:E.eglMakeCurrent(d,None,None,None);E.eglDestroyContext(d,ctx);E.eglTerminate(d)
