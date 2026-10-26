# S39 design-direction mockups

Three directions for the redesign (ADR-0044, [DESIGN.md](../../design/DESIGN.md) §2), each with the same five phone screens: Home card board, Calendar day, Client profile, the public booking page (in the shop's own colour, PCR-001) and an approval card with Why? and Undo. Light, plus a dark row per direction. Every screen shows one made-up shop: Southside Cuts, Chicago, on Tue Oct 27 (barbers Dre and Randy, prices from `packages/templates/src/catalog/barber.ts`).

- **Live, clickable canvas (private to the owner):** https://claude.ai/artifact/QCiTKo7b95kE6MAtXjNQCY
- `canvas/`: the canvas sources (`.dc.html` artboards and `canvas.json`). They need the canvas runtime and don't open on their own.
- `contrast.py`: the WCAG contrast check of each direction's token pairs, light and dark (`python3 docs/mockups/s39/contrast.py`; all pass).

The mockups load Google Fonts (decision D-2 at the S39 brief). The app self-hosts its fonts (DESIGN.md D11, from S40).
