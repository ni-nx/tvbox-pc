import json
import re
import urllib.request
from collections import Counter

txt = open(r'C:\Users\Admin\Doubao\chats\2026-11-14\new-chat\_apk\repo.txt', encoding='utf-8').read()
urls = re.findall(r'https?://[^"\s,]+', txt)
urls = [u for u in urls if not re.search(r'\.(m3u|txt)$', u)]
print('candidate configs', len(urls))

cnt = Counter()
js = []
for u in urls[:30]:
    try:
        req = urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'})
        t = urllib.request.urlopen(req, timeout=12).read().decode('utf-8', 'replace')
        t = re.sub(r'(?m)^\s*//.*$', '', t)
        j = json.loads(t)
        for s in j.get('sites', []):
            sp = str(s.get('spider', ''))
            if sp.endswith('.js'):
                kind = 'js'
            elif sp.endswith('.jar'):
                kind = 'jar'
            elif sp.startswith('csp_'):
                kind = 'csp'
            elif not sp:
                kind = 'empty'
            else:
                kind = 'other'
            cnt[kind] += 1
            if kind == 'js' and len(js) < 8:
                js.append((s.get('name'), sp))
    except Exception as e:
        pass

print(cnt)
for x in js:
    print('JS', x)
