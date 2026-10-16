# WCAG AA contrast check for the prototype's colour tokens. Usage: python3 docs/mockups/checks/contrast.py
import re, sys, pathlib
s = (pathlib.Path(__file__).resolve().parent.parent / 'floty-prototype.html').read_text()
def block(sel):
    i=s.index(sel); j=s.index('}',i); return dict(re.findall(r'--([\w-]+):\s*(#[0-9A-Fa-f]{6})',s[i:j]))
light=block(':root {'); dark={**light,**block(':root[data-theme="dark"] {')}
def L(h):
    c=[int(h[k:k+2],16)/255 for k in (1,3,5)]
    c=[x/12.92 if x<=.03928 else ((x+.055)/1.055)**2.4 for x in c]
    return .2126*c[0]+.7152*c[1]+.0722*c[2]
def cr(a,b):
    a,b=L(a),L(b); return (max(a,b)+.05)/(min(a,b)+.05)
pairs=[('ink','bg'),('ink','surface'),('ink-2','bg'),('ink-2','surface'),('ink-2','surface-2'),('brand','bg'),('brand','surface'),('brand','brand-soft'),
('on-brand','brand-strong'),('ok','ok-soft'),('ok','surface'),('wait','wait-soft'),('wait','surface'),('info','info-soft'),('ink','wait-soft'),('ink-2','wait-soft'),
('s1-ink','s1'),('s2-ink','s2'),('s3-ink','s3'),('ink','brand-soft'),('surface','wait'),('bg','ink'),
('danger','surface'),('danger','bg'),('biz','surface'),('biz','bg'),('biz','biz-soft'),('biz-on','biz-strong')]
bad=0
for name,t in (('light',light),('dark',dark)):
    for f,b in pairs:
        r=cr(t[f],t[b]); flag='' if r>=4.5 else '  <-- below 4.5'
        if r<4.5: bad+=1
        print(f'{name:5} {f:>12} on {b:<12} {r:5.2f}{flag}')
print('ALL AA' if not bad else f'{bad} below AA')
sys.exit(1 if bad else 0)
