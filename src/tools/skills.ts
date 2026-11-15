import type { Tool } from '../agent/types.ts';
import { ToolError } from '../agent/types.ts';
import { bundledSkills, DKH_SKILL_BINDING, readBundledSkill } from '../agent/bundled-skills.ts';

export const skillTools: Tool[] = [
  {
    name: 'list_skills', description: 'List bundled Kiokuko skills and their reference resources. Bodies are loaded only with read_skill.',
    readOnly: true, parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      return JSON.stringify(bundledSkills().map(skill => ({ name: skill.name, description: skill.description, resources: Object.keys(skill.files) })));
    },
  },
  {
    name: 'read_skill', description: 'Read a bundled Skill runtime index or a risk-selected reference. Relative reference links belong to this skill, not the workspace. Follow nextLine for remaining text.',
    readOnly: true,
    parameters: { type: 'object', properties: {
      name: { type: 'string' }, resource: { type: 'string', description: 'Exact resource from list_skills; defaults to SKILL.md' },
      startLine: { type: 'integer', minimum: 1 },
    }, required: ['name'], additionalProperties: false },
    async execute(args) {
      if (typeof args.name !== 'string' || (args.resource !== undefined && typeof args.resource !== 'string')
        || (args.startLine !== undefined && (!Number.isSafeInteger(args.startLine) || (args.startLine as number) < 1))) throw new ToolError('INVALID_ARGS', 'Invalid skill name/resource/startLine');
      let body: string;
      try { body = readBundledSkill(args.name, args.resource as string | undefined); }
      catch { throw new ToolError('SKILL_UNAVAILABLE', 'Unknown or invalid bundled Skill resource'); }
      const lines = body.split('\n'), start = (args.startLine as number | undefined) ?? 1;
      if (start > lines.length) throw new ToolError('INVALID_ARGS', 'startLine exceeds resource length');
      let output = DKH_SKILL_BINDING + `\nSkill: ${args.name}, resource: ${args.resource ?? 'SKILL.md'}\n`;
      let next = start;
      while (next <= lines.length) {
        const line = `${next}: ${lines[next - 1]}\n`;
        if (Buffer.byteLength(output + line) > 14 * 1024) break;
        output += line; next++;
      }
      if (next === start) throw new ToolError('SKILL_UNAVAILABLE', 'Skill line exceeds read budget');
      return output + (next <= lines.length ? `\n[nextLine: ${next}; continue read_skill with the same name/resource]` : '\n[end of resource]');
    },
  },
];
