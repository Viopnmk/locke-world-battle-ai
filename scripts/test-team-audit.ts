/** 校验器敏感性测试：故意破坏数据，确认每一项都能被抓住 */
import fs from 'node:fs';
import { auditRotation } from './lib/team-audit';
import type { RotationHistoryFile, TeamRotationFile } from '../src/lib/team-types';
import { spirits, spiritsById } from '../src/lib/spirits';

const base = JSON.parse(fs.readFileSync(new URL('../src/data/team-rotation.json', import.meta.url).pathname, 'utf8')) as TeamRotationFile;
// 夹具不需要「上一轮」：清掉，避免误触发 previous.round 校验
base.previous = null;
const history: RotationHistoryFile = {
  rounds: [
    {
      round: base.round,
      updatedAt: base.updatedAt,
      nextRotationAt: base.nextRotationAt,
      archetypes: base.archetypes,
      teams: base.teams.map((t) => ({
        id: t.id,
        name: t.name,
        category: t.category,
        archetype: t.archetype,
        archetypeLabel: t.archetypeLabel,
        spiritIds: t.members.map((m) => m.spiritId),
        spiritNames: [],
      })),
      spiritIds: base.teams.flatMap((t) => t.members.map((m) => m.spiritId)),
    },
  ],
};

const clone = (x: TeamRotationFile): TeamRotationFile => JSON.parse(JSON.stringify(x));
const cases: { name: string; mutate: (r: TeamRotationFile) => void; expect: RegExp }[] = [
  {
    name: '能量标错（上场 10 写成 8）',
    mutate: (r) => {
      r.teams[0].members[0].energy!.entry = 8;
    },
    expect: /上场能量标 8/,
  },
  {
    name: '技能能耗标错',
    mutate: (r) => {
      r.teams[0].members[1].skills[0].energy = 99;
    },
    expect: /标注 99 费/,
  },
  {
    name: '同队同 dex',
    mutate: (r) => {
      const t = r.teams[0];
      let idx = -1;
      let twin = undefined as (typeof spirits)[number] | undefined;
      for (let i = 0; i < t.members.length; i += 1) {
        const dex = spiritsById.get(t.members[i].spiritId)!.dex;
        const cand = spirits.find((s) => s.dex === dex && s.id !== t.members[i].spiritId);
        if (cand) {
          idx = i;
          twin = cand;
          break;
        }
      }
      if (!twin || idx < 0) throw new Error('没有找到同 dex 的形态');
      const a = t.members[idx];
      const b = t.members[(idx + 1) % t.members.length];
      b.spiritId = twin.id;
      b.energy = { ...a.energy! };
      b.skills = a.skills.map((s) => ({ ...s }));
    },
    expect: /同图鉴编号/,
  },
  {
    name: '伪因果：抬费→伤害',
    mutate: (r) => {
      const t = r.teams[0];
      t.synergies[0] = {
        ...t.synergies[0],
        text: '对手每回合多付能量，这一发等于白拿伤害，随便打都是赚。',
      };
    },
    expect: /无原文支持的因果关系/,
  },
  {
    name: '联动引用不在 4 招里的技能',
    mutate: (r) => {
      const t = r.teams[0];
      t.synergies[0].skills = [{ spiritId: t.members[0].spiritId, name: '龙吟' }];
    },
    expect: /不在.*推荐 4 招里/,
  },
  {
    name: '特性空转却写能用',
    mutate: (r) => {
      const t = r.teams[0];
      const m = t.members[0];
      m.traitStatus = 'idle';
    },
    expect: /特性状态标 idle|本套空转/,
  },
  {
    name: '覆盖口径对不上',
    mutate: (r) => {
      // 往错的方向改 1 个（当前可能是 18，所以用 -1 保证一定对不上）
      r.teams[0].metrics!.coverageChosen = r.teams[0].metrics!.coverageChosen === 18 ? 17 : 18;
    },
    expect: /metrics 覆盖标/,
  },
  {
    name: '血脉两个',
    mutate: (r) => {
      const t = r.teams[0];
      const m = t.members[0];
      const blood = m.skills[0];
      m.skills[3] = { ...blood, name: '愿力冲击', why: '血脉', slot: '补位' };
    },
    expect: /不在学习面|超过上限/,
  },
];

let passed = 0;
for (const c of cases) {
  const r = clone(base);
  c.mutate(r);
  const res = auditRotation(r, history);
  const hit = res.problems.some((p) => c.expect.test(p));
  console.log(`${hit ? '✓' : '✗'} ${c.name}${hit ? '' : `\n   问题列表：${res.problems.slice(0, 4).join(' | ') || '（空）'}`}`);
  if (hit) passed += 1;
}
console.log(`\n${passed}/${cases.length} 个故意破坏的样本被抓住`);
const clean = auditRotation(base, history);
console.log(`干净样本：${clean.problems.length} 个问题`);
if (passed !== cases.length || clean.problems.length) process.exit(1);
