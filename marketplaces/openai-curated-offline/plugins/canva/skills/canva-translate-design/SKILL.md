---
name: canva-translate-design
description: Translate the text in a Canva design into another language while preserving the original layout as much as possible. Use when the user wants a localized or translated version of an existing Canva design and expects the original file to remain unchanged.
---

# Canva: canva-translate-design

Translate the text in a Canva design into another language while preserving the original layout as much as possible. Use when the user wants a localized or translated version of an existing Canva design and expects the original file to remain unchanged.

If this workflow requires creating, editing, resizing, translating, exporting, or linking a Canva design, use the official Canva connector/app (`connector_68df33b1a2d081918778431a9cfca8ba`) rather than only giving instructions. If the Canva connector is not available or is not authorized, trigger the official connector install/authorization flow for Canva (for example by using the available plugin/connector install request capability with the Canva connector) so the user sees the built-in authorization dialog. After the user authorizes Canva, continue the workflow through the Canva connector and return the editable Canva design link when the connector provides it.

