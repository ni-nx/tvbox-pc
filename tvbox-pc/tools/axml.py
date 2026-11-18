"""最小 AXML（Android 二进制 XML）解析器：读字符串池 + 起点标签 + 属性，够拿布局尺寸用。"""
import struct
import sys


class Reader:
    def __init__(self, data):
        self.data = data
        self.pos = 0

    def u16(self):
        v = struct.unpack_from('<H', self.data, self.pos)[0]
        self.pos += 2
        return v

    def u32(self):
        v = struct.unpack_from('<I', self.data, self.pos)[0]
        self.pos += 4
        return v

    def skip(self, n):
        self.pos += n


def parse_string_pool(r):
    start = r.pos
    r.u16()  # type
    r.u16()  # header size
    size = r.u32()
    count = r.u32()
    r.u32()  # style count
    flags = r.u32()
    strings_start = r.u32()
    r.u32()  # styles start
    offsets = [r.u32() for _ in range(count)]
    base = start + strings_start
    utf8 = bool(flags & 0x100)
    out = []
    for off in offsets:
        p = base + off
        if utf8:
            n = r.data[p]
            p += 1
            if n & 0x80:
                n = ((n & 0x7F) << 8) | r.data[p]
                p += 1
            out.append(r.data[p:p + n + 1].decode('utf-8', 'replace').rstrip('\x00'))
        else:
            n = struct.unpack_from('<H', r.data, p)[0]
            p += 2
            if n & 0x8000:
                n = ((n & 0x7FFF) << 16) | struct.unpack_from('<H', r.data, p)[0]
                p += 2
            out.append(r.data[p:p + (n + 1) * 2].decode('utf-16-le', 'replace').rstrip('\x00'))
    r.pos = start + size
    return out


def parse_axml(path):
    data = open(path, 'rb').read()
    r = Reader(data)
    r.u16(); r.u16(); size = r.u32()
    r.pos = 0
    strings = []
    resmap = []
    events = []
    while r.pos < size:
        t, hs, cs = struct.unpack_from('<HHI', data, r.pos)
        if t == 0x0001:
            strings = parse_string_pool(r)
            continue
        if t == 0x0180:
            r.pos += hs
            count = (cs - hs) // 4
            resmap = [r.u32() for _ in range(count)]
            continue
        if t == 0x0102:  # START TASK
            r.pos += hs
            ns = r.u32(); name = r.u32()
            attr_start = r.u16(); attr_size = r.u16(); attr_count = r.u16()
            r.u16(); r.u16(); r.u16()
            attrs = []
            p = r.pos
            for _ in range(attr_count):
                ns_i, name_i, raw, _sz, _res0, dtype, val = struct.unpack_from('<IIIHBBI', data, p)
                p += attr_size
                aname = strings[name_i] if name_i < len(strings) else '?'
                rawv = strings[raw] if raw != 0xFFFFFFFF and raw < len(strings) else None
                if rawv is not None:
                    v = rawv
                elif dtype == 0x10:
                    v = str(struct.unpack('<i', struct.pack('<I', val))[0])
                elif dtype == 0x12:
                    v = 'true' if val else 'false'
                elif dtype in (0x01, 0x02, 0x08):
                    v = '#' + format(val, '08x')
                elif dtype == 0x05:
                    v = '@0x%08x' % val
                else:
                    v = '0x%08x' % val
                attrs.append((aname, v))
            events.append(('start', strings[name] if name < len(strings) else '?', attrs))
            r.pos = p
            continue
        if t == 0x0103:  # END
            r.pos += hs
            ns = r.u32(); name = r.u32()
            events.append(('end', strings[name] if name < len(strings) else '?', []))
            continue
        if t == 0x0003:  # 文件头：只跳过它自己的头，子块紧跟着
            r.pos += hs
            continue
        r.pos += cs
    return events


def dump(path, indent=True, max_attrs=12):
    ev = parse_axml(path)
    depth = 0
    for kind, name, attrs in ev:
        if kind == 'start':
            keep = [(k, v) for k, v in attrs if k in (
                'id', 'layout_width', 'layout_height', 'layout_weight', 'text', 'textSize',
                'background', 'orientation', 'padding', 'paddingLeft', 'paddingRight',
                'paddingTop', 'paddingBottom', 'layout_marginTop', 'layout_marginBottom',
                'layout_marginStart', 'layout_marginLeft', 'layout_marginRight', 'gravity',
                'visibility', 'scaleType', 'src', 'textColor', 'srcCompat')]
            print('  ' * depth + f'<{name} ' + ' '.join(f'{k}="{v}"' for k, v in keep[:max_attrs]) )
            depth += 1
        else:
            depth = max(0, depth - 1)


if __name__ == '__main__':
    dump(sys.argv[1])
