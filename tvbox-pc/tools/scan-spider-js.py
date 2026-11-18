import json
import re
import urllib.request

txt = open(r'C:\Users\Admin\Doubao\chats\2026-11-14\new-chat\_apk\repo.txt', encoding='utf-8').read()
urls = [u for u in re.findall(r'https?://[^"\s,]+', txt) if not re.search(r'\.(m3u|txt)$', u)]

found_js = []
found_jar = 0
found_none = 0
checked = 0
for u in urls[:40]:
    try:
        req = urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'})
        t = urllib.request.urlopen(req, timeout=10).read().decode('utf-8', 'replace')
        t = re.sub(r'(?m)^\s*//.*$', '', t)
        j = json.loads(t)
        checked += 1
        sp = str(j.get('spider', ''))
        if sp.lower().split(';')[0].endswith('.js'):
            found_js.append((u, sp[:70]))
        elif sp:
            found_jar += 1
        else:
            found_none += 1
    except Exception:
        pass

print('checked', checked, 'jar/other', found_jar, 'none', found_none, 'js', len(found_js))
for x in found_js[:6]:
    print('JS', x)
