---
name: compose-professional-slides
description: Plan and compose a professional presentation by routing each page to chart, diagram, bitmap-visual, and quality-review capabilities. Use for AI slide outlines, full deck generation, narrative replanning, or converting a short brief into a coherent deck.
---

# Compose Professional Slides

## Workflow

1. Establish the audience, goal, scenario, page count, evidence, and visual direction.
   When a PPTX reference is supplied, use its extracted slide sequence, theme colors, aspect ratio, text hierarchy, density, and media as binding reference evidence.
2. Build a narrative arc with one communication job per page. Use cover and conclusion pages as bookends; include navigation only when the page count or topic complexity benefits from it.
3. Assign each page a semantic type and a visual treatment before drawing it.
4. Route quantitative evidence to `$create-slide-chart`, relationships and processes to `$create-slide-diagram`, and photographic or illustrative focal points to `$generate-slide-visual`.
5. Produce structured 1024x576 Frame JSON with stable, independently movable layers.
6. Run `$review-slide-quality` before accepting the deck.

Read [contracts.md](references/contracts.md) for the page-role and routing contract.

## Preservation Rules

- Preserve user-confirmed titles, claims, order, and factual qualifiers.
- Treat a supplied PPTX as a structural and visual reference, not as permission to copy its unrelated wording, logos, or unsupported claims.
- Maintain a shared deck system while varying page silhouette and reading path.
- Keep text, vector, bitmap, and container layers separate when they serve separate editing purposes.
- Never express decorative graphics with emoji, dingbats, or font glyphs.

## Output Requirements

- Emit the requested page count and no empty pages.
- Use concise presentation copy and real visual hierarchy.
- Keep all meaningful content inside the safe area.
- Request specialist visual work only when it communicates the page more clearly.
