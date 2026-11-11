// Static monochrome SF Symbols for Apple platforms; not a WebView native API.
// Run from the mobile directory: swift scripts/export-apple-symbols.swift public/symbols
import AppKit
let output = CommandLine.arguments[1]
let symbols: [String: String] = [
 "today":"calendar", "wave":"waveform", "shelf":"books.vertical", "mark":"bookmark", "me":"person.crop.circle",
 "play":"play.fill", "pause":"pause.fill", "prev":"backward.end.fill", "next":"forward.end.fill", "mic":"mic",
 "cam":"camera", "clip":"doc.on.clipboard", "gear":"gearshape", "speaker":"speaker.wave.2", "slow":"tortoise",
 "search":"magnifyingglass", "share":"square.and.arrow.up", "close":"xmark", "check":"checkmark", "right":"chevron.right", "left":"chevron.left",
 "eye":"eye", "translate":"character.bubble", "eyeoff":"eye.slash", "undo":"arrow.uturn.backward", "kbd":"keyboard", "stop":"stop.fill",
 "note":"note.text", "noteFill":"note.text", "star":"star", "plus":"plus", "aa":"textformat.size", "dots":"ellipsis", "bolt":"bolt", "chat":"bubble.left.and.bubble.right",
 "book":"book.closed", "hist":"clock.arrow.circlepath", "flask":"flask", "trash":"trash", "copy":"doc.on.doc", "chevr":"chevron.right",
 "bookopen":"book", "bookopenFill":"book.fill", "win":"desktopcomputer", "target":"scope", "lock":"lock", "sync":"arrow.triangle.2.circlepath", "info":"info.circle",
 "bulb":"lightbulb", "phone":"iphone", "rss":"dot.radiowaves.left.and.right", "bell":"bell", "clock":"clock", "list":"list.bullet", "pen":"square.and.pencil"
]
try FileManager.default.createDirectory(atPath: output, withIntermediateDirectories: true)
for (key, name) in symbols {
 guard let original = NSImage(systemSymbolName:name, accessibilityDescription:nil), let symbol = original.withSymbolConfiguration(.init(pointSize:20, weight:key == "noteFill" ? .semibold : .regular)) else { fatalError("Missing symbol: \(name)") }
 let rep = NSBitmapImageRep(bitmapDataPlanes:nil, pixelsWide:96, pixelsHigh:96, bitsPerSample:8, samplesPerPixel:4, hasAlpha:true, isPlanar:false, colorSpaceName:.deviceRGB, bytesPerRow:0, bitsPerPixel:0)!
 rep.size = NSSize(width:24,height:24)
 NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep:rep)
 NSColor.clear.setFill(); NSRect(x:0,y:0,width:24,height:24).fill()
 let scale = min(22 / symbol.size.width, 22 / symbol.size.height)
 let size = NSSize(width:symbol.size.width * scale, height:symbol.size.height * scale)
 symbol.draw(in:NSRect(x:(24-size.width)/2,y:(24-size.height)/2,width:size.width,height:size.height))
 NSGraphicsContext.restoreGraphicsState()
 try rep.representation(using:.png,properties:[:])!.write(to:URL(fileURLWithPath:output+"/"+key+".png"))
}
try JSONSerialization.data(withJSONObject:symbols,options:[.prettyPrinted,.sortedKeys]).write(to:URL(fileURLWithPath:output+"/symbols.json"))
print("Exported \(symbols.count) SF Symbols masks")
