# Cherry Accent asset prompts

**Historical concept-generation record.** The current delivered assets are rebuilt vector masters and deterministic PNG exports from `source/geometry.json`, not the generated raster outputs described below. See `README.md` and `build.cjs` for the current source and export method.

## Delivered assets: solid backgrounds

These are the final asset-generation prompts. `transparent_background: false`. The reference is the approved Cherry Accent concept board.

### logo-light.png

```text
Use case: logo-brand. Prepare a standalone brand asset from the approved Cherry Accent concept in the attached image. The reference is the exact design target.
Preserve the large primary logo's three yellow banana-peel sections, rounded lowercase lettering "banana split", and cherry-red i-dot. Preserve proportions, curves, lettering and kerning. This is not a new design.
Delete all presentation-board elements, titles, dividers, sample versions, labels, and margins unrelated to the standalone asset. Render crisp smooth filled shapes on the specified perfectly uniform opaque background. Use flat colors with no texture, shading, gradient, outlines, shadows, speckles or noise. The channels between the yellow sections and all letter counters must match the background exactly.
Show just ONE logo asset, not a concept board. The full asset must fit inside the canvas with even comfortable padding.
Create the single horizontal logo on a pure solid ivory #F7F5EF background. Yellow symbol #F4C542, cocoa wordmark #302522, cherry i-dot #C95246. Wide 3:1 image. Preserve the reference geometry.
```

### logo-dark.png

```text
Use case: logo-brand. Prepare a standalone brand asset from the approved Cherry Accent concept in the attached image. The reference is the exact design target.
Preserve the large primary logo's three yellow banana-peel sections, rounded lowercase lettering "banana split", and cherry-red i-dot. Preserve proportions, curves, lettering and kerning. This is not a new design.
Delete all presentation-board elements, titles, dividers, sample versions, labels, and margins unrelated to the standalone asset. Render crisp smooth filled shapes on the specified perfectly uniform opaque background. Use flat colors with no texture, shading, gradient, outlines, shadows, speckles or noise. The channels between the yellow sections and all letter counters must match the background exactly.
Show just ONE logo asset, not a concept board. The full asset must fit inside the canvas with even comfortable padding.
Create the single horizontal logo on a pure solid charcoal #20221F background. Yellow symbol #F4C542, ivory wordmark #F7F5EF, cherry i-dot #C95246. Wide 3:1 image. Preserve the reference geometry.
```

### icon.png

```text
Use case: logo-brand. Prepare a standalone brand asset from the approved Cherry Accent concept in the attached image. The reference is the exact design target.
Preserve the large primary logo's three yellow banana-peel sections, rounded lowercase lettering "banana split", and cherry-red i-dot. Preserve proportions, curves, lettering and kerning. This is not a new design.
Delete all presentation-board elements, titles, dividers, sample versions, labels, and margins unrelated to the standalone asset. Render crisp smooth filled shapes on the specified perfectly uniform opaque background. Use flat colors with no texture, shading, gradient, outlines, shadows, speckles or noise. The channels between the yellow sections and all letter counters must match the background exactly.
Show just ONE logo asset, not a concept board. The full asset must fit inside the canvas with even comfortable padding.
Create ONLY the three-piece yellow banana-peel symbol on a pure solid charcoal #20221F square background. No lettering, no cherry dot, no other objects. Preserve the original symbol geometry. Center the symbol optically, occupying about 75% of the square width. Square 1024 x 1024 image. Background must fill the entire square, not a rounded rectangle inside another background.
```

## Rejected transparent attempts

The following earlier prompts are retained only as provenance. Their outputs failed visual review and are not the delivered assets.


## Cleanup pass

The first transparent exports contained edge artifacts. Each corresponding transparent export was passed back as the edit target with this prompt and `transparent_background: true`:

```text
Use case: logo-brand. Edit target: supplied transparent PNG logo.
Fix only the rough cutout edges and stray colored pixels of this asset. Carefully REDRAW every existing colored silhouette as a clean smooth opaque flat shape, preserving the approved outer contours, internal letter counters, placement, spacing, and overall composition. This needs a proper clean graphic redraw, not another rough background-removal pass.
CRITICAL: erase ALL stray yellow or white fragments in negative-space channels, ALL dirty white outlines and speckles around lettering, ALL texture and mottling, ALL little colored islands outside the intended main shapes. The two curved channels between the three banana peel sections should be perfectly smooth continuous open transparent channels with no debris. Each letter must have a solid fully opaque interior and smooth clean antialiased contour. All counters are transparent. Retain the original shape design and spelling. No contour strokes around any object.
Use perfectly uniform flat fills: banana yellow #F4C542 for the banana, cherry red #C95246 for the i dot if present. Preserve whether the text in this specific target is ivory or cocoa. If this target contains only the standalone banana symbol, keep it symbol-only with no text or red dot. True transparent background everywhere else. Match the original canvas aspect ratio and composition. Return ONLY the cleaned transparent asset. No mockup, no checkerboard, no added backdrop, no additional samples or labels.
```


Tool: built-in `image_gen`. Mode: edit. Reference: `output/branding/dessert-options/03-cherry-accent.png`. `transparent_background: true` for all three assets.

## logo-light.png

```text
Use case: logo-brand.
Asset type: standalone transparent PNG brand asset for the selected Cherry Accent identity of Banana Split.
Input image 1 is the approved design and the exact edit target. Preserve its symbol design and custom lettering. This is asset preparation, not another concept exploration.
Use the large primary logo in the upper portion of the reference as the geometry source. It has three yellow curved banana peel sections that share a pointed origin on the left and fan upward to three rounded ends on the right. The exact heavy rounded lowercase wordmark is "banana split". The round dot of the i in split is cherry red.
Preserve the original proportions, curves, shapes of letters, kerning, relative symbol/wordmark scale, and the cherry-red dot position. Crisp precise edges. Remove the board's title, rules, other examples, labels, backdrop, and texture completely. Flatten fills; no shading, gradients, texture, shadows, bevels, 3D, new decorations or slogan.
The entire background must be truly transparent, including the counters of letters and all negative-space channels between the yellow sections. No checkerboard drawn into the pixels, no white or ivory rectangle.
Produce only the one requested asset, centered with modest even transparent padding. No multiple versions or presentation board.
Asset requested: the complete original horizontal logo, symbol plus wordmark, for use on LIGHT backgrounds. Symbol flat banana yellow #F4C542; wordmark flat dark cocoa #302522; ONLY the round dot over the i in split flat cherry red #C95246. Preserve the original friendly heavy custom letter shapes. Wide landscape canvas about 3:1, at high resolution (ideally 3072 x 1024), logo occupies roughly 88% of image width. No background.
```

## logo-dark.png

```text
Use case: logo-brand.
Asset type: standalone transparent PNG brand asset for the selected Cherry Accent identity of Banana Split.
Input image 1 is the approved design and the exact edit target. Preserve its symbol design and custom lettering. This is asset preparation, not another concept exploration.
Use the large primary logo in the upper portion of the reference as the geometry source. It has three yellow curved banana peel sections that share a pointed origin on the left and fan upward to three rounded ends on the right. The exact heavy rounded lowercase wordmark is "banana split". The round dot of the i in split is cherry red.
Preserve the original proportions, curves, shapes of letters, kerning, relative symbol/wordmark scale, and the cherry-red dot position. Crisp precise edges. Remove the board's title, rules, other examples, labels, backdrop, and texture completely. Flatten fills; no shading, gradients, texture, shadows, bevels, 3D, new decorations or slogan.
The entire background must be truly transparent, including the counters of letters and all negative-space channels between the yellow sections. No checkerboard drawn into the pixels, no white or ivory rectangle.
Produce only the one requested asset, centered with modest even transparent padding. No multiple versions or presentation board.
Asset requested: the complete original horizontal logo, symbol plus wordmark, for use on DARK backgrounds. Same exact primary logo geometry as the reference, but wordmark flat ivory #F7F5EF instead of dark cocoa. Symbol flat banana yellow #F4C542; ONLY the round dot over the i in split flat cherry red #C95246. Transparent canvas, no dark rectangle. Wide landscape canvas about 3:1, at high resolution (ideally 3072 x 1024), logo occupies roughly 88% of image width. No background.
```

## icon.png

```text
Use case: logo-brand.
Asset type: standalone transparent PNG brand asset for the selected Cherry Accent identity of Banana Split.
Input image 1 is the approved design and the exact edit target. Preserve its symbol design and custom lettering. This is asset preparation, not another concept exploration.
Use the large primary logo in the upper portion of the reference as the geometry source. It has three yellow curved banana peel sections that share a pointed origin on the left and fan upward to three rounded ends on the right. The exact heavy rounded lowercase wordmark is "banana split". The round dot of the i in split is cherry red.
Preserve the original proportions, curves, shapes of letters, kerning, relative symbol/wordmark scale, and the cherry-red dot position. Crisp precise edges. Remove the board's title, rules, other examples, labels, backdrop, and texture completely. Flatten fills; no shading, gradients, texture, shadows, bevels, 3D, new decorations or slogan.
The entire background must be truly transparent, including the counters of letters and all negative-space channels between the yellow sections. No checkerboard drawn into the pixels, no white or ivory rectangle.
Produce only the one requested asset, centered with modest even transparent padding. No multiple versions or presentation board.
Asset requested: ONLY the original three-piece banana peel SYMBOL. Remove all lettering and the cherry dot; the cherry is part of the wordmark, not the standalone symbol. Preserve the exact original three yellow curved sections and their negative-space channels, including the common pointed left origin and rounded rising right ends. Flat banana yellow #F4C542. Center the whole mark optically within a square 1024 x 1024 transparent canvas, occupying about 80% of the width. No square tile, no background, no text, no added shapes.
```
