---
name: create-slide-diagram
description: Turn processes, systems, timelines, hierarchies, and relationships into clear presentation diagrams using structured groups and self-contained SVG. Use when prose or card grids obscure how parts connect.
---

# Create Slide Diagram

## Workflow

1. Extract nodes, relationships, direction, hierarchy, and the intended conclusion.
2. Choose a diagram family: flow, architecture, timeline, cycle, hierarchy, matrix, or causal chain.
3. Remove secondary detail until the diagram has one clear reading path.
4. Build connected SVG geometry and separate editable text labels.
5. Group related elements so the diagram can move as a unit without flattening the whole slide.

Read [diagram-contract.md](references/diagram-contract.md) for geometry and accessibility rules.

## Output Requirements

- Use SVG for arrows, connectors, icons, stars, braces, and decorative geometry.
- Do not type symbols with emoji, Unicode arrows, or dingbat fonts.
- Make direction and grouping visible without relying on color alone.
- Keep labels concise and prevent connector crossings where possible.
