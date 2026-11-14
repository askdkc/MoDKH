import { fields, object, pluginId, text } from '../plugins/package.ts';
export interface AgentSetting { model?: string; tools?: string[]; disabled?: boolean }
export function parseAgentSettings(value: unknown): { settings: Record<string, AgentSetting>; diagnostics: string[]; unavailable?: boolean } {
  const settings: Record<string, AgentSetting> = Object.create(null) as Record<string, AgentSetting>;
  const diagnostics: string[] = [];
  if (value === undefined) return { settings, diagnostics };
  let entries: Record<string, unknown>;
  try { entries = object(value); }
  catch (e) { return { settings, diagnostics: [`Subagent settings invalid: ${String(e)}`], unavailable: true }; }
  for (const [id, raw] of Object.entries(entries)) {
    try {
      pluginId(id);
      const setting = object(raw);
      fields(setting, ['model', 'tools']);
      const model = setting.model === undefined ? undefined : text(setting.model, 'model', 512);
      if (model && !/^[a-z][a-z0-9-]*\/[^\s]+$/.test(model)) throw new Error('Invalid model reference');
      if (setting.tools !== undefined && (!Array.isArray(setting.tools) || setting.tools.length > 64 || !setting.tools.every(t => typeof t === 'string' && /^[a-z][a-z0-9_]*$/.test(t)))) throw new Error('Invalid tool policy');
      settings[id] = { model, tools: setting.tools as string[] | undefined };
    } catch (e) { settings[id] = { disabled: true }; diagnostics.push(`${id}: ${String(e)}; disabled`); }
  }
  return { settings, diagnostics };
}
