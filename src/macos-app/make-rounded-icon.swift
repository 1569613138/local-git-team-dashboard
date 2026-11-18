import AppKit
import Foundation

let arguments = CommandLine.arguments
 guard arguments.count == 3 else {
    fputs("usage: make-rounded-icon <input> <output>\n", stderr)
    exit(2)
}

let inputURL = URL(fileURLWithPath: arguments[1])
let outputURL = URL(fileURLWithPath: arguments[2])
guard let source = NSImage(contentsOf: inputURL) else {
    fputs("cannot read input image\n", stderr)
    exit(3)
}

let size = NSSize(width: 1024, height: 1024)
guard let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: 1024,
    pixelsHigh: 1024,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
) else {
    fputs("cannot create bitmap\n", stderr)
    exit(4)
}

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
NSColor.clear.setFill()
NSRect(origin: .zero, size: size).fill()

// Preserve the generated rounded-square icon body and remove only its square canvas.
let bodyRect = NSRect(x: 82, y: 82, width: 860, height: 860)
let mask = NSBezierPath(roundedRect: bodyRect, xRadius: 185, yRadius: 185)
mask.addClip()
source.draw(in: NSRect(origin: .zero, size: size), from: .zero, operation: .copy, fraction: 1)
NSGraphicsContext.restoreGraphicsState()

bitmap.size = size
guard let data = bitmap.representation(using: .png, properties: [:]) else {
    fputs("cannot encode output image\n", stderr)
    exit(5)
}
try data.write(to: outputURL, options: .atomic)
