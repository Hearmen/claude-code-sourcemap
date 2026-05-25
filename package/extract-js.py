import sys
import re

binary_path = "/Users/hearmen/.nvm/versions/node/v22.14.0/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe"
output_path = "/Users/hearmen/Project/AI4Sec/claude-code-sourcemap/package/extracted-js/v2.1.143_extracted.js"

# 启发式：看起来像 JS/TS 的文本块
JS_KEYWORDS = [
    b'function ', b'const ', b'let ', b'var ', b'=>', b'async ', b'await ',
    b'import ', b'export ', b'class ', b'return ', b'if(', b'for(', b'while(',
    b'typeof ', b'new ', b'throw ', b'catch', b'yield', b'\\x22use strict\\x22',
    b'Promise', b'undefined', b'null', b'true', b'false',
]

def looks_like_js(chunk):
    """简单启发式判断文本块是否像 JS 代码"""
    score = 0
    for kw in JS_KEYWORDS:
        if kw in chunk:
            score += 1
    # 至少需要命中 2 个关键字，且长度适中
    return score >= 2 and len(chunk) >= 80

print(f"扫描 {binary_path} ...")
with open(binary_path, 'rb') as f:
    data = f.read()

filesize = len(data)
print(f"文件大小: {filesize} bytes")

# 正则提取所有可打印 ASCII 序列（长度 >= 50）
# 允许 \n, \r, \t 等空白字符
pattern = re.compile(br'[\x20-\x7e\n\r\t]{50,}')

matches = list(pattern.finditer(data))
print(f"找到 {len(matches)} 个文本块")

js_chunks = []
for m in matches:
    chunk = m.group()
    if looks_like_js(chunk):
        js_chunks.append((m.start(), chunk))

print(f"其中 {len(js_chunks)} 个像 JS 代码")

# 按偏移量排序并输出
js_chunks.sort(key=lambda x: x[0])

with open(output_path, 'wb') as out:
    for offset, chunk in js_chunks:
        out.write(f"\n// === OFFSET {offset} ===\n".encode('utf-8'))
        out.write(chunk)
        out.write(b'\n')

print(f"已写入 {output_path}")
print(f"输出大小: {len(open(output_path, 'rb').read()) / (1024*1024):.1f} MB")
