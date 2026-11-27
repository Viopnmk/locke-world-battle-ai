/**
 * 人工核对脚本：打印指定精灵的完整培养方案（含每一格的说明），用来逐条对照图鉴原值。
 *
 *   npx esbuild scripts/print-build-samples.ts --bundle --platform=node --format=esm --outfile=.cache/print-build-samples.mjs
 *   node .cache/print-build-samples.mjs [精灵名或 id …]
 */
import { buildGuide } from '../src/lib/build-guide';
import { skillsOf, spirits } from '../src/lib/spirits';
import type { PresetKey } from '../src/lib/build-guide';

const args = process.argv.slice(2);
const queries = args.length ? args : ['伊兰龙', '圣代甜甜（杨桃巧克力口味）', '烈火战神', '水灵'];
const presets: PresetKey[] = ['burst', 'bulk'];

for (const q of queries) {
  const hits = spirits.filter((s) => s.name.includes(q) || s.id === q || s.dex === q);
  if (!hits.length) {
    console.log(`\n✗ 找不到「${q}」`);
    continue;
  }
  const spirit = hits[0];
  for (const preset of presets) {
    const g = buildGuide(spirit, preset);
    console.log(`\n================ ${spirit.name}（No.${spirit.dex} · ${spirit.id}）· ${g.presetLabel} ================`);
    console.log(`属性 ${spirit.type.join('、')} ｜ 特性：${spirit.trait ? `${spirit.trait.name}——${spirit.trait.effect}` : '—'}`);
    console.log(`弱点：${g.weaknesses.map((w) => `${w.type}×${w.multiplier}`).join('、') || '无'}`);
    console.log(`可学技能 ${skillsOf(spirit).length} 个 ｜ 反克制：${g.counter.note}`);
    for (const [i, s] of g.slots.entries()) {
      console.log(
        `  ${i + 1}. [${s.slot}] ${s.skill.type} · ${s.skill.name}（${s.source}）` +
          `${s.skill.power ? ` · ${s.skill.category} 威力 ${s.skill.power} · 能耗 ★${s.skill.energy}` : ` · 变化 · 能耗 ★${s.skill.energy}`}`,
      );
      console.log(`     说明：${s.reason}`);
    }
    console.log(`改血脉：${g.bloodline.main.blood}血脉「${g.bloodline.main.skill.name}」 equipped=${g.bloodline.main.equipped} slot=${g.bloodline.main.slotIndex}`);
    console.log(`      ${g.bloodline.explanation}`);
    console.log(`性格：${g.nature.main.nature.name} ${g.nature.main.line} ｜ 个体值：${g.ivs.map((iv) => iv.label).join('、')}`);
  }
}
