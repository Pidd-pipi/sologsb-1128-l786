/**
 * 避风预排纯函数：水深适配自动排泊、两侧离线草稿稳定编号合并、实际进出港对账。
 * 不依赖响应式与 Dexie，便于核对与复用。
 */
import type { Berth } from '../types/berth';
import type { PortCall } from '../types/call';
import type {
  ArrangeSlot,
  BerthAssignment,
  MergeConflict,
  PlanSide,
  ShelterPlan,
  SideDraft,
} from '../types/shelter';
import { buildAssignmentKey } from '../types/shelter';

/** 半开区间重叠判定：[aStart,aEnd) 与 [bStart,bEnd) */
export function intervalsOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  const as = new Date(aStart).getTime();
  const ae = new Date(aEnd).getTime();
  const bs = new Date(bStart).getTime();
  const be = new Date(bEnd).getTime();
  if ([as, ae, bs, be].some((t) => Number.isNaN(t))) return false;
  return as < be && bs < ae;
}

function toIso(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toISOString();
}

interface ArrangeVessel {
  id: string;
  name: string;
  draftDepth: number;
}

export interface AutoArrangeInput {
  portId: string;
  slot: ArrangeSlot;
  vessels: ArrangeVessel[];
  /** 港内全部泊位（含水深、维修与当前占用） */
  berths: Berth[];
  /** 本侧此前已排入的安排（跨时段也要避免同泊位时段重叠） */
  existing: BerthAssignment[];
  side: PlanSide;
}

export interface AutoArrangeResult {
  placed: BerthAssignment[];
  /** 容量 / 水深不足而未能排入的渔船 */
  unplaced: ArrangeVessel[];
}

/** 港内已有占用是否挡住某一时段 */
function occupancyBlocks(berth: Berth, startAt: string, endAt: string): boolean {
  if (berth.status !== '占用' || !berth.berthAt) return false;
  const leave = berth.leaveAt ?? '9999-12-31T23:59:59Z';
  return intervalsOverlap(startAt, endAt, berth.berthAt, leave);
}

/**
 * 按渔船吃水与泊位水深适配自动排泊。
 * - 维修泊位与水深不足泊位不参与；
 * - 港内已有占用与本侧已排安排在时段上重叠的泊位不参与；
 * - 同一艘船在重叠时段不重复排泊；
 * - 深吃水船优先，泊位按水深从浅到深择优（为深船保留深泊位）；
 * - 装不下的渔船原样返回，由页面汇总「待排数量」。
 */
export function autoArrange(input: AutoArrangeInput): AutoArrangeResult {
  const { portId, slot, berths, existing, side } = input;
  const startAt = toIso(slot.startAt);
  const endAt = toIso(slot.endAt);
  const now = new Date().toISOString();

  // 已占用的泊位 / 已排船（含本轮刚排上的），避免同泊位同时段塞两条或同船重复
  const takenBerthNos = new Set<string>();
  const takenVesselIds = new Set<string>();

  // 时段重叠的历史安排（同泊位或同船）
  for (const a of existing) {
    if (intervalsOverlap(startAt, endAt, a.startAt, a.endAt)) {
      takenBerthNos.add(a.berthNo);
      takenVesselIds.add(a.vesselId);
    }
  }

  const placed: BerthAssignment[] = [];
  const unplaced: ArrangeVessel[] = [];

  const deepFirst = [...input.vessels].sort((a, b) => b.draftDepth - a.draftDepth);
  for (const vessel of deepFirst) {
    if (takenVesselIds.has(vessel.id)) {
      unplaced.push(vessel);
      continue;
    }
    const eligible = berths
      .filter((b) => b.status !== '维修')
      .filter((b) => Number(b.designDepth) >= Number(vessel.draftDepth))
      .filter((b) => !takenBerthNos.has(b.berthNo))
      .filter((b) => !occupancyBlocks(b, startAt, endAt))
      .sort((a, b) => Number(a.designDepth) - Number(b.designDepth) || a.berthNo.localeCompare(b.berthNo));

    const berth = eligible[0];
    if (!berth) {
      unplaced.push(vessel);
      continue;
    }
    placed.push({
      key: buildAssignmentKey(portId, berth.berthNo, startAt),
      portId,
      berthNo: berth.berthNo,
      berthDepth: Number(berth.designDepth),
      vesselId: vessel.id,
      vesselName: vessel.name,
      vesselDraft: Number(vessel.draftDepth),
      startAt,
      endAt,
      slotLabel: slot.label,
      source: side,
      status: '待落实',
      updatedAt: now,
    });
    takenBerthNos.add(berth.berthNo);
    takenVesselIds.add(vessel.id);
  }

  return { placed, unplaced };
}

/** 两条安排是否实质相同（同一船、同一离泊时间） */
export function sameAssignment(a: BerthAssignment, b: BerthAssignment): boolean {
  return a.vesselId === b.vesselId && toIso(a.endAt) === toIso(b.endAt);
}

export interface MergeInput {
  portId: string;
  coop: SideDraft;
  duty: SideDraft;
  berths: Berth[];
  /** 上一版已合并安排，用于保留已落实 / 已失效状态（历史不丢） */
  previousMerged?: BerthAssignment[];
}

export interface MergeResult {
  ok: boolean;
  assignments: BerthAssignment[];
  conflicts: MergeConflict[];
  violations: string[];
  pendingVesselIds: string[];
  mergedAt: string;
}

/** 校验合并并集内部的同泊位时段重叠、水深不足与港内已有占用冲突 */
function validateMerged(assignments: BerthAssignment[], berths: Berth[]): string[] {
  const violations: string[] = [];
  const berthByNo = new Map(berths.map((b) => [b.berthNo, b]));

  for (const a of assignments) {
    const berth = berthByNo.get(a.berthNo);
    if (!berth) {
      violations.push(`泊位 ${a.berthNo}（${a.slotLabel}）不存在`);
      continue;
    }
    if (berth.status === '维修') {
      violations.push(`泊位 ${a.berthNo}（${a.slotLabel}）处于维修状态`);
    }
    if (Number(berth.designDepth) < Number(a.vesselDraft)) {
      violations.push(
        `泊位 ${a.berthNo} 水深 ${berth.designDepth}m 小于 ${a.vesselName} 吃水 ${a.vesselDraft}m`,
      );
    }
    if (occupancyBlocks(berth, a.startAt, a.endAt)) {
      violations.push(`泊位 ${a.berthNo}（${a.slotLabel}）与港内已有占用时段重叠`);
    }
  }

  for (let i = 0; i < assignments.length; i++) {
    for (let j = i + 1; j < assignments.length; j++) {
      const a = assignments[i];
      const b = assignments[j];
      if (a.berthNo === b.berthNo && intervalsOverlap(a.startAt, a.endAt, b.startAt, b.endAt)) {
        violations.push(
          `泊位 ${a.berthNo}：${a.vesselName}（${a.slotLabel}）与 ${b.vesselName}（${b.slotLabel}）靠泊时段重叠`,
        );
      }
    }
  }
  return violations;
}

/**
 * 合并两台离线电脑的草稿：
 * - 稳定编号 = `港口|泊位|靠泊时间ISO`；
 * - 仅一侧存在 → 直接并入；
 * - 两侧同编号且安排一致 → 视为同一条；
 * - 两侧同编号但排了不同船（或离泊时间不同）→ 列为冲突；
 * - 任一侧待排但合并并集里仍未排上 → 计入 pendingVesselIds。
 * 存在冲突或硬性违反（重叠 / 水深 / 占用）时 ok=false，调用方保留原草稿。
 */
export function mergeSideDrafts(input: MergeInput): MergeResult {
  const mergedAt = new Date().toISOString();
  const conflicts: MergeConflict[] = [];
  const merged: BerthAssignment[] = [];

  const coopMap = new Map(input.coop.assignments.map((a) => [a.key, a]));
  const dutyMap = new Map(input.duty.assignments.map((a) => [a.key, a]));
  const allKeys = Array.from(new Set([...coopMap.keys(), ...dutyMap.keys()])).sort();

  for (const key of allKeys) {
    const c = coopMap.get(key) ?? null;
    const d = dutyMap.get(key) ?? null;
    if (c && d) {
      if (sameAssignment(c, d)) {
        merged.push({ ...c, updatedAt: c.updatedAt > d.updatedAt ? c.updatedAt : d.updatedAt });
      } else {
        conflicts.push({
          key,
          berthNo: c.berthNo,
          slotLabel: c.slotLabel || d.slotLabel,
          startAt: c.startAt,
          coop: c,
          duty: d,
          detail:
            c.vesselId === d.vesselId
              ? `${c.vesselName} 的计划离泊时间两边不一致`
              : `合作社排 ${c.vesselName}，值班室排 ${d.vesselName}`,
        });
      }
    } else if (c) {
      merged.push(c);
    } else if (d) {
      merged.push(d);
    }
  }

  // 硬性违反在非冲突并集上校验（冲突已单独列出）
  const violations = validateMerged(merged, input.berths);

  // 待排：一侧报待排、合并并集里仍未排上的渔船
  const placedVesselIds = new Set(merged.map((a) => a.vesselId));
  const pendingVesselIds = Array.from(
    new Set([...input.coop.pendingVesselIds, ...input.duty.pendingVesselIds]),
  ).filter((id) => !placedVesselIds.has(id));

  const ok = conflicts.length === 0 && violations.length === 0;

  const assignments = [...merged].sort((a, b) =>
    `${a.startAt}|${a.berthNo}`.localeCompare(`${b.startAt}|${b.berthNo}`),
  );

  // 成功时保留上一版同编号同船的落实状态，避免重新合并冲掉实际登记
  if (ok && input.previousMerged?.length) {
    const prev = new Map(input.previousMerged.map((a) => [a.key, a]));
    for (let i = 0; i < assignments.length; i++) {
      const a = assignments[i];
      const old = prev.get(a.key);
      if (old && old.vesselId === a.vesselId && old.status !== '待落实') {
        assignments[i] = { ...a, status: old.status, voidReason: old.voidReason };
      }
    }
  }

  return { ok, assignments, conflicts, violations, pendingVesselIds, mergedAt };
}

/** 实际进港与预排时间允许的偏差（小时），超出视为时间变化、旧安排失效 */
const TIME_TOLERANCE_MS = 3 * 60 * 60 * 1000;

export interface ReconcileEvent {
  key: string;
  portId: string;
  vesselId: string;
  vesselName: string;
  berthNo: string;
  slotLabel: string;
  plannedStartAt: string;
  plannedEndAt: string;
  callId?: string;
  actualTime?: string;
  actualBerthNo?: string;
  result: '已落实' | '已失效';
  reason: string;
  at: string;
}

/** 取某船某次进港后的离港时间，用于界定实际占用区间 */
function departureAfter(calls: PortCall[], vesselId: string, afterTime: string): string | null {
  const after = new Date(afterTime).getTime();
  const out = calls
    .filter((c) => c.vesselId === vesselId && c.type === '出港')
    .map((c) => new Date(c.time).getTime())
    .filter((t) => !Number.isNaN(t) && t >= after)
    .sort((a, b) => a - b)[0];
  return out ? new Date(out).toISOString() : null;
}

/**
 * 预排后根据实际进出港流水对账：
 * - 实际进港泊位与预排一致且时间偏差不大 → 已落实；
 * - 泊位变了 / 时间变了 → 旧安排失效（历史留痕，不删除）；
 * - 实际进港占用了别的船预排的泊位（时段重叠）→ 那条预排失效；
 * 只核对警报拉响（plan.alertAt）之后的流水。
 */
export function reconcileAssignments(
  assignments: BerthAssignment[],
  calls: PortCall[],
  alertAt: string,
): { next: BerthAssignment[]; events: ReconcileEvent[] } {
  const events: ReconcileEvent[] = [];
  const alertTime = new Date(alertAt).getTime();
  const postInbounds = calls.filter(
    (c) =>
      c.type === '进港' &&
      !Number.isNaN(new Date(c.time).getTime()) &&
      new Date(c.time).getTime() >= alertTime,
  );

  const next = assignments.map((a) => {
    if (a.status !== '待落实') return a;
    const at = new Date().toISOString();

    // 1) 本船实际进港
    const own = postInbounds
      .filter((c) => c.vesselId === a.vesselId)
      .sort((x, y) => new Date(x.time).getTime() - new Date(y.time).getTime())[0];
    if (own) {
      const drift = Math.abs(new Date(own.time).getTime() - new Date(a.startAt).getTime());
      if (own.berthNo === a.berthNo && drift <= TIME_TOLERANCE_MS) {
        events.push({
          key: a.key, portId: a.portId, vesselId: a.vesselId, vesselName: a.vesselName,
          berthNo: a.berthNo, slotLabel: a.slotLabel, plannedStartAt: a.startAt, plannedEndAt: a.endAt,
          callId: own.id, actualTime: own.time, actualBerthNo: own.berthNo,
          result: '已落实', reason: `实际进港泊位与预排一致（${own.berthNo}）`, at,
        });
        return { ...a, status: '已落实' as const };
      }
      const reason =
        own.berthNo !== a.berthNo
          ? `实际靠泊 ${own.berthNo}，与预排泊位 ${a.berthNo} 不符，旧安排失效`
          : `实际进港时间与预排时段偏差超过 3 小时，旧安排失效`;
      events.push({
        key: a.key, portId: a.portId, vesselId: a.vesselId, vesselName: a.vesselName,
        berthNo: a.berthNo, slotLabel: a.slotLabel, plannedStartAt: a.startAt, plannedEndAt: a.endAt,
        callId: own.id, actualTime: own.time, actualBerthNo: own.berthNo,
        result: '已失效', reason, at,
      });
      return { ...a, status: '已失效' as const, voidReason: reason };
    }

    // 2) 别的船实际进港占了同一泊位且时段重叠
    const blocker = postInbounds.find((c) => {
      if (c.berthNo !== a.berthNo || c.vesselId === a.vesselId) return false;
      const out = departureAfter(calls, c.vesselId, c.time);
      return intervalsOverlap(a.startAt, a.endAt, c.time, out ?? '9999-12-31T23:59:59Z');
    });
    if (blocker) {
      const reason = `泊位 ${a.berthNo} 已由 ${blocker.vesselName} 实际靠泊，${a.vesselName} 的预排失效`;
      events.push({
        key: a.key, portId: a.portId, vesselId: a.vesselId, vesselName: a.vesselName,
        berthNo: a.berthNo, slotLabel: a.slotLabel, plannedStartAt: a.startAt, plannedEndAt: a.endAt,
        callId: blocker.id, actualTime: blocker.time, actualBerthNo: blocker.berthNo,
        result: '已失效', reason, at,
      });
      return { ...a, status: '已失效' as const, voidReason: reason };
    }
    return a;
  });

  return { next, events };
}

/** 从方案的合并结果中按靠泊时段分组（保持时段时间序） */
export function groupAssignmentsBySlot(plan: ShelterPlan): Array<{
  slotLabel: string;
  startAt: string;
  endAt: string;
  items: BerthAssignment[];
}> {
  const map = new Map<string, { slotLabel: string; startAt: string; endAt: string; items: BerthAssignment[] }>();
  for (const a of plan.merged) {
    const g = map.get(a.startAt) ?? { slotLabel: a.slotLabel, startAt: a.startAt, endAt: a.endAt, items: [] };
    g.items.push(a);
    map.set(a.startAt, g);
  }
  return Array.from(map.values())
    .sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime())
    .map((g) => ({ ...g, items: g.items.sort((x, y) => x.berthNo.localeCompare(y.berthNo)) }));
}
