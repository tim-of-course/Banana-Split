# Tiers and presets

## Choosing a preset

| Preset | Use for |
| --- | --- |
| `complex-judgment` | Truly complex work, especially work requiring significant judgment that is not being handled by the user |
| `default-judgment` | Default for judgment calls, advisor work, coordination, and complex work |
| `general-workhorse` | Less-defined workhorse work, including complex or critical tasks |
| `defined-workhorse` | Well-defined workhorse tasks, low-cost bulk work, or implementation paired with a judgment-tier advisor |

## Tiers

Tiers mix Claude and Codex models. Start each thread on the provider its model belongs to.

| Preset | `cost-optimized` | `default` | `performance-optimized` | `max-performance` |
| --- | --- | --- | --- | --- |
| `complex-judgment` | claude-sonnet-5-5 · high | claude-opus-5-5 · medium | claude-opus-5-5 · high | claude-opus-5-5 · xhigh |
| `default-judgment` | gpt-6.1-terra · high | gpt-6.1-sol · medium | claude-opus-5-5 · medium | claude-opus-5-5 · high |
| `general-workhorse` | gpt-6.1-terra · medium | gpt-6.1-terra · high | gpt-6.1-sol · medium | claude-opus-5-5 · medium |
| `defined-workhorse` | gpt-6.1-terra · low | gpt-6.1-terra · medium | gpt-6.1-terra · high | gpt-6.1-sol · medium |

## Rules

- Use the tier the user selected. If a model isn't available, say so and ask; don't silently substitute another.
- The user can switch tiers mid-workflow. Log a `note` in the directory. Agents already running keep their settings, and new agents use the new tier.
- If the user supplies their own tier definitions, use them and mention the override in the recap.
