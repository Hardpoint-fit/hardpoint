// How the builder words the game's enum names: their spaced, uppercase form (ECM stays ECM). Stats use
// the game's own labels (stat-format.ts); ammo payloads are stat-like names worded the same way.
export function enumWords(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").toUpperCase();
}

/** ModuleRarity as players see it: Normal reads STANDARD. */
export function rarityName(rarity: string): string {
  return rarity === "Normal" ? "STANDARD" : enumWords(rarity);
}

export function roleName(role: string): string {
  return role === "None" ? "NO ROLE" : enumWords(role);
}
