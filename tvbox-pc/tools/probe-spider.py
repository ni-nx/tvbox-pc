import json
import re
import urllib.request

u = 'https://tv.sxi.qzz.io/jsm.json'
req = urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'})
t = urllib.request.urlopen(req, timeout=20).read().decode('utf-8', 'replace')
t = re.sub(r'(?m)^\s*//.*$', '', t)
j = json.loads(t)
print('top spider:', repr(j.get('spider')))
sites = j.get('sites', [])
print('sites', len(sites))
from collections import Counter
c = Counter()
for s in sites:
    sp = str(s.get('spider', ''))
    if sp.endswith('.js'):
        k = 'js'
    elif sp.endswith('.jar'):
        k = 'jar'
    elif sp.startswith('csp_'):
        k = 'csp'
    elif not sp:
        k = 'empty'
    else:
        k = 'other:' + sp[:20]
    c[k] += 1
print(c.most_common(10))
for s in sites:
    if str(s.get('spider', '')).endswith('.js'):
        print('JS SITE', s.get('key'), s.get('name'), s.get('api'), s.get('spider'))
        break
