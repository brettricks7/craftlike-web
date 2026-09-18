# Ability HUD stamps (Day 232)

Mapped for human final replacement — Bob placeholders, not finals.

| id | silhouette | path |
| --- | --- | --- |
| blink | asymmetric rightward chevrons (no ring) | `art/abilities/blink.png` |
| shield | heater shield + gold core | `art/abilities/shield.png` |
| pull | four-way inward suction arrows | `art/abilities/pull.png` |
| nova | red ring + 8-ray burst | `art/abilities/nova.png` |

Runtime: `src/art.js` → `abilitySrc` / `drawAbilityIcon` (HUD 22 / Lab 36 / splicer 44).
Empty B slot: text `B: empty (R)` — no stamp.
FX companions: `art/fx/{id}.png` (cast juice; separate from HUD stamps).
Pre-232 backups (local only): `art/abilities/_pre232/` — do not ship.
