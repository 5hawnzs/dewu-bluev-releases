import io, sys, zlib, struct

def load_png(path):
    b = io.open(path, 'rb').read()
    assert b[:8] == b'\x89PNG\r\n\x1a\n', 'not png'
    i = 8
    idat = b''
    w = h = bd = ct = None
    while i < len(b):
        ln = struct.unpack('>I', b[i:i+4])[0]
        typ = b[i+4:i+8]
        data = b[i+8:i+8+ln]
        if typ == b'IHDR':
            w, h, bd, ct, comp, filt, inter = struct.unpack('>IIBBBBB', data)
            assert bd == 8 and inter == 0, f'unsupported bd={bd} inter={inter}'
        elif typ == b'IDAT':
            idat += data
        elif typ == b'IEND':
            break
        i += 12 + ln
    ch = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[ct]
    raw = zlib.decompress(idat)
    stride = w * ch
    out = bytearray()
    prev = bytearray(stride)
    pos = 0
    for y in range(h):
        f = raw[pos]; pos += 1
        line = bytearray(raw[pos:pos+stride]); pos += stride
        if f == 1:
            for x in range(ch, stride):
                line[x] = (line[x] + line[x-ch]) & 0xFF
        elif f == 2:
            for x in range(stride):
                line[x] = (line[x] + prev[x]) & 0xFF
        elif f == 3:
            for x in range(stride):
                a = line[x-ch] if x >= ch else 0
                line[x] = (line[x] + ((a + prev[x]) >> 1)) & 0xFF
        elif f == 4:
            for x in range(stride):
                a = line[x-ch] if x >= ch else 0
                bb = prev[x]
                c = prev[x-ch] if x >= ch else 0
                p = a + bb - c
                pa, pb, pc = abs(p-a), abs(p-bb), abs(p-c)
                pr = a if (pa <= pb and pa <= pc) else (bb if pb <= pc else c)
                line[x] = (line[x] + pr) & 0xFF
        out += line
        prev = line
    return w, h, ch, bytes(out)

if __name__ == '__main__':
    w, h, ch, px = load_png(sys.argv[1])
    def get(x, y):
        o = (y*w + x)*ch
        return tuple(px[o:o+3])
    print('size', w, h, 'channels', ch)
    for fx, fy in [(0.5,0.08),(0.08,0.5),(0.92,0.92),(0.5,0.55),(0.5,0.97),(0.2,0.2),(0.8,0.2)]:
        x, y = int(w*fx), int(h*fy)
        print(f'({fx},{fy}) ->', get(x, y), '#%02X%02X%02X' % get(x, y))
