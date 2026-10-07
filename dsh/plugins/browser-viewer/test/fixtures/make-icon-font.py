"""Regenerate fixture-icons.woff2 with fonttools and brotli; tests need no Python.

The two synthetic glyphs and font are original test data, with no site assets.
"""
from pathlib import Path
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

def glyph(rectangles):
    pen = TTGlyphPen(None)
    for x, y, w, h in rectangles:
        pen.moveTo((x, y))
        pen.lineTo((x + w, y))
        pen.lineTo((x + w, y + h))
        pen.lineTo((x, y + h))
        pen.closePath()
    return pen.glyph()

builder = FontBuilder(1000, isTTF=True)
builder.setupGlyphOrder([".notdef", "menu"])
builder.setupCharacterMap({0xF1BA: "menu"})
builder.setupGlyf({".notdef": glyph([(0, 0, 100, 100)]),
                  "menu": glyph([(100, 100, 800, 100), (100, 350, 800, 100), (100, 600, 800, 100)])})
builder.setupHorizontalMetrics({".notdef": (250, 0), "menu": (1000, 100)})
builder.setupHorizontalHeader(ascent=800, descent=-200)
builder.setupNameTable({"familyName": "SeekFixtureIcons", "styleName": "Regular",
                       "uniqueFontIdentifier": "SeekFixtureIcons-Regular",
                       "fullName": "Seek Fixture Icons", "psName": "SeekFixtureIcons-Regular"})
builder.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
builder.setupPost()
builder.setupMaxp()
builder.font["head"].created = builder.font["head"].modified = 2082844800
builder.font.flavor = "woff2"
builder.save(Path(__file__).with_name("fixture-icons.woff2"))
