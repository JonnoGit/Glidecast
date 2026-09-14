// Renders the Glidecast app icon: a page mid-scroll with motion-blur streaks and a record dot.
// Usage: icon <out.png>   (1024×1024, follows the macOS icon grid)

import AppKit

let size: CGFloat = 1024
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon.png"

let rep = NSBitmapImageRep(
  bitmapDataPlanes: nil, pixelsWide: Int(size), pixelsHigh: Int(size), bitsPerSample: 8,
  samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
let ctx = NSGraphicsContext.current!.cgContext

func rgb(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
  CGColor(
    red: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255,
    blue: CGFloat(hex & 0xff) / 255, alpha: a)
}

// Coordinates below are top-left based for readability.
ctx.translateBy(x: 0, y: size)
ctx.scaleBy(x: 1, y: -1)

// --- Squircle body (824pt on the 1024 grid) with drop shadow ---------------
let body = CGRect(x: 100, y: 100, width: 824, height: 824)
let bodyPath = CGPath(roundedRect: body, cornerWidth: 186, cornerHeight: 186, transform: nil)

ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -10), blur: 24, color: rgb(0x000000, 0.22))
ctx.addPath(bodyPath)
ctx.setFillColor(rgb(0x2a2160))
ctx.fillPath()
ctx.restoreGState()

ctx.saveGState()
ctx.addPath(bodyPath)
ctx.clip()
let bg = CGGradient(
  colorsSpace: CGColorSpaceCreateDeviceRGB(),
  colors: [rgb(0x8f80ff), rgb(0x5a47e6), rgb(0x2b2079)] as CFArray, locations: [0, 0.45, 1])!
ctx.drawLinearGradient(bg, start: CGPoint(x: 250, y: 100), end: CGPoint(x: 774, y: 924), options: [])
// Soft top highlight
let glow = CGGradient(
  colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [rgb(0xffffff, 0.28), rgb(0xffffff, 0)] as CFArray,
  locations: [0, 1])!
ctx.drawRadialGradient(
  glow, startCenter: CGPoint(x: 360, y: 180), startRadius: 0, endCenter: CGPoint(x: 360, y: 180), endRadius: 520,
  options: [])
ctx.restoreGState()

// --- Fat G --------------------------------------------------------------------
// SF Pro Rounded Black, centered optically, with a faint motion trail trailing upward.
ctx.saveGState()
ctx.addPath(bodyPath)
ctx.clip()

var font = NSFont.systemFont(ofSize: 700, weight: .black)
if let rounded = font.fontDescriptor.withDesign(.rounded) { font = NSFont(descriptor: rounded, size: 700) ?? font }

func glyphPath() -> CGPath {
  let line = CTLineCreateWithAttributedString(NSAttributedString(string: "G", attributes: [.font: font]))
  let run = (CTLineGetGlyphRuns(line) as! [CTRun])[0]
  var glyph = CGGlyph()
  CTRunGetGlyphs(run, CFRange(location: 0, length: 1), &glyph)
  return CTFontCreatePathForGlyph(font as CTFont, glyph, nil)!
}
let g = glyphPath()
let gb = g.boundingBoxOfPath
// Glyph paths are y-up; flip into our top-left space and center (nudged up a touch).
func placed(dy: CGFloat) -> CGPath {
  var t = CGAffineTransform(translationX: 512 - gb.midX, y: 500 + gb.midY + dy).scaledBy(x: 1, y: -1)
  return g.copy(using: &t)!
}

// Motion trail
let trail = 12
for i in stride(from: trail, through: 1, by: -1) {
  let t = CGFloat(i) / CGFloat(trail)
  ctx.addPath(placed(dy: -t * 110))
  ctx.setFillColor(rgb(0xffffff, 0.07 * (1 - t) + 0.015))
  ctx.fillPath()
}

// Solid G with a soft shadow and a subtle top-to-bottom tint
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -16), blur: 30, color: rgb(0x14093f, 0.45))
ctx.addPath(placed(dy: 0))
ctx.setFillColor(rgb(0xffffff))
ctx.fillPath()
ctx.restoreGState()

ctx.saveGState()
ctx.addPath(placed(dy: 0))
ctx.clip()
let tint = CGGradient(
  colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [rgb(0xffffff), rgb(0xe4ddff)] as CFArray, locations: [0, 1])!
ctx.drawLinearGradient(tint, start: CGPoint(x: 0, y: 500 - gb.height / 2), end: CGPoint(x: 0, y: 500 + gb.height / 2), options: [])
ctx.restoreGState()
ctx.restoreGState()

NSGraphicsContext.current = nil
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
print("wrote \(out)")
