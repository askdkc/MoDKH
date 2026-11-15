import { verifyBundledSkills, bundledSkills } from '../dist/agent/bundled-skills.js';
verifyBundledSkills();
console.log(`同梱スキル検証: ${bundledSkills().length} skills`);
