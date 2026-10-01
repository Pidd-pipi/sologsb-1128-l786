// 集成验证：Dexie（fake-indexeddb）+ Pinia store 的建案 / 两侧排泊 / 合并 / 失败保留草稿 / 进出港对账全链路。
import 'fake-indexeddb/auto';
import { createPinia, setActivePinia } from 'pinia';
import { db } from '../src/db/index';
import { ensureSeedData } from '../src/db/seed';
import { usePortStore } from '../src/stores/portStore';
import { useVesselStore } from '../src/stores/vesselStore';
import { useShelterStore } from '../src/stores/shelterStore';

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) pass++;
  else {
    fail++;
    console.error('❌ FAIL:', msg);
  }
}

async function main() {
  // ---- 种子 ----
  await ensureSeedData();
  const [portCount, vesselCount, berthCount, planCount] = await Promise.all([
    db.ports.count(), db.vessels.count(), db.berths.count(), db.shelterPlans.count(),
  ]);
  assert(portCount === 4, `应有 4 座渔港，实际 ${portCount}`);
  assert(vesselCount === 6, `应有 6 艘渔船，实际 ${vesselCount}`);
  assert(berthCount === 23, `应有 23 个泊位(6+8+5+4)，实际 ${berthCount}`);
  assert(planCount === 2, `应播种 2 份避风方案，实际 ${planCount}`);

  // v4 回填吃水
  const v2001 = await db.vessels.get('v-2001');
  assert(typeof v2001?.draftDepth === 'number' && v2001.draftDepth > 0, '渔船吃水应存在');

  setActivePinia(createPinia());
  const portStore = usePortStore();
  const vesselStore = useVesselStore();
  const shelterStore = useShelterStore();
  await Promise.all([portStore.loadAll(), vesselStore.loadAll(), shelterStore.loadAll()]);

  // 种子方案：石浦 sp-4001 已合并、5 条安排、1 艘待排
  const shipu = shelterStore.plans.find((p) => p.portId === 'p-1001');
  assert(shipu && shipu.merged.length === 5, `石浦种子应 5 条合并安排，实际 ${shipu?.merged.length}`);
  assert(shipu && shipu.pendingVesselIds.includes('v-2005'), '石浦种子 v-2005 待排');
  assert(shipu && shipu.coop.assignments.length === 5 && shipu.duty.assignments.length === 5, '两侧种子草稿应各 5 条');

  // ---- 新建方案：温岭（浅）两侧不同排法 ----
  const port1004 = portStore.portById('p-1004')!;
  const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
  tomorrow.setHours(9, 0, 0, 0);
  const end = new Date(tomorrow.getTime() + 6 * 3600 * 1000);
  const plan = await shelterStore.createPlan({
    portId: 'p-1004',
    typhoonName: '集成测试台风',
    alertAt: new Date().toISOString(),
    slots: [{ label: '第一批', startAt: tomorrow.toISOString(), endAt: end.toISOString() }],
  });
  const slot = plan.slots[0];
  const berths1004 = portStore.berthsOf('p-1004');
  const b02 = berths1004.find((b) => b.berthNo === 'B02')!;
  const v2004 = vesselStore.vesselById('v-2004')!; // 吃水 2.2
  const v2003 = vesselStore.vesselById('v-2003')!; // 吃水 2.8

  // 合作社自动排：2 艘浅水船都能进 3.9m
  const coopRes = await shelterStore.autoArrangeSide(
    plan.id, 'coop', slot,
    [
      { id: v2004.id, name: v2004.name, draftDepth: v2004.draftDepth },
      { id: v2003.id, name: v2003.name, draftDepth: v2003.draftDepth },
    ],
    berths1004,
  );
  assert(coopRes.placed === 2 && coopRes.unplaced.length === 0, `合作社应排 2 艘，实际 ${coopRes.placed}/${coopRes.unplaced.length}`);

  // 深吃水船 v-2005(4.5) 在温岭水深不足 → 待排
  const v2005 = vesselStore.vesselById('v-2005')!;
  const deepRes = await shelterStore.autoArrangeSide(
    plan.id, 'coop', slot,
    [{ id: v2005.id, name: v2005.name, draftDepth: v2005.draftDepth }],
    berths1004,
  );
  assert(deepRes.placed === 0 && deepRes.unplaced.length === 1, '深吃水船在浅港应全部待排');

  // 值班室最初与合作社完全一致（v2003→B01、v2004→B02），先验证干净合并
  const r1 = await shelterStore.setSideAssignment(plan.id, 'duty', {
    portId: 'p-1004', berthNo: 'B01', berthDepth: b02.designDepth,
    vesselId: v2003.id, vesselName: v2003.name, vesselDraft: v2003.draftDepth, slot,
  });
  assert(r1.ok, '值班室 B01 排 v2003 应成功');
  const r2 = await shelterStore.setSideAssignment(plan.id, 'duty', {
    portId: 'p-1004', berthNo: 'B02', berthDepth: b02.designDepth,
    vesselId: v2004.id, vesselName: v2004.name, vesselDraft: v2004.draftDepth, slot,
  });
  assert(r2.ok, '值班室 B02 排 v2004 应成功');

  const merge1 = await shelterStore.merge(plan.id, berths1004);
  assert(merge1.ok, `两侧泊位一致应合并成功（冲突 ${merge1.conflictCount} 违反 ${merge1.violationCount}）`);
  assert(merge1.mergedCount === 2, `应合并 2 条，实际 ${merge1.mergedCount}`);
  assert(merge1.pendingCount === 1, `应剩 1 艘深船待排，实际 ${merge1.pendingCount}`);

  // 持久化后重新加载，权威结果仍在
  await shelterStore.loadAll();
  const reloaded = shelterStore.planById(plan.id)!;
  assert(reloaded.merged.length === 2 && reloaded.revision === 1, '重载后合并结果与修订号应持久化');

  // ---- 制造冲突：值班室把 B01 改排 v2004（合作社在 B01 排的是 v2003）----
  // 先移除值班室原两条，再让 B01=v2004（与合作社 B01=v2003 同稳定编号不同船）
  await shelterStore.removeSideAssignment(plan.id, 'duty', reloaded.duty.assignments.find((a) => a.berthNo === 'B02')!.key);
  const clash2 = await shelterStore.setSideAssignment(plan.id, 'duty', {
    portId: 'p-1004', berthNo: 'B01', berthDepth: b02.designDepth,
    vesselId: v2004.id, vesselName: v2004.name, vesselDraft: v2004.draftDepth, slot,
  });
  assert(clash2.ok, '值班室 B01 改排 v2004 应写入草稿（合并时才判冲突）');

  const beforePlan = shelterStore.planById(plan.id)!;
  const beforeCoop = JSON.stringify(beforePlan.coop);
  const beforeRevision = beforePlan.revision;
  const merge2 = await shelterStore.merge(plan.id, berths1004);
  assert(!merge2.ok && merge2.conflictCount === 1, `同一时段两边都改应 1 冲突，实际 ok=${merge2.ok} c=${merge2.conflictCount}`);
  const afterFail = shelterStore.planById(plan.id)!;
  assert(afterFail.revision === beforeRevision, '合并失败修订号不应增长');
  assert(afterFail.merged.length === 2, '合并失败权威结果应保留旧 2 条');
  assert(JSON.stringify(afterFail.coop) === beforeCoop, '合并失败合作社原草稿应原样保留');
  assert(afterFail.lastMergeOk === false && afterFail.conflicts.length === 1, '应记录失败状态与冲突明细');

  // ---- 解决冲突：值班室恢复成与合作社一致（B01=v2003、B02=v2004）----
  await shelterStore.setSideAssignment(plan.id, 'duty', {
    portId: 'p-1004', berthNo: 'B01', berthDepth: b02.designDepth,
    vesselId: v2003.id, vesselName: v2003.name, vesselDraft: v2003.draftDepth, slot,
  });
  await shelterStore.setSideAssignment(plan.id, 'duty', {
    portId: 'p-1004', berthNo: 'B02', berthDepth: b02.designDepth,
    vesselId: v2004.id, vesselName: v2004.name, vesselDraft: v2004.draftDepth, slot,
  });
  const merge3 = await shelterStore.merge(plan.id, berths1004);
  assert(merge3.ok, '冲突解除后应合并成功');
  assert(shelterStore.planById(plan.id)!.revision === 2, '成功合并修订号应 +1 → r2');

  // ---- 预排后登记实际进出港 → 对账：v2003 实际进 B01 时间接近 → 已落实 ----
  await portStore.registerCall({
    vesselId: v2003.id, type: '进港',
    time: new Date(tomorrow.getTime() + 30 * 60 * 1000).toISOString(),
    berthNo: 'B01', iceKg: 0, fuelL: 0, unloadKg: 0, visaStatus: '已签证',
  }, v2003.name, 'p-1004');
  // registerCall 已自动 reconcileAll
  const afterReg = shelterStore.planById(plan.id)!;
  const a2003 = afterReg.merged.find((a) => a.vesselId === 'v-2003');
  assert(a2003?.status === '已落实', 'v2003 实际按预排进港应已落实');
  assert(afterReg.history.some((h) => h.result === '已落实'), '应写入落实历史');

  // v2004 改实际停到 B03（泊位变化）→ 旧 B02 安排失效
  await portStore.registerCall({
    vesselId: v2004.id, type: '进港',
    time: new Date(tomorrow.getTime() + 40 * 60 * 1000).toISOString(),
    berthNo: 'B03', iceKg: 0, fuelL: 0, unloadKg: 0, visaStatus: '已签证',
  }, v2004.name, 'p-1004');
  const afterReg2 = shelterStore.planById(plan.id)!;
  const a2004 = afterReg2.merged.find((a) => a.vesselId === 'v-2004');
  assert(a2004?.status === '已失效' && Boolean(a2004.voidReason), 'v2004 泊位变化应失效并带原因');
  assert(afterReg2.merged.length === 2, '失效不删安排，合并表仍 2 条（历史保留）');
  assert(afterReg2.history.some((h) => h.result === '已失效'), '应写入失效历史');

  // 重新合并不应冲掉已落实 / 已失效状态
  const merge4 = await shelterStore.merge(plan.id, berths1004);
  assert(merge4.ok, '对账后再合并应成功');
  const final = shelterStore.planById(plan.id)!;
  assert(
    final.merged.find((a) => a.vesselId === 'v-2003')?.status === '已落实' &&
      final.merged.find((a) => a.vesselId === 'v-2004')?.status === '已失效',
    '重新合并应保留已落实 / 已失效状态',
  );

  console.log(`\n${fail === 0 ? '✅ 集成全部通过' : '⚠️ 集成有失败'}：通过 ${pass} / 失败 ${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
