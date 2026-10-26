"""S39: contrast of each mockup direction's token pairs (WCAG 2.2: text 4.5:1, icons/borders 3:1).

Run: python3 docs/mockups/s39/contrast.py  (exit 1 if any pair fails)
The user chose A+B in S39 (A's colors). S40 moves the chosen direction's values into packages/ui/src/tokens.ts, where theme.test.ts takes over.
"""
import sys

DIRECTIONS = {
    "A warm boutique": {
        "light": dict(bg="#F6F1EC", surface="#FFFDFB", surface2="#EFE7DF", ink="#2A1F26", ink2="#5E4F58", ink3="#6F5E68",
                      line="#E4D8CD", lineStrong="#8E7C86", brand="#5A2D52", brandInk="#FFFFFF", brandSoft="#F0E2EC", accent="#E8A33D", accentInk="#2A1F26",
                      ok="#2F6B4F", warn="#8A5A00", danger="#B3261E", info="#2F5E8A",
                      accentSoft="#F8E7C8", okSoft="#E3EFE7", warnSoft="#F7E9CC", dangerSoft="#F6DEDB", infoSoft="#E1EAF3"),
        "dark": dict(bg="#1A1418", surface="#241C21", surface2="#2E242B", ink="#F5EDF1", ink2="#CDBFC7", ink3="#A898A2",
                     line="#3A2F36", lineStrong="#8A7A84", brand="#E0B3D6", brandInk="#2A1023", brandSoft="#3B2737", accent="#F2B85A", accentInk="#2A1F26",
                     ok="#7FCBA4", warn="#F0C26B", danger="#FF8A80", info="#9CC3E8",
                     accentSoft="#3D3018", okSoft="#1F3A2D", warnSoft="#3D3018", dangerSoft="#3D1E1C", infoSoft="#1C2A38"),
    },
    "B clean premium": {
        "light": dict(bg="#FAFAFA", surface="#FFFFFF", surface2="#F3F3F2", ink="#0E0E10", ink2="#4A4A50", ink3="#6B6B72",
                      line="#E6E6E8", lineStrong="#8A8A92", brand="#0E0E10", brandInk="#FFFFFF", brandSoft="#EEEEF0", accent="#1E7B54", accentInk="#FFFFFF",
                      ok="#1E7B54", warn="#8F5B00", danger="#C4271C"),
        "dark": dict(bg="#0A0A0B", surface="#141416", surface2="#1C1C1F", ink="#F4F4F5", ink2="#B4B4BA", ink3="#8E8E96",
                     line="#26262A", lineStrong="#6E6E76", brand="#F4F4F5", brandInk="#0A0A0B", brandSoft="#232327", accent="#4FD39A", accentInk="#0A0A0B",
                     ok="#4FD39A", warn="#F2B44B", danger="#FF7A6E"),
    },
    "C bold modern": {
        "light": dict(bg="#F2F0EA", surface="#FFFFFF", surface2="#E6E3DA", ink="#0B0B0B", ink2="#3D3D3D", ink3="#595959",
                      line="#0B0B0B", lineStrong="#0B0B0B", brand="#BA2A13", brandInk="#FFFFFF", brandSoft="#FCE9E3", accent="#D4F04A", accentInk="#0B0B0B",
                      ok="#1A6B37", warn="#8A5600", danger="#B3261E"),
        "dark": dict(bg="#0B0B0B", surface="#171717", surface2="#222222", ink="#FAFAF7", ink2="#C9C9C4", ink3="#9C9C96",
                     line="#FAFAF7", lineStrong="#FAFAF7", brand="#FF5A3C", brandInk="#0B0B0B", brandSoft="#3A1A13", accent="#D4F04A", accentInk="#0B0B0B",
                     ok="#6BD68F", warn="#F2B44B", danger="#FF8A80"),
    },
}
# The business's own color on the booking page (PCR-001): Southside Cuts' teal, same in every direction.
BUSINESS = {"light": dict(brand="#145A55", brandInk="#FFFFFF"), "dark": dict(brand="#6FCFC4", brandInk="#06201E")}

TEXT_ON = ["bg", "surface", "surface2"]
TEXT = ["ink", "ink2", "ink3", "ok", "warn", "danger"]


def lum(hex_: str) -> float:
    c = [int(hex_[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    c = [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c]
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]


def ratio(a: str, b: str) -> float:
    la, lb = sorted((lum(a), lum(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def pairs(t: dict):
    for g in TEXT_ON:
        for f in TEXT:
            yield f"{f} on {g}", t[f], t[g], 4.5
        # `line` is a decorative divider (no WCAG minimum); `lineStrong` marks inputs and controls (1.4.11, 3:1).
        yield f"lineStrong on {g}", t["lineStrong"], t[g], 3.0
        yield f"brand on {g}", t["brand"], t[g], 4.5
    yield "brandInk on brand", t["brandInk"], t["brand"], 4.5
    yield "brand on brandSoft", t["brand"], t["brandSoft"], 4.5
    yield "ink on brandSoft", t["ink"], t["brandSoft"], 4.5
    yield "accentInk on accent", t["accentInk"], t["accent"], 4.5
    # The chosen direction (A+B uses A's colors) also has status colors on their soft fills.
    for k in ("ok", "warn", "danger", "info"):
        if k + "Soft" in t:
            yield f"{k} on {k}Soft", t[k], t[k + "Soft"], 4.5
    if "accentSoft" in t:
        yield "ink on accentSoft", t["ink"], t["accentSoft"], 4.5


failed = 0
for name, modes in DIRECTIONS.items():
    for mode, t in modes.items():
        worst = min(pairs(t), key=lambda p: ratio(p[1], p[2]) / p[3])
        for label, f, b, need in pairs(t):
            r = ratio(f, b)
            if r < need:
                failed += 1
                print(f"FAIL {name} {mode}: {label} {r:.2f} < {need}")
        print(f"ok   {name} {mode}: worst pair {worst[0]} {ratio(worst[1], worst[2]):.2f}")
for mode, t in BUSINESS.items():
    for g in ("bg", "surface"):
        for name, modes in DIRECTIONS.items():
            r = ratio(t["brand"], modes[mode][g])
            if r < 4.5:
                failed += 1
                print(f"FAIL business brand on {name} {mode} {g}: {r:.2f}")
    r = ratio(t["brandInk"], t["brand"])
    print(f"{'FAIL' if r < 4.5 else 'ok  '} business brandInk on brand {mode}: {r:.2f}")
    failed += r < 4.5
sys.exit(1 if failed else 0)
