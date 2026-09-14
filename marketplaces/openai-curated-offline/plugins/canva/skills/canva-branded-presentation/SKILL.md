---
name: canva-branded-presentation
description: Create on-brand Canva presentations from a brief, outline, existing Canva doc, or design link. Use when the user wants a branded slide deck, wants to turn notes into a presentation, or needs a presentation generated in Canva with the right brand kit and a clear slide plan.
---

# Canva: canva-branded-presentation

Create on-brand Canva presentations from a brief, outline, existing Canva doc, or design link. Use when the user wants a branded slide deck, wants to turn notes into a presentation, or needs a presentation generated in Canva with the right brand kit and a clear slide plan.

If this workflow requires creating, editing, resizing, translating, exporting, or linking a Canva design, use the official Canva connector/app (`connector_68df33b1a2d081918778431a9cfca8ba`) rather than only giving instructions. If the Canva connector is not available or is not authorized, trigger the official connector install/authorization flow for Canva (for example by using the available plugin/connector install request capability with the Canva connector) so the user sees the built-in authorization dialog. After the user authorizes Canva, continue the workflow through the Canva connector and return the editable Canva design link when the connector provides it.

