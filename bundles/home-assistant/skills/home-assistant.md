---
name: home-assistant
description: Control smart home devices through Home Assistant
triggers:
  - lights
  - temperature
  - smart home
  - home assistant
  - turn on
  - turn off
  - thermostat
tools:
  - home-assistant
  - crow-memory
---

# Home Assistant Integration

## When to Activate

- User wants to control lights, switches, thermostats, or other smart devices
- User asks about home status (temperature, sensor readings)
- User mentions Home Assistant, smart home, or specific device names

## Safety — Physical Device Control

**This integration controls physical devices in the user's home. All actuation commands require explicit confirmation.**

Before any action that changes device state:

**[crow checkpoint: About to [action description]. Confirm?]**

Examples:
- **[crow checkpoint: About to turn off all lights in "Living Room". Confirm?]**
- **[crow checkpoint: About to set thermostat to 72°F. Confirm?]**
- **[crow checkpoint: About to lock the front door. Confirm?]**

Never batch multiple actuations without listing each one in the checkpoint.

## Workflow 1: Control Devices

1. Identify what the user wants to control
2. List available devices/entities if needed
3. Show checkpoint with the specific action
4. Execute after confirmation
5. Report the result

## Workflow 2: Check Status

Status queries (read-only) do NOT need confirmation:
- "What's the temperature?"
- "Are the lights on?"
- "Show me sensor readings"

Just query and report.

## Workflow 3: Scenes and Automations

For scene activation or automation triggers:
1. List available scenes/automations
2. Show checkpoint: **[crow checkpoint: About to activate scene "Movie Night" (dims lights, closes blinds). Confirm?]**
3. Execute after confirmation

## Tips

- Store the user's preferred device names in memory for natural language matching
- If a device name is ambiguous, ask for clarification before acting
- Group related status queries into a single response
- Remember common routines (e.g., "goodnight" = specific set of actions) in Crow memory

## Error Handling

- If Home Assistant is unreachable, tell the user to check their HA instance
- If a device entity is not found, list similar entities to help the user identify the right one
