import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

const toolRoot = new URL('../../../tools/factorio-runtime-prototype-exporter/', import.meta.url);
const apiRoot = new URL('../../../tools/factorio-api/fixtures/2.1.16/', import.meta.url);

describe('runtime prototype exporter package', () => {
  test('is a separate read-only tool pinned to the checked-in API snapshot', async () => {
    const [control, infoSource, manifestSource] = await Promise.all([
      readFile(new URL('control.lua', toolRoot), 'utf8'),
      readFile(new URL('info.json', toolRoot), 'utf8'),
      readFile(new URL('manifest.json', apiRoot), 'utf8'),
    ]);
    const info = JSON.parse(infoSource) as { name: string; version: string };
    const manifest = JSON.parse(manifestSource) as {
      applicationVersion: string;
      apiVersion: number;
      files: Record<string, { sha256: string }>;
    };

    expect(info.name).toBe('comblang-runtime-prototype-exporter');
    expect(control).toContain('commands.add_command("comblang-export-prototypes"');
    expect(control).toContain(`applicationVersion = "${manifest.applicationVersion}"`);
    expect(control).toContain(`apiVersion = ${manifest.apiVersion}`);
    expect(control).toContain(`runtimeSha256 = "${manifest.files['runtime-api.json']!.sha256}"`);
    expect(control).toContain(
      `prototypeSha256 = "${manifest.files['prototype-api.json']!.sha256}"`,
    );
    expect(control).not.toMatch(
      /create_entity|get_or_create_control_behavior|\.set_|settings\.startup\[[^\]]+\]\s*=/,
    );
  });

  test('only reads fields and methods present in runtime API 2.1.16', async () => {
    const api = JSON.parse(await readFile(new URL('runtime-api.json', apiRoot), 'utf8')) as {
      classes: {
        name: string;
        attributes?: { name: string }[];
        methods?: { name: string }[];
      }[];
    };
    const classByName = new Map(api.classes.map((entry) => [entry.name, entry]));
    const expectMembers = (
      className: string,
      attributes: readonly string[],
      methods: readonly string[] = [],
    ) => {
      const entry = classByName.get(className)!;
      const actualAttributes = new Set(entry.attributes?.map(({ name }) => name));
      const actualMethods = new Set(entry.methods?.map(({ name }) => name));
      for (const name of attributes)
        expect(actualAttributes.has(name), `${className}.${name}`).toBe(true);
      for (const name of methods)
        expect(actualMethods.has(name), `${className}.${name}()`).toBe(true);
    };

    expectMembers(
      'LuaItemPrototype',
      ['stack_size', 'stackable', 'weight', 'spoil_result', 'place_result'],
      ['get_spoil_ticks'],
    );
    expectMembers('LuaFluidPrototype', [
      'default_temperature',
      'max_temperature',
      'fuel_value',
      'heat_capacity',
    ]);
    expectMembers('LuaRecipePrototype', [
      'categories',
      'energy',
      'ingredients',
      'products',
      'main_product',
      'maximum_productivity',
      'allowed_effects',
    ]);
    expectMembers(
      'LuaEntityPrototype',
      [
        'tile_width',
        'tile_height',
        'selection_box',
        'collision_box',
        'crafting_categories',
        'ingredient_count',
        'module_inventory_size',
        'fluid_capacity',
      ],
      ['get_crafting_speed', 'get_max_circuit_wire_distance'],
    );
    expectMembers('LuaQualityPrototype', [
      'level',
      'next',
      'previous',
      'next_probability',
      'default_multiplier',
      'beacon_module_slots_bonus',
      'crafting_machine_module_slots_bonus',
    ]);
    expectMembers('LuaSettings', ['startup']);
  });
});
