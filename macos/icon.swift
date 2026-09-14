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

// --- Page card ----------------------------------------------------------------
let card = CGRect(x: 262, y: 214, width: 500, height: 612)
let cardPath = CGPath(roundedRect: card, cornerWidth: 44, cornerHeight: 44, transform: nil)
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -18), blur: 36, color: rgb(0x120a40, 0.4))
ctx.addPath(cardPath)
ctx.setFillColor(rgb(0xffffff))
ctx.fillPath()
ctx.restoreGState()

// Page content, drawn many times with a vertical offset and fading alpha = motion blur.
func drawContent(dy: CGFloat, alpha: CGFloat) {
  let x = card.minX + 52
  let w = card.width - 104
  func bar(_ y: CGFloat, _ width: CGFloat, _ h: CGFloat, _ color: UInt32) {
    let r = CGRect(x: x, y: y + dy, width: width, height: h)
    ctx.addPath(CGPath(roundedRect: r, cornerWidth: h / 2, cornerHeight: h / 2, transform: nil))
    ctx.setFillColor(rgb(color, alpha))
    ctx.fillPath()
  }
  // Hero image block
  let hero = CGRect(x: x, y: card.minY + 60 + dy, width: w, height: 170)
  ctx.addPath(CGPath(roundedRect: hero, cornerWidth: 22, cornerHeight: 22, transform: nil))
  ctx.setFillColor(rgb(0xd9d3ff, alpha))
  ctx.fillPath()
  bar(card.minY + 268, w * 0.78, 30, 0x2b2346)
  bar(card.minY + 322, w, 18, 0xb9b5cc)
  bar(card.minY + 356, w * 0.9, 18, 0xb9b5cc)
  bar(card.minY + 390, w * 0.62, 18, 0xb9b5cc)
  bar(card.minY + 452, w * 0.7, 30, 0x2b2346)
  bar(card.minY + 506, w, 18, 0xb9b5cc)
  bar(card.minY + 540, w * 0.84, 18, 0xb9b5cc)
  bar(card.minY + 574, w * 0.5, 18, 0xb9b5cc)
  bar(card.minY + 608, w, 18, 0xb9b5cc)
}

ctx.saveGState()
ctx.addPath(cardPath)
ctx.clip()
// Symmetric shutter-style streaks along the scroll direction, sharp frame on top.
let streaks = 14
for i in 1...streaks {
  let t = CGFloat(i) / CGFloat(streaks)
  let a = 0.16 * (1 - t) + 0.03
  drawContent(dy: -t * 150, alpha: a)
  drawContent(dy: t * 60, alpha: a * 0.8)
}
drawContent(dy: 0, alpha: 1)
// Fade the bottom of the card so the page reads as continuing below.
let fade = CGGradient(
  colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [rgb(0xffffff, 0), rgb(0xffffff, 1)] as CFArray,
  locations: [0, 1])!
ctx.drawLinearGradient(
  fade, start: CGPoint(x: 0, y: card.maxY - 90), end: CGPoint(x: 0, y: card.maxY - 4), options: [])
ctx.restoreGState()

// --- Record dot ---------------------------------------------------------------
let dotCenter = CGPoint(x: card.maxX - 6, y: card.minY + 6)
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -6), blur: 16, color: rgb(0x3a0010, 0.4))
ctx.addEllipse(in: CGRect(x: dotCenter.x - 74, y: dotCenter.y - 74, width: 148, height: 148))
ctx.setFillColor(rgb(0xffffff))
ctx.fillPath()
ctx.restoreGState()
ctx.addEllipse(in: CGRect(x: dotCenter.x - 56, y: dotCenter.y - 56, width: 112, height: 112))
ctx.setFillColor(rgb(0xff4d5e))
ctx.fillPath()

NSGraphicsContext.current = nil
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
print("wrote \(out)")
