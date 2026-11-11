# Apple platform symbol masks

These monochrome assets were rendered from the operating system's SF Symbols using `NSImage(systemSymbolName:)`. They are Apple-provided symbol artwork, not original project artwork. Their use remains subject to Apple's SF Symbols terms; the project's AGPL license does not relicense Apple's artwork.

They are selected only on Apple platforms. Other platforms retain the original SVG icons in `src/ui/icons.tsx`. The runtime uses static PNG masks; it does not call UIKit/AppKit or provide native symbol animation.

Regenerate on macOS from the mobile directory:

```sh
swift scripts/export-apple-symbols.swift public/symbols
```

`symbols.json` maps existing product icon identifiers to SF Symbols names. Artwork is 96 × 96 and intended for 24pt or smaller UI slots.

Reference: https://developer.apple.com/design/human-interface-guidelines/sf-symbols
