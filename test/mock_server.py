# -*- coding: utf-8 -*-
"""本地 mock 的 TVBox(苹果CMS) 接口，仅用于自测，不含任何真实影视内容。"""
import json
import os
import random
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from io import BytesIO

PORT = int(os.environ.get("MOCK_PORT", "8899"))
BASE = f"http://127.0.0.1:{PORT}"

NAMES = ["示例影片甲", "示例影片乙", "示例影片丙", "示例影片丁", "示例影片戊",
         "示例影片己", "示例影片庚", "示例影片辛", "示例影片壬", "示例影片癸"]

def posters():
    from PIL import Image, ImageDraw
    out = {}
    for i in range(1, 21):
        im = Image.new("RGB", (300, 400), (18 + i * 6 % 60, 24, 34))
        d = ImageDraw.Draw(im)
        for y in range(400):
            d.line([(0, y), (300, y)], fill=(20 + y // 8 % 40, 26 + i * 3 % 50, 40 + i * 4 % 60))
        d.rectangle([24, 300, 276, 320], fill=(255, 122, 61))
        d.text((26, 332), f"MOCK POSTER {i}", fill=(230, 236, 244))
        buf = BytesIO()
        im.save(buf, "JPEG", quality=82)
        out[i] = buf.getvalue()
    return out

PICS = posters()

def vod(i, tid=1, play=False):
    v = {
        "vod_id": i,
        "vod_name": NAMES[(i - 1) % len(NAMES)] + f" {i}",
        "vod_pic": f"{BASE}/pic/{i}.jpg",
        "vod_remarks": "HD" if i % 2 else "更新至12集",
        "vod_year": "2025",
        "vod_area": "内地",
        "vod_lang": "国语",
        "type_id": tid,
        "type_name": "电影" if tid == 1 else "电视剧",
        "vod_score": "8.%d" % (i % 10),
        "vod_actor": "示例演员A / 示例演员B",
        "vod_director": "示例导演",
        "vod_content": "这是一条用于自测的示例简介。<br>仅用于验证接口解析链路，不含任何真实影视内容。",
    }
    if play:
        v["vod_play_from"] = "线路一$$$线路二"
        v["vod_play_url"] = (
            "#".join([f"第{n}集${BASE}/hls/{i}/ep{n}.m3u8" for n in range(1, 9)])
            + "$$$"
            + "#".join([f"高清{n}${BASE}/mp4/{i}/{n}.mp4" for n in range(1, 9)])
        )
    return v

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, body, ctype="application/json; charset=utf-8", code=200):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        p = urlparse(self.path)
        q = parse_qs(p.query)
        if p.path == "/config.json":
            cfg = {
                "name": "自测接口",
                "sites": [
                    {"key": "mock", "name": "示例CMS站", "type": 1,
                     "api": f"{BASE}/api.php/provide/vod/", "searchable": 1, "quickSearch": 1},
                    {"key": "spider", "name": "示例Spider站", "type": 3,
                     "api": "csp_Mock", "searchable": 0},
                ],
                "lives": [{"name": "示例直播", "url": f"{BASE}/live.txt", "type": 0}],
                "parses": [{"name": "示例解析", "type": 1, "url": f"{BASE}/parse?url="}],
                "flags": ["qq", "youku"],
            }
            return self._send(cfg)
        # 多仓：好线路 + 死线路 + 全 spider 线路
        if p.path == "/repo.json":
            return self._send({"urls": [
                {"name": "好线路（CMS）", "url": f"{BASE}/config.json"},
                {"name": "死线路（404）", "url": f"{BASE}/missing.json"},
                {"name": "纯 spider 线路", "url": f"{BASE}/spider.json"},
            ]})
        # 多仓 txt 格式：名称,地址
        if p.path == "/repo.txt":
            return self._send(
                f"好线路,{BASE}/config.json\n死线路,{BASE}/missing.json\n纯spider,{BASE}/spider.json",
                ctype="text/plain; charset=utf-8")
        if p.path == "/spider.json":
            return self._send({"spider": f"{BASE}/spider.jar",
                               "sites": [{"key": "s1", "name": "蜘蛛站", "type": 3, "api": "csp_Spider"}]})
        # 长清单：用来检查选线路弹窗的滚动条（60 条）
        if p.path == "/repo-big.json":
            urls = []
            for i in range(1, 61):
                target = ["config.json", "missing.json", "spider.json"][i % 3]
                urls.append({"name": f"自测线路 {i:02d}（{target}）", "url": f"{BASE}/{target}"})
            return self._send({"urls": urls})
        if p.path == "/api.php/provide/vod/" or p.path == "/api.php/provide/vod":
            ac = (q.get("ac") or [""])[0]
            if ac == "list":
                return self._send({
                    "code": 1, "msg": "数据列表",
                    "page": 1, "pagecount": 3, "limit": "20", "total": 60,
                    "class": [{"type_id": 1, "type_name": "电影"}, {"type_id": 2, "type_name": "电视剧"}],
                    "list": [vod(i, 1) for i in range(1, 13)],
                })
            if ac == "videolist":
                pg = int((q.get("pg") or ["1"])[0])
                tid = int((q.get("t") or ["1"])[0] or 1)
                return self._send({
                    "code": 1, "page": pg, "pagecount": 4, "total": 80,
                    "list": [vod(i, tid) for i in range((pg - 1) * 20 + 1, (pg - 1) * 20 + 21)],
                })
            if ac == "detail":
                ids = (q.get("ids") or ["1"])[0]
                i = int(ids.split(",")[0])
                return self._send({"code": 1, "list": [vod(i, 1, play=True)], "page": 1, "pagecount": 1})
            wd = (q.get("wd") or [""])[0]
            if wd:
                return self._send({"code": 1, "page": 1, "pagecount": 1,
                                   "list": [vod(i, 1) for i in range(1, 7)]})
            return self._send({"code": 0, "msg": "未知请求"})
        if p.path == "/live.txt":
            txt = ("# 示例直播源（自测用）\n"
                   "央视,#genre#\n"
                   "示例频道一,http://example.invalid/live/a.m3u8\n"
                   "示例频道二,http://example.invalid/live/b.m3u8#http://example.invalid/live/c.m3u8\n"
                   "卫视,#genre#\n"
                   "示例卫视,http://example.invalid/live/d.m3u8\n")
            return self._send(txt, "text/plain; charset=utf-8")
        if p.path.startswith("/pic/"):
            n = int(p.path.split("/")[-1].split(".")[0])
            return self._send(PICS.get((n - 1) % 20 + 1, b""), "image/jpeg")
        if p.path == "/parse":
            return self._send({"code": 1, "url": "http://example.invalid/parsed/index.m3u8"})
        # ---- 直播源各种写法（自测解析用）----
        if p.path == "/live-tvg.m3u":
            txt = ("#EXTM3U\n"
                   "#EXTINF:-1 tvg-id=\"cctv1\" tvg-name=\"CCTV-1 综合\" group-title=\"央视\",\n"
                   "#EXTVLCOPT:http-referrer=http://ref.example.com/\n"
                   "#EXTVLCOPT:http-user-agent=LiveUA/1.0\n"
                   f"{BASE}/hls/master.m3u8\n"
                   "#EXTINF:-1 tvg-name=\"CCTV-2 财经\" group-title=\"央视\",CCTV2\n"
                   f"{BASE}/hls/master.m3u8\n"
                   "#EXTINF:-1,无属性频道\n"
                   f"http://example.invalid/live/x.m3u8\n")
            return self._send(txt, "text/plain; charset=utf-8")
        if p.path == "/live-extgrp.m3u":
            txt = ("#EXTM3U\n"
                   "#EXTGRP:卫视\n"
                   "#EXTINF:-1,东方卫视\n"
                   f"{BASE}/hls/master.m3u8\n"
                   "#EXTINF:-1,湖南卫视\n"
                   "http://example.invalid/live/hn.m3u8\n"
                   "#EXTGRP:地方\n"
                   "#EXTINF:-1,本地频道\n"
                   "http://example.invalid/live/local.m3u8\n")
            return self._send(txt, "text/plain; charset=utf-8")
        if p.path == "/live-fullwidth.txt":
            txt = ("央视,#genre#\n"
                   "频道甲，http://example.invalid/live/a.m3u8\n"
                   "频道乙，http://example.invalid/live/b.m3u8#http://example.invalid/live/c.m3u8\n")
            return self._send(txt, "text/plain; charset=utf-8")
        if p.path == "/live-repo.json":
            return self._send({"urls": [
                {"name": "清单频道源A", "url": f"{BASE}/live-tvg.m3u"},
                {"name": "清单频道源B", "url": f"{BASE}/live-extgrp.m3u"},
            ]})
        # 无 .m3u8 后缀但内容是 HLS 清单（模拟 live.php?id= 这种直播地址）
        if p.path == "/live-stream.php":
            txt = ("#EXTM3U\n#EXT-X-VERSION:3\n"
                   "#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\n"
                   f"{BASE}/hls/v1/index.m3u8\n")
            return self._send(txt, "application/vnd.apple.mpegurl")
        return self._send({"code": 0, "msg": "not found"}, code=404)

if __name__ == "__main__":
    print(f"mock server on {BASE}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
