-- Read-only structural prototype export. This does not inspect circuit behavior,
-- create entities, change settings, or infer capabilities.
local output_path = "comblang/runtime-prototypes.json"
local collector_name = "comblang-runtime-prototype-exporter"

local function code_unit_sort(left, right)
  -- Factorio prototype identifiers are UTF-8 strings. Capture order is transport
  -- only; the CombLang normalizer owns canonical UTF-16 code-unit ordering.
  return left.name < right.name
end

local function clone_json(value, depth)
  depth = depth or 0
  if depth > 24 then error("value exceeds capture depth") end
  local kind = type(value)
  if kind == "nil" or kind == "boolean" or kind == "string" then return value end
  if kind == "number" then
    if value ~= value or value == math.huge or value == -math.huge then
      error("non-finite number")
    end
    return value
  end
  if kind ~= "table" then error("unsupported value type: " .. kind) end
  local result = {}
  for key, entry in pairs(value) do
    local key_kind = type(key)
    if key_kind ~= "string" and key_kind ~= "number" then
      error("unsupported table key type: " .. key_kind)
    end
    result[key] = clone_json(entry, depth + 1)
  end
  return result
end

local function outcome(read, normalize)
  local ok, value = pcall(read)
  if not ok then return {status = "error", message = tostring(value)} end
  if value == nil then return {status = "absent"} end
  local normalized_ok, normalized = pcall(normalize or clone_json, value)
  if not normalized_ok then
    return {status = "error", message = tostring(normalized)}
  end
  return {status = "value", value = normalized}
end

local function unknown(reason)
  return {status = "unknown", reason = reason}
end

local function prototype_name(value)
  return value.name
end

local function position(value)
  return {x = value.x or value[1], y = value.y or value[2]}
end

local function bounding_box(value)
  return {
    leftTop = position(value.left_top or value[1]),
    rightBottom = position(value.right_bottom or value[2]),
    orientation = value.orientation
  }
end

local function string_array(value)
  local result = {}
  for index, entry in ipairs(value) do result[index] = entry end
  return result
end

local function true_dictionary_keys(value)
  local result = {}
  for name, present in pairs(value) do
    if present then result[#result + 1] = name end
  end
  table.sort(result)
  return result
end

local function optional(target, source, name, output_name, normalize)
  local value = source[name]
  if value ~= nil then target[output_name or name] = (normalize or clone_json)(value) end
end

local function recipe_component(value)
  local result = {type = value.type, name = value.name}
  for _, name in ipairs({
    "amount", "amount_min", "amount_max", "ignored_by_stats",
    "ignored_by_productivity", "independent_probability", "temperature",
    "minimum_temperature", "maximum_temperature", "fluidbox_index",
    "fluidbox_multiplier", "quality_min", "quality_max", "quality_change",
    "spoil_weight", "percent_spoiled", "always_fresh",
    "reset_freshness_on_craft", "affected_by_quality", "extra_count_fraction"
  }) do optional(result, value, name) end
  optional(result, value, "shared_probability", nil, clone_json)
  return result
end

local function recipe_components(value)
  local result = {}
  for index, component in ipairs(value) do
    result[index] = recipe_component(component)
  end
  return result
end

local function facts(record, definitions)
  local result = {}
  for name, definition in pairs(definitions) do
    if definition.unknown then
      result[name] = unknown(definition.unknown)
    else
      result[name] = outcome(function() return definition.read(record) end, definition.normalize)
    end
  end
  return result
end

local function records(source, key_prefix, definitions)
  local result = {}
  for name, record in pairs(source) do
    result[#result + 1] = {
      key = key_prefix .. ":" .. name,
      name = name,
      type = record.type,
      facts = facts(record, definitions)
    }
  end
  table.sort(result, code_unit_sort)
  return result
end

local item_facts = {
  stackSize = {read = function(value) return value.stack_size end},
  stackable = {read = function(value) return value.stackable end},
  weight = {read = function(value) return value.weight end},
  spoilResult = {read = function(value) return value.spoil_result end, normalize = prototype_name},
  spoilTicks = {read = function(value) return value.get_spoil_ticks() end},
  placeResult = {read = function(value) return value.place_result end, normalize = prototype_name}
}

local fluid_facts = {
  defaultTemperature = {read = function(value) return value.default_temperature end},
  maxTemperature = {read = function(value) return value.max_temperature end},
  fuelValue = {read = function(value) return value.fuel_value end},
  heatCapacity = {read = function(value) return value.heat_capacity end}
}

local recipe_facts = {
  categories = {read = function(value) return value.categories end, normalize = string_array},
  energy = {read = function(value) return value.energy end},
  ingredients = {read = function(value) return value.ingredients end, normalize = recipe_components},
  products = {read = function(value) return value.products end, normalize = recipe_components},
  mainProduct = {read = function(value) return value.main_product end, normalize = recipe_component},
  maximumProductivity = {read = function(value) return value.maximum_productivity end},
  allowedEffects = {read = function(value) return value.allowed_effects end, normalize = clone_json}
}

local entity_facts = {
  tileWidth = {read = function(value) return value.tile_width end},
  tileHeight = {read = function(value) return value.tile_height end},
  selectionBox = {read = function(value) return value.selection_box end, normalize = bounding_box},
  collisionBox = {read = function(value) return value.collision_box end, normalize = bounding_box},
  craftingCategories = {read = function(value) return value.crafting_categories end, normalize = true_dictionary_keys},
  ingredientCount = {read = function(value) return value.ingredient_count end},
  moduleInventorySize = {read = function(value) return value.module_inventory_size end},
  fluidCapacity = {read = function(value) return value.fluid_capacity end},
  craftingSpeedNormal = {read = function(value) return value.get_crafting_speed("normal") end},
  maxCircuitWireDistanceNormal = {read = function(value) return value.get_max_circuit_wire_distance("normal") end},
  inventorySize = {unknown = "requires an entity-specific inventory index"}
}

local quality_facts = {
  level = {read = function(value) return value.level end},
  next = {read = function(value) return value.next end, normalize = prototype_name},
  previous = {read = function(value) return value.previous end, normalize = prototype_name},
  nextProbability = {read = function(value) return value.next_probability end},
  defaultMultiplier = {read = function(value) return value.default_multiplier end},
  beaconModuleSlotsBonus = {read = function(value) return value.beacon_module_slots_bonus end},
  craftingMachineModuleSlotsBonus = {read = function(value) return value.crafting_machine_module_slots_bonus end}
}

local limit_facts = {
  maxBeaconSupplyAreaDistance = {read = function(value) return value.max_beacon_supply_area_distance end},
  maxElectricPoleConnectionDistance = {read = function(value) return value.max_electric_pole_connection_distance end},
  maxElectricPoleSupplyAreaDistance = {read = function(value) return value.max_electric_pole_supply_area_distance end},
  maxInserterReachDistance = {read = function(value) return value.max_inserter_reach_distance end},
  maxLogisticsConnectionDistance = {read = function(value) return value.max_logistics_connection_distance end},
  maxPipeToGroundDistance = {read = function(value) return value.max_pipe_to_ground_distance end},
  maxUndergroundBeltDistance = {read = function(value) return value.max_underground_belt_distance end}
}

local function environment()
  local mods = {}
  for name, version in pairs(script.active_mods) do
    mods[#mods + 1] = {name = name, version = version}
  end
  table.sort(mods, code_unit_sort)
  local startup = {}
  for name, setting in pairs(settings.startup) do
    startup[#startup + 1] = {
      name = name,
      outcome = outcome(function() return setting.value end, clone_json)
    }
  end
  table.sort(startup, code_unit_sort)
  return {
    factorioVersion = script.active_mods.base,
    mods = mods,
    startupSettings = startup
  }
end

commands.add_command("comblang-export-prototypes", "Write a read-only runtime prototype snapshot.", function()
  local snapshot = {
    schemaVersion = 1,
    kind = "comblang-runtime-prototype-snapshot",
    collectorVersion = script.active_mods[collector_name],
    apiReference = {
      applicationVersion = "2.1.16",
      apiVersion = 6,
      runtimeSha256 = "1c21fc0d6c56f75aea97ef45b73e4915a361b0b0d912dbc01aad7046e9088348",
      prototypeSha256 = "4c915eb230f9ea6e2e617d3b83e735e4cac04a45fb49414c2f677b97fba40104"
    },
    environment = environment(),
    collections = {
      items = records(prototypes.item, "item", item_facts),
      fluids = records(prototypes.fluid, "fluid", fluid_facts),
      recipes = records(prototypes.recipe, "recipe", recipe_facts),
      entities = records(prototypes.entity, "entity", entity_facts),
      qualities = records(prototypes.quality, "quality", quality_facts),
      recipeCategories = records(prototypes.recipe_category, "recipe-category", {})
    },
    limits = facts(prototypes, limit_facts)
  }
  helpers.write_file(output_path, helpers.table_to_json(snapshot), false)
  game.print("CombLang runtime prototype snapshot written to script-output/" .. output_path)
end)
