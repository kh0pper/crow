# Home Assistant API Reference

## Setup

Home Assistant requires two environment variables:

- `HOMEASSISTANT_URL`: Your Home Assistant URL (e.g., `http://homeassistant.local:8123`)
- `HOMEASSISTANT_TOKEN`: Long-lived access token (generated in Home Assistant UI: Profile > Long-Lived Access Tokens)

### Generate a Token

1. Open Home Assistant web UI
2. Click your username (bottom left)
3. Scroll to "Long-Lived Access Tokens"
4. Click "Create Token"
5. Name it (e.g., "OpenClaw") and copy the token

## Common Entity Types

### Lights
- Entity ID pattern: `light.<name>`
- Services: `turn_on`, `turn_off`, `toggle`
- Attributes: brightness (0-255), rgb_color, color_temp

### Switches
- Entity ID pattern: `switch.<name>`
- Services: `turn_on`, `turn_off`, `toggle`

### Sensors
- Entity ID pattern: `sensor.<name>`
- Read-only, returns state value

### Binary Sensors
- Entity ID pattern: `binary_sensor.<name>`
- Returns: `on` or `off`

### Climate (Thermostats)
- Entity ID pattern: `climate.<name>`
- Services: `set_temperature`, `set_hvac_mode`
- Attributes: temperature, current_temperature, hvac_modes

### Covers (Blinds, Garage Doors)
- Entity ID pattern: `cover.<name>`
- Services: `open_cover`, `close_cover`, `stop_cover`, `toggle`

### Input Entities
- `input_boolean.<name>`: on/off
- `input_number.<name>`: numeric value
- `input_text.<name>`: text string
- Service: `set_value` with `value` parameter

## Common Service Calls

### Turn on light with brightness
```json
{
  "domain": "light",
  "service": "turn_on",
  "service_data": {
    "entity_id": "light.kitchen",
    "brightness": 200
  }
}
```

### Set thermostat temperature
```json
{
  "domain": "climate",
  "service": "set_temperature",
  "service_data": {
    "entity_id": "climate.thermostat",
    "temperature": 72
  }
}
```

### Turn on all lights
```json
{
  "domain": "light",
  "service": "turn_on",
  "service_data": {
    "entity_id": "all"
  }
}
```

## Entity State Structure

```json
{
  "entity_id": "light.kitchen",
  "state": "on",
  "attributes": {
    "friendly_name": "Kitchen",
    "brightness": 200,
    "rgb_color": [255, 200, 150],
    "supported_color_modes": ["brightness", "color_temp"]
  },
  "last_changed": "2025-01-28T12:00:00Z",
  "last_updated": "2025-01-28T12:00:00Z"
}
```

## API Response Handling

- Success: Returns JSON response with entity state or service call confirmation
- Error: Returns `{"error": "message"}` on failures
- Common errors: invalid entity ID, unauthorized, service not supported

## Best Practices

1. **Use friendly names**: Entity IDs can be cryptic, check `attributes.friendly_name`
2. **Check capabilities**: Not all devices support all services (e.g., some switches don't support brightness)
3. **Handle errors gracefully**: Always check for error responses
4. **Group operations**: Use `all`, `group.<name>` for bulk operations

## Searching Entities

When you don't know the exact entity ID:
1. List all entities and search by friendly name
2. Common patterns: `light.<room>`, `switch.<device>`, `sensor.<metric>`
3. Use Home Assistant UI: Developer Tools > States to browse entities
