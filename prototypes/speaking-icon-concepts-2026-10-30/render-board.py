from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parent
canvas = Image.new('RGB', (1200, 760), '#f4f5f2')
draw = ImageDraw.Draw(canvas)
regular = 'C:/Windows/Fonts/msyh.ttc'
bold = 'C:/Windows/Fonts/msyhbd.ttc'
font = lambda size, heavy=False: ImageFont.truetype(bold if heavy else regular, size)
ink, muted = '#202923', '#5f6f65'
draw.text((50, 43), '沉浸口语 · 图标方向', font=font(34, True), fill=ink)
draw.text((50, 101), '同一套墨绿配色，比较不同的符号。', font=font(22), fill=muted)
current = Image.open(root.parent.parent / 'immersive-translator-windows/src-tauri/icons/icon.png').convert('RGBA')
canvas.paste(current.resize((82, 82), Image.Resampling.LANCZOS), (1038, 32), current.resize((82, 82), Image.Resampling.LANCZOS))
draw.text((1038, 124), '现图标对照', font=font(17), fill=muted)
variants = [
    ('A', '双向对话', '轮流说，像一次交谈', 'dialogue'),
    ('B', '书页对话', '把读到的内容说出来', 'book-dialogue'),
    ('C', '声波对话', '更直接地表达开口说', 'voice-wave'),
    ('D', '语伴', '亲切、轻松的练习伙伴', 'companion'),
]
for index, (letter, label, caption, name) in enumerate(variants):
    left = 50 + index * 288
    image = Image.open(root / (name + '.png')).convert('RGBA')
    large = image.resize((212, 212), Image.Resampling.LANCZOS)
    canvas.paste(large, (left + 16, 214), large)
    draw.text((left + 16, 453), letter + '  ' + label, font=font(25, True), fill=ink)
    draw.text((left + 16, 499), caption, font=font(18), fill=muted)
    x, baseline = left + 18, 635
    for size in (16, 32, 48):
        small_path = root / (name + '-32.png')
        small = Image.open(small_path).convert('RGBA') if size == 32 else image.resize((size, size), Image.Resampling.LANCZOS)
        canvas.paste(small, (x, baseline - size), small)
        x += size + 24
    draw.text((left + 16, 651), '16 / 32 / 48 px', font=font(17), fill=muted)
draw.text((50, 715), '方向预览，尚未替换正式图标。', font=font(17), fill=muted)
canvas.save(root / 'icon-directions.png')
print('Saved icon-directions.png (1200 x 760)')
