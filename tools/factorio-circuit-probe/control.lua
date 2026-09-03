-- Read-only observations, NOT capability assertions. No automatic event handlers.
-- API contract reviewed against Factorio 2.1.16; native execution still needs verification.
local output_path = "comblang/circuit-observations.jsonl"
local fields = {
  "object_name", "type",
  "circuit_enable_disable", "circuit_read_contents", "circuit_read_ingredients",
  "circuit_read_recipe_finished", "circuit_read_working", "circuit_set_recipe",
  "include_in_crafting", "read_fuel", "read_contents", "use_colors",
  "circuit_read_hand_contents", "circuit_set_filters", "circuit_set_stack_size",
  "circuit_condition_enabled", "set_requests", "read_logistics", "read_robot_stats",
  "read_from_train", "read_stopped_train", "read_trains_count", "send_to_train",
  "set_priority", "set_trains_limit"
}

local function observe_field(behavior, name)
  local ok, value = pcall(function() return behavior[name] end)
  if not ok then
    return {name = name, status = "error", message = tostring(value)}
  end
  if value == nil then return {name = name, status = "absent"} end
  local kind = type(value)
  if kind == "boolean" or kind == "string" or
      (kind == "number" and value == value and value ~= math.huge and value ~= -math.huge) then
    return {name = name, status = "value", value = value}
  end
  return {name = name, status = "unexpected-type", message = kind}
end

local function observe_behavior(entity)
  -- Do not use get_or_create_control_behavior: a missing instance is an observation,
  -- not evidence that the prototype cannot have a control behavior.
  local ok, behavior = pcall(function() return entity.get_control_behavior() end)
  if not ok then return {status = "error", message = tostring(behavior)} end
  if behavior == nil then return {status = "absent"} end
  local values = {}
  for _, name in ipairs(fields) do
    values[#values + 1] = observe_field(behavior, name)
  end
  return {status = "present", fields = values}
end

commands.add_command("comblang-probe", "Append a read-only snapshot of the selected entity; optional argument is a case label.", function(command)
  if command.player_index == nil then
    log("comblang-probe needs a player with a selected entity; server/RCON capture is not supported.")
    return
  end
  local player = game.get_player(command.player_index)
  if player == nil then return end
  local entity = player.selected
  if entity == nil or not entity.valid then
    player.print("Select a placed entity before running /comblang-probe [case label].")
    return
  end

  local mods = {}
  for name, version in pairs(script.active_mods) do
    mods[#mods + 1] = {name = name, version = version}
  end
  table.sort(mods, function(a, b) return a.name < b.name end)
  local startup = {}
  for name, setting in pairs(settings.startup) do
    startup[#startup + 1] = {name = name, value = setting.value}
  end
  table.sort(startup, function(a, b) return a.name < b.name end)

  local sample = {
    schemaVersion = 1,
    kind = "comblang-circuit-observation",
    probeVersion = script.active_mods[script.mod_name],
    label = command.parameter or "",
    tick = tostring(game.tick),
    playerIndex = command.player_index,
    environment = {factorioVersion = script.active_mods.base, mods = mods, startupSettings = startup},
    entity = {
      key = "entity:" .. entity.name,
      type = entity.type,
      unitNumber = entity.unit_number and tostring(entity.unit_number) or nil,
      surface = entity.surface.name,
      position = {x = entity.position.x, y = entity.position.y}
    },
    behavior = observe_behavior(entity)
  }
  -- Append preserves repeated measurements and avoids overwriting earlier evidence.
  -- Only the requesting player's local script-output receives the file.
  helpers.write_file(output_path, helpers.table_to_json(sample) .. "\n", true, command.player_index)
  player.print("CombLang observation appended to script-output/" .. output_path .. ". No capability flags inferred.")
end)
