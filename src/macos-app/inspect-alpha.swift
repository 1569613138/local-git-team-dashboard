import AppKit
import Foundation

let arguments = CommandLine.arguments
if arguments.count != 2 {
    fputs("usage: inspect-alpha <image>\n", stderr)
    exit(2)
}

guard let image = NSImage(contentsOfFile: arguments[1]),
      let tiff = image.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: tiff) else {
    fputs("cannot load image\n", stderr)
    exit(3)
}

let points = [(0, 0), (10, 10), (50, 50), (82, 82), (512, 512), (1023, 1023)]
for (x, y) in points {
    guard let color = bitmap.colorAt(x: min(x, bitmap.pixelsWide - 1), y: min(y, bitmap.pixelsHigh - 1))?.usingColorSpace(.deviceRGB) else { continue }
    print("\(x),\(y): alpha=\(String(format: "%.3f", color.alphaComponent)) rgb=\(String(format: "%.3f", color.redComponent)),\(String(format: "%.3f", color.greenComponent)),\(String(format: "%.3f", color.blueComponent))")
}
print("size=\(bitmap.pixelsWide)x\(bitmap.pixelsHigh) alpha=\(bitmap.hasAlpha)")
