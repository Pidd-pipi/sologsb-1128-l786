import { autoArrange, mergeSideDrafts, reconcileAssignments, intervalsOverlap } from '../src/utils/shelter';
import { buildAssignmentKey, emptySideDraft, type BerthAssignment, type PlanSide } from '../src/types/shelter';
import type { Berth } from '../src/types/berth';
import type { PortCall } from '../src/types/call';

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error('❌ FAIL:', msg);
  }
}

function berth(berthNo: string, designDepth: number, status: Berth['status'] = '空闲', berthAt: string | null = null): Berth {
  return { id: `p1-${berthNo}`, portId: 'p1', berthNo, vesselId: null, vesselName: null, berthAt, leaveAt: null, status, designDepth };
}

function assignment(side: PlanSide, berthNo: string, vesselId: string, vesselName: string, vesselDraft: number, berthDepth: number, startAt: string, endAt: string, slotLabel: string): BerthAssignment {
  return {
    key: buildAssignmentKey('p1', berthNo, new Date(startAt).toISOString()),
    portId: 'p1', berthNo, berthDepth, vesselId, vesselName, vesselDraft,
    startAt: new Date(startAt).toISOString(), endAt: new Date(endAt).toISOString(),
    slotLabel, source: side, status: '待落实', updatedAt: '2026-10-01T00:00:00Z',
  };
}

const day = '2026-10-02';

// ---- 1. intervalsOverlap ----
assert(intervalsOverlap(`${day}T08:00Z`, `${day}T14:00Z`, `${day}T10:00Z`, `${day}T12:00Z`), '区间包含应重叠');
assert(!intervalsOverlap(`${day}T08:00Z`, `${day}T14:00Z`, `${day}T14:00Z`, `${day}T20:00Z`), '首尾相接（半开区间）不应重叠');
assert(!intervalsOverlap(`${day}T08:00Z`, `${day}T10:00Z`, `${day}T11:00Z`, `${day}T12:00Z`), '完全分离不应重叠');

// ---- 2. autoArrange：水深适配 + 容量不足 ----
{
  // 4 个可用泊位：水深 3.0, 4.0, 5.0, 5.0；B05 维修
  const berths = [
    berth('B01', 3.0), berth('B02', 4.0), berth('B03', 5.0), berth('B04', 5.0),
    berth('B05', 6.0, '维修'),
  ];
  const vessels = [
    { id: 'v1', name: '深船A', draftDepth: 4.8 },
    { id: 'v2', name: '深船B', draftDepth: 4.6 },
    { id: 'v3', name: '浅船C', draftDepth: 2.5 },
    { id: 'v4', name: '浅船D', draftDepth: 2.0 },
    { id: 'v5', name: '超深E', draftDepth: 6.5 }, // 无适配泊位
  ];
  const res = autoArrange({
    portId: 'p1',
    slot: { label: '第一批', startAt: `${day}T08:00Z`, endAt: `${day}T14:00Z` },
    vessels, berths, existing: [], side: 'coop',
  });
  assert(res.placed.length === 4, `应排上 4 艘，实际 ${res.placed.length}`);
  assert(res.unplaced.length === 1 && res.unplaced[0].id === 'v5', '超深船应待排');
  const a = res.placed.find((x) => x.vesselId === 'v1');
  const c = res.placed.find((x) => x.vesselId === 'v3');
  // 深船应拿浅的可用深泊位 B03/B04（4.8 只能进 5.0）；浅船可进 B01
  assert(a && ['B03', 'B04'].includes(a.berthNo), `深船A 应进 B03/B04，实际 ${a?.berthNo}`);
  assert(c?.berthNo === 'B01', `浅船C 应择优进最浅 B01，实际 ${c?.berthNo}`);
  assert(res.placed.every((x) => x.berthDepth >= x.vesselDraft), '所有安排水深须 ≥ 吃水');
  // 同泊位不重叠（同一时段，所以每泊位最多一条）
  const nos = res.placed.map((x) => x.berthNo);
  assert(new Set(nos).size === nos.length, '同泊位同时段不得重复安排');
}

// ---- 3. autoArrange：港内已有占用挡住 ----
{
  const occupiedAt = new Date(`${day}T00:00:00Z`).toISOString(); // 在泊、无离港 → 挡住全天
  const berths = [
    berth('B01', 5.0, '占用', occupiedAt),
    berth('B02', 5.0),
  ];
  const vessels = [{ id: 'v1', name: '船1', draftDepth: 3.0 }, { id: 'v2', name: '船2', draftDepth: 3.0 }];
  const res = autoArrange({
    portId: 'p1',
    slot: { label: '第一批', startAt: `${day}T08:00Z`, endAt: `${day}T14:00Z` },
    vessels, berths, existing: [], side: 'coop',
  });
  assert(res.placed.length === 1, `占用泊位不应排入，应排 1 艘，实际 ${res.placed.length}`);
  assert(res.placed[0].berthNo === 'B02', '应排到空闲 B02');
  assert(res.unplaced.length === 1, '另一艘应待排');
}

// ---- 4. autoArrange：跨时段同泊位不重叠 ----
{
  const berths = [berth('B01', 5.0)];
  const existing = [assignment('coop', 'B01', 'v0', '已在泊船', 3, 5, `${day}T08:00Z`, `${day}T14:00Z`, '第一批')];
  // 第二批时间不重叠（14:00 起，半开区间），B01 可再排
  const res = autoArrange({
    portId: 'p1',
    slot: { label: '第二批', startAt: `${day}T14:00Z`, endAt: `${day}T20:00Z` },
    vessels: [{ id: 'v1', name: '新船', draftDepth: 3 }], berths, existing, side: 'coop',
  });
  assert(res.placed.length === 1 && res.placed[0].berthNo === 'B01', '时段首尾相接可复用泊位');

  // 与已排时段重叠则 B01 不可用
  const res2 = autoArrange({
    portId: 'p1',
    slot: { label: '重叠批', startAt: `${day}T12:00Z`, endAt: `${day}T16:00Z` },
    vessels: [{ id: 'v2', name: '冲突船', draftDepth: 3 }], berths, existing, side: 'coop',
  });
  assert(res2.unplaced.length === 1, '与本侧已排时段重叠应待排');
}

// ---- 5. merge：不同时段直接并入 ----
{
  const coop = { ...emptySideDraft('coop'), assignments: [assignment('coop', 'B01', 'v1', '甲船', 3, 5, `${day}T08:00Z`, `${day}T14:00Z`, '第一批')] };
  const duty = { ...emptySideDraft('duty'), assignments: [assignment('duty', 'B01', 'v2', '乙船', 3, 5, `${day}T14:00Z`, `${day}T20:00Z`, '第二批')] };
  const res = mergeSideDrafts({ portId: 'p1', coop, duty, berths: [berth('B01', 5.0)] });
  assert(res.ok, '不同时段应无冲突合并成功');
  assert(res.assignments.length === 2, `不同时段直接并入应得 2 条，实际 ${res.assignments.length}`);
}

// ---- 6. merge：同时段两边一致 → 同一条 ----
{
  const a = assignment('coop', 'B01', 'v1', '甲船', 3, 5, `${day}T08:00Z`, `${day}T14:00Z`, '第一批');
  const b = assignment('duty', 'B01', 'v1', '甲船', 3, 5, `${day}T08:00Z`, `${day}T14:00Z`, '第一批');
  const coop = { ...emptySideDraft('coop'), assignments: [a] };
  const duty = { ...emptySideDraft('duty'), assignments: [b] };
  const res = mergeSideDrafts({ portId: 'p1', coop, duty, berths: [berth('B01', 5.0)] });
  assert(res.ok && res.assignments.length === 1, '两边一致应合并为 1 条');
}

// ---- 7. merge：同一时段两边都改（不同船）→ 冲突 ----
{
  const a = assignment('coop', 'B01', 'v1', '甲船', 3, 5, `${day}T08:00Z`, `${day}T14:00Z`, '第一批');
  const b = assignment('duty', 'B01', 'v2', '乙船', 3, 5, `${day}T08:00Z`, `${day}T14:00Z`, '第一批');
  const coop = { ...emptySideDraft('coop'), assignments: [a] };
  const duty = { ...emptySideDraft('duty'), assignments: [b] };
  const res = mergeSideDrafts({ portId: 'p1', coop, duty, berths: [berth('B01', 5.0), berth('B02', 5.0)] });
  assert(!res.ok, '同时段两边排不同船应合并失败');
  assert(res.conflicts.length === 1, `应列出 1 处冲突，实际 ${res.conflicts.length}`);
  assert(res.conflicts[0].coop?.vesselId === 'v1' && res.conflicts[0].duty?.vesselId === 'v2', '冲突应保留两边安排');
}

// ---- 8. merge：水深不足违反 ----
{
  // 两边各排不同泊位，但值班室把深吃水船排进浅泊位
  const coop = { ...emptySideDraft('coop'), assignments: [assignment('coop', 'B01', 'v1', '甲船', 3, 5, `${day}T08:00Z`, `${day}T14:00Z`, '第一批')] };
  const duty = { ...emptySideDraft('duty'), assignments: [assignment('duty', 'B02', 'v2', '深船乙', 5.5, 4.0, `${day}T08:00Z`, `${day}T14:00Z`, '第一批')] };
  const res = mergeSideDrafts({ portId: 'p1', coop, duty, berths: [berth('B01', 5.0), berth('B02', 4.0)] });
  assert(!res.ok, '水深不足应导致合并失败');
  assert(res.violations.some((v) => v.includes('水深')), '应列出水深违反');
}

// ---- 9. merge：待排数量（容量不足，已排船只保留）----
{
  const coop = { ...emptySideDraft('coop'), assignments: [assignment('coop', 'B01', 'v1', '甲船', 3, 5, `${day}T08:00Z`, `${day}T14:00Z`, '第一批')], pendingVesselIds: ['v3'] };
  const duty = { ...emptySideDraft('duty'), assignments: [], pendingVesselIds: ['v3', 'v4'] };
  const res = mergeSideDrafts({ portId: 'p1', coop, duty, berths: [berth('B01', 5.0)] });
  assert(res.ok, '无冲突应成功');
  assert(res.assignments.length === 1, '已排船只保留（1 条）');
  assert(res.pendingVesselIds.length === 2 && res.pendingVesselIds.includes('v3') && res.pendingVesselIds.includes('v4'), '应留 2 艘待排');
  // 若另一台把 v3 排上了，则 v3 不再待排
  const duty2 = { ...emptySideDraft('duty'), assignments: [assignment('duty', 'B01', 'v3', '丙船', 3, 5, `${day}T14:00Z`, `${day}T20:00Z`, '第二批')], pendingVesselIds: ['v3', 'v4'] };
  const res2 = mergeSideDrafts({ portId: 'p1', coop, duty: duty2, berths: [berth('B01', 5.0)] });
  assert(!res2.pendingVesselIds.includes('v3'), '另一台已排上的船应从待排除去');
  assert(res2.pendingVesselIds.includes('v4'), '仍未排上的 v4 应保留待排');
}

// ---- 10. reconcile：实际进港泊位一致 → 已落实 ----
{
  const a = assignment('coop', 'B01', 'v1', '甲船', 3, 5, `${day}T08:00Z`, `${day}T14:00Z`, '第一批');
  const calls: PortCall[] = [{
    id: 'c1', vesselId: 'v1', vesselName: '甲船', type: '进港',
    time: `${day}T08:30:00Z`, berthNo: 'B01', iceKg: 0, fuelL: 0, unloadKg: 0, visaStatus: '已签证',
    createdAt: `${day}T08:30:00Z`,
  }];
  const { next, events } = reconcileAssignments([a], calls, '2026-10-01T00:00:00Z');
  assert(next[0].status === '已落实', '泊位一致时间接近应落实');
  assert(events.length === 1 && events[0].result === '已落实', '应产生 1 条落实事件');
}

// ---- 11. reconcile：泊位变化 → 旧安排失效（历史不丢） ----
{
  const a = assignment('coop', 'B01', 'v1', '甲船', 3, 5, `${day}T08:00Z`, `${day}T14:00Z`, '第一批');
  const calls: PortCall[] = [{
    id: 'c1', vesselId: 'v1', vesselName: '甲船', type: '进港',
    time: `${day}T08:30:00Z`, berthNo: 'B03', iceKg: 0, fuelL: 0, unloadKg: 0, visaStatus: '已签证',
    createdAt: `${day}T08:30:00Z`,
  }];
  const { next, events } = reconcileAssignments([a], calls, '2026-10-01T00:00:00Z');
  assert(next[0].status === '已失效', '泊位变了应失效');
  assert(Boolean(next[0].voidReason), '失效应带原因');
  assert(events[0].reason.includes('B03'), '失效原因应含实际泊位');
  // 安排记录本身仍在（历史不丢）
  assert(next.length === 1 && next[0].vesselId === 'v1', '失效不删除安排记录');
}

// ---- 12. reconcile：时间变化（>3h）→ 失效 ----
{
  const a = assignment('coop', 'B01', 'v1', '甲船', 3, 5, `${day}T08:00Z`, `${day}T14:00Z`, '第一批');
  const calls: PortCall[] = [{
    id: 'c1', vesselId: 'v1', vesselName: '甲船', type: '进港',
    time: `${day}T13:00:00Z`, berthNo: 'B01', iceKg: 0, fuelL: 0, unloadKg: 0, visaStatus: '已签证',
    createdAt: `${day}T13:00:00Z`,
  }];
  const { next } = reconcileAssignments([a], calls, '2026-10-01T00:00:00Z');
  assert(next[0].status === '已失效', '时间偏差 5 小时应失效');
}

// ---- 13. reconcile：别的船占了预排泊位 → 被占位的安排失效 ----
{
  const a1 = assignment('coop', 'B01', 'v1', '甲船', 3, 5, `${day}T08:00Z`, `${day}T14:00Z`, '第一批');
  const a2 = assignment('coop', 'B02', 'v2', '乙船', 3, 5, `${day}T08:00Z`, `${day}T14:00Z`, '第一批');
  const calls: PortCall[] = [{
    id: 'c1', vesselId: 'v9', vesselName: '占泊船', type: '进港',
    time: `${day}T09:00:00Z`, berthNo: 'B01', iceKg: 0, fuelL: 0, unloadKg: 0, visaStatus: '已签证',
    createdAt: `${day}T09:00:00Z`,
  }];
  const { next } = reconcileAssignments([a1, a2], calls, '2026-10-01T00:00:00Z');
  const b01 = next.find((x) => x.berthNo === 'B01');
  const b02 = next.find((x) => x.berthNo === 'B02');
  assert(b01?.status === '已失效', '被别的船占了 B01，甲船预排应失效');
  assert(b02?.status === '待落实', 'B02 未受影响应仍待落实');
}

// ---- 14. reconcile：警报之前的历史流水不应影响预排 ----
{
  const a = assignment('coop', 'B01', 'v1', '甲船', 3, 5, `${day}T08:00Z`, `${day}T14:00Z`, '第一批');
  const calls: PortCall[] = [{
    id: 'c0', vesselId: 'v1', vesselName: '甲船', type: '进港',
    time: '2026-09-01T08:30:00Z', berthNo: 'B03', iceKg: 0, fuelL: 0, unloadKg: 0, visaStatus: '已签证',
    createdAt: '2026-09-01T08:30:00Z',
  }];
  const { next, events } = reconcileAssignments([a], calls, '2026-10-01T00:00:00Z');
  assert(next[0].status === '待落实' && events.length === 0, '警报前的历史进港不应让预排失效');
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '⚠️ 有失败'}：通过 ${pass} / 失败 ${fail}`);
if (fail > 0) process.exit(1);
