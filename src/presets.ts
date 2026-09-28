import type { Preset, PresetTiers } from "./model.js";

export function readPresetTiers(value: unknown, defaultPreset: string): PresetTiers {
  const tiers = record(value, "preset_tiers");
  if (Object.keys(tiers).length !== 3) throw new Error("preset_tiers must contain exactly three tiers");
  const result: PresetTiers = {};
  let slots: string[] | undefined;
  for (const [tier, raw] of Object.entries(tiers)) {
    if (!tier.trim()) throw new Error("Tier names must be nonempty");
    const presets = record(raw, `tier ${tier}`);
    const names = Object.keys(presets).sort();
    if (names.length !== 4 || names.some(name => !name.trim())) throw new Error(`Tier ${tier} must contain exactly four named presets`);
    if (!names.includes(defaultPreset)) throw new Error(`Tier ${tier} must contain default preset ${defaultPreset}`);
    if (slots && JSON.stringify(names) !== JSON.stringify(slots)) throw new Error("All tiers must use the same four preset names so host tier changes preserve agent assignments");
    slots = names;
    const parsed: Record<string, Preset> = {};
    for (const [name, rawPreset] of Object.entries(presets)) {
      const preset = record(rawPreset, `${tier}.${name}`);
      if (Object.keys(preset).some(key => !["model", "reasoning_effort", "service_tier"].includes(key))) throw new Error(`Unknown preset field in ${tier}.${name}`);
      for (const key of ["model", "reasoning_effort", ...(preset.service_tier === undefined ? [] : ["service_tier"])]) {
        if (typeof preset[key] !== "string" || !preset[key].trim()) throw new Error(`${tier}.${name}.${key} must be a nonempty string`);
      }
      parsed[name] = { model: preset.model as string, reasoning_effort: preset.reasoning_effort as string, ...(preset.service_tier === undefined ? {} : { service_tier: preset.service_tier as string }) };
    }
    result[tier] = parsed;
  }
  return result;
}

export function allTierPresets(tiers: PresetTiers): Record<string, Preset> {
  return Object.fromEntries(Object.entries(tiers).flatMap(([tier, presets]) => Object.entries(presets).map(([name, preset]) => [`${tier}/${name}`, preset])));
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} must be an object`);
  return value as Record<string, unknown>;
}
