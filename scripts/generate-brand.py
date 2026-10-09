"""Generate static outlined SVG artwork from the local Windows UI font.

This is a one-off design utility, not a dependency of the application build.
Only the resulting vector paths ship; no font files or remote assets ship.
"""
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

root = Path(__file__).resolve().parent.parent
target = root / 'packages/dsh-zhiyun-ui-primitives/src/assets'
target.mkdir(parents=True, exist_ok=True)
font = TTFont('C:/Windows/Fonts/msyhbd.ttc', fontNumber=0)
glyphs = font.getGlyphSet()
cmap = font.getBestCmap()
units = font['head'].unitsPerEm

def outline(text, size, x, baseline):
    pen = SVGPathPen(glyphs)
    for character in text:
        name = cmap[ord(character)]
        scale = size / units
        glyphs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, x, baseline)))
        x += font['hmtx'][name][0] * scale
    return pen.getCommands()

screen = '<rect x="5" y="5" width="86" height="56" rx="15" fill="none" stroke="currentColor" stroke-width="5"/><path d="M29 62 26 73M67 62 70 73" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"/>'
compact_screen = '<rect x="5" y="5" width="54" height="56" rx="13" fill="none" stroke="currentColor" stroke-width="5"/><path d="M22 62 20 73M42 62 44 73" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"/>'
letters = f'<path fill="currentColor" d="{outline("Pro", 29, 20, 47)}"/>'
icon = screen + letters
wordmark = icon + f'<path fill="currentColor" d="{outline("智云", 38, 108, 51)}"/>'

def svg(content, width, color):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} 78" fill="none" color="{color}" role="img" aria-label="智云 Pro">{content}</svg>\n'

for name, content, width, color in [
    ('zhiyun-mark.svg', icon, 96, 'inherit'),
    ('zhiyun-mark-compact.svg', compact_screen, 64, 'inherit'),
    ('zhiyun-pro-blue.svg', wordmark, 190, '#00479d'),
    ('zhiyun-pro-white.svg', wordmark, 190, '#ffffff'),
]:
    (target / name).write_text(svg(content, width, color), encoding='utf-8')
print('Generated four outlined blackboard SVG brand assets.')
