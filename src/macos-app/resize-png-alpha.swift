import AppKit
import Foundation

let arguments = CommandLine.arguments
if arguments.count != 4 {
    fputs("usage: resize-png-alpha <input> <output> <size>\n", stderr)
    exit(2)
}

guard let dimension = Int(arguments[3]), dimension > 0,
      let source = NSImage(contentsOfFile: arguments[1]) else {
    fputs("invalid input\n", stderr)
    exit(3)
}

guard let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: dimension,
    pixelsHigh: dimension,
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

let size = NSSize(width: dimension, height: dimension)
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
NSColor.clear.setFill()
NSRect(origin: .zero, size: size).fill()
NSGraphicsContext.current?.imageInterpolation = .high
source.draw(in: NSRect(origin: .zero, size: size), from: .zero, operation: .sourceOver, fraction: 1)
NSGraphicsContext.restoreGraphicsState()

bitmap.size = size
guard let data = bitmap.representation(using: .png, properties: [:]) else {
    fputs("cannot encode png\n", stderr)
    exit(5)
}
try data.write(to: URL(fileURLWithPath: arguments[2]), options: .atomic)
