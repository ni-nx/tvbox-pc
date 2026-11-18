"""读 resources.arsc：把 0x7fxxxxxx 资源 id 映射成 type/key 和字面值（string/dimen/color）。"""
import struct
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from axml import Reader, parse_string_pool


def decode_complex(v):
    # TypedValue complex: [mantissa 24][radix 4][unit 4]
    units = ['px', 'dp', 'sp', 'pt', 'in', 'mm']
    mant = v >> 8
    # mantissa is signed 24-bit with 8 fraction bits? use formula from android: value = mantissa * 2^-? simplified
    m = (v >> 8) & 0xFFFFFF
    if m & 0x800000:
        m -= 0x1000000
    radix = (v >> 4) & 0x3
    unit = v & 0xF
    mult = [1.0, 1.0 / 128, 1.0 / 32768, 1.0 / 8388608][radix]
    val = m * mult
    if unit < len(units):
        return f'{val:.3f}'.rstrip('0').rstrip('.') + units[unit]
    return str(val)


class ResTable:
    def __init__(self, path):
        self.byid = {}
        data = open(path, 'rb').read()
        r = Reader(data)
        r.u16(); r.u16(); size = r.u32()
        r.pos = 8
        r.u32()  # package count
        strings = []
        while r.pos < size:
            t, hs, cs = struct.unpack_from('<HHI', data, r.pos)
            if t == 0x0001:
                strings = parse_string_pool(r)
                continue
            if t == 0x0200:
                self._package(data, r, cs, strings)
                continue
            r.pos += cs
        self.strings = strings

    def _package(self, data, r, cs, strings):
        start = r.pos
        hs = struct.unpack_from('<H', data, start + 2)[0]
        r.pos = start + hs - 4  # after package header (id+name+offsets) simplified below
        pkg_id = struct.unpack_from('<I', data, start + 8)[0]
        type_strings_off = struct.unpack_from('<I', data, start + 268)[0]
        key_strings_off = struct.unpack_from('<I', data, start + 276)[0]
        type_strings = []
        key_strings = []
        r.pos = start + type_strings_off
        type_strings = parse_string_pool(r)
        r.pos = start + key_strings_off
        key_strings = parse_string_pool(r)
        r.pos = start + hs
        while r.pos < start + cs:
            t, hs2, cs2 = struct.unpack_from('<HHI', data, r.pos)
            if t == 0x0201:
                self._type(data, r, cs2, pkg_id, type_strings, key_strings, strings)
                continue
            r.pos += cs2
        r.pos = start + cs

    def _type(self, data, r, cs, pkg_id, type_strings, key_strings, strings):
        start = r.pos
        hs = struct.unpack_from('<H', data, start + 2)[0]
        tid = data[start + 8]
        entry_count = struct.unpack_from('<I', data, start + 12)[0]
        entries_start = struct.unpack_from('<I', data, start + 16)[0]
        type_name = type_strings[tid - 1] if 0 < tid <= len(type_strings) else f'type{tid}'
        offsets = struct.unpack_from(f'<{entry_count}I', data, start + hs)
        base = start + entries_start
        for idx, off in enumerate(offsets):
            if off == 0xFFFFFFFF:
                continue
            p = base + off
            esize, flags, key_index = struct.unpack_from('<HHI', data, p)
            key = key_strings[key_index] if key_index < len(key_strings) else f'k{key_index}'
            rid = (pkg_id << 24) | (tid << 16) | idx
            if flags & 1:
                # bag: parent + map entries
                self.byid[rid] = (type_name, key, {'bag': True})
                continue
            vsize, res0, dtype, value = struct.unpack_from('<HBBI', data, p + esize)
            val = None
            if dtype == 0x03:
                val = strings[value] if value < len(strings) else None
            elif dtype == 0x01:
                val = {'ref': value}
            elif dtype == 0x02:
                val = {'attr': value}
            elif dtype == 0x05:
                val = decode_complex(value)
            elif dtype == 0x10:
                val = value
            elif dtype == 0x12:
                val = bool(value)
            elif 0x1C <= dtype <= 0x1F:
                val = '#%08x' % value
            else:
                val = '0x%08x' % value
            self.byid[rid] = (type_name, key, val)
        r.pos = start + cs

    def name(self, rid):
        e = self.byid.get(rid)
        if not e:
            return '#0x%08x' % rid
        t, k, v = e
        return f'{t}/{k}'

    def value(self, rid):
        e = self.byid.get(rid)
        if not e:
            return None
        v = e[2]
        if isinstance(v, dict) and 'ref' in v:
            return self.value(v['ref']) if v['ref'] in self.byid else '#0x%08x' % v['ref']
        return v


if __name__ == '__main__':
    rt = ResTable(sys.argv[1])
    print('entries', len(rt.byid), 'strings', len(rt.strings))
    from collections import Counter
    c = Counter(v[0] for v in rt.byid.values())
    print(c.most_common(12))
    if len(sys.argv) > 2:
        rid = int(sys.argv[2], 16)
        print(sys.argv[2], rt.name(rid), rt.value(rid))
