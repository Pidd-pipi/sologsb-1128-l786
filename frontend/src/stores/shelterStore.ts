import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { db } from '../db';
import { toPlain, uid } from '../utils/format';
import type { ArrangeSlot, AssignmentHistory, BerthAssignment, PlanSide, ShelterPlan, SideDraft } from '../types/shelter';
import { buildAssignmentKey, emptySideDraft } from '../types/shelter';
import type { Berth } from '../types/berth';
import type { PortCall } from '../types/call';
import { autoArrange, intervalsOverlap, mergeSideDrafts, reconcileAssignments } from '../utils/shelter';

function toIso(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toISOString();
}

function sortAssignments(list: BerthAssignment[]): BerthAssignment[] {
  return [...list].sort((a, b) => `${a.startAt}|${a.berthNo}`.localeCompare(`${b.startAt}|${b.berthNo}`));
}

export interface CreatePlanInput {
  portId: string;
  typhoonName: string;
  alertAt: string;
  slots: ArrangeSlot[];
}

export interface ManualAssignmentInput {
  portId: string;
  berthNo: string;
  berthDepth: number;
  vesselId: string;
  vesselName: string;
  vesselDraft: number;
  slot: ArrangeSlot;
}

export interface MergeOutcome {
  ok: boolean;
  conflictCount: number;
  violationCount: number;
  mergedCount: number;
  pendingCount: number;
}

/**
 * 避风预排：合作社 / 值班室两台离线电脑各自整份草稿，回港后按稳定编号合并。
 * 合并成功才覆盖权威结果；失败（冲突 / 重叠 / 水深 / 异常）保留两侧原草稿。
 */
export const useShelterStore = defineStore('shelter', () => {
  const plans = ref<ShelterPlan[]>([]);
  const loading = ref(false);
  const activeId = ref('');

  const activePlan = computed(() => plans.value.find((p) => p.id === activeId.value) ?? null);
  const sortedPlans = computed(() =>
    [...plans.value].sort((a, b) => new Date(b.alertAt).getTime() - new Date(a.alertAt).getTime()),
  );

  function planById(id: string): ShelterPlan | undefined {
    return plans.value.find((p) => p.id === id);
  }

  /** 某渔港最近一次（生效中）避风预排 */
  function latestPlanOfPort(portId: string): ShelterPlan | undefined {
    return sortedPlans.value.find((p) => p.portId === portId);
  }

  /** 某渔船在所有合并结果中的避风安排（含已失效，历史不丢） */
  function assignmentsOfVessel(vesselId: string): Array<{ plan: ShelterPlan; assignment: BerthAssignment }> {
    const out: Array<{ plan: ShelterPlan; assignment: BerthAssignment }> = [];
    for (const plan of plans.value) {
      for (const assignment of plan.merged) {
        if (assignment.vesselId === vesselId) out.push({ plan, assignment });
      }
    }
    return out.sort((a, b) => new Date(a.assignment.startAt).getTime() - new Date(b.assignment.startAt).getTime());
  }

  /** 某渔港所有合并安排（供地图 / 详情统一查看） */
  function mergedAssignmentsOfPort(portId: string): BerthAssignment[] {
    const plan = latestPlanOfPort(portId);
    return plan ? sortAssignments(plan.merged) : [];
  }

  /** 方案待排渔船（名称由调用页传入的渔船名册解析） */
  function pendingVesselsOfPlan(
    plan: ShelterPlan,
    vesselNames: Map<string, string>,
  ): Array<{ id: string; name: string }> {
    return plan.pendingVesselIds.map((id) => ({ id, name: vesselNames.get(id) ?? id }));
  }

  async function loadAll(): Promise<void> {
    loading.value = true;
    try {
      plans.value = await db.shelterPlans.toArray();
      if (!activeId.value && plans.value.length) activeId.value = sortedPlans.value[0].id;
    } finally {
      loading.value = false;
    }
  }

  async function persist(plan: ShelterPlan): Promise<void> {
    const next: ShelterPlan = { ...plan, updatedAt: new Date().toISOString() };
    await db.shelterPlans.put(toPlain(next));
    plans.value = plans.value.map((p) => (p.id === next.id ? next : p));
  }

  async function createPlan(input: CreatePlanInput): Promise<ShelterPlan> {
    const now = new Date().toISOString();
    const slots: ArrangeSlot[] = input.slots.map((s) => ({
      label: s.label,
      startAt: toIso(s.startAt),
      endAt: toIso(s.endAt),
    }));
    const plan: ShelterPlan = {
      id: uid('sp'),
      portId: input.portId,
      typhoonName: input.typhoonName.trim(),
      alertAt: toIso(input.alertAt || now),
      slots,
      coop: emptySideDraft('coop'),
      duty: emptySideDraft('duty'),
      merged: [],
      pendingVesselIds: [],
      mergedAt: null,
      revision: 0,
      conflicts: [],
      violations: [],
      lastMergeOk: null,
      history: [],
      createdAt: now,
      updatedAt: now,
    };
    await db.shelterPlans.put(toPlain(plan));
    plans.value = [...plans.value, plan];
    activeId.value = plan.id;
    return plan;
  }

  function setActive(id: string): void {
    activeId.value = id;
  }

  /** 用当前草案替换某一侧（整份覆盖，离线语义），立即落 IndexedDB */
  async function saveSideDraft(planId: string, side: PlanSide, draft: SideDraft): Promise<void> {
    const plan = planById(planId);
    if (!plan) return;
    const saved: SideDraft = {
      ...toPlain(draft),
      savedAt: new Date().toISOString(),
    };
    await persist({ ...plan, [side]: saved });
  }

  /** 自动排泊：在某一侧把给定渔船排进指定时段，未排上的并入该侧待排集合 */
  async function autoArrangeSide(
    planId: string,
    side: PlanSide,
    slot: ArrangeSlot,
    vessels: Array<{ id: string; name: string; draftDepth: number }>,
    berths: Berth[],
  ): Promise<{ placed: number; unplaced: Array<{ id: string; name: string }> }> {
    const plan = planById(planId);
    if (!plan) return { placed: 0, unplaced: [] };
    const draft = plan[side];
    const normSlot: ArrangeSlot = {
      label: slot.label,
      startAt: toIso(slot.startAt),
      endAt: toIso(slot.endAt),
    };
    const result = autoArrange({
      portId: plan.portId,
      slot: normSlot,
      vessels,
      berths,
      existing: draft.assignments,
      side,
    });

    // 重排语义：只替换本次勾选渔船的安排；该时段中其它船（未勾选）与其它时段的安排保留
    const slotStart = normSlot.startAt;
    const inputIds = new Set(vessels.map((v) => v.id));
    const kept = draft.assignments.filter(
      (a) => a.startAt !== slotStart || !inputIds.has(a.vesselId),
    );
    const assignments = sortAssignments([...kept, ...result.placed]);

    // 待排集合：本次勾选的船先从待排清掉，再按新结果回填；未勾选船的待排状态保持不变
    const pending = new Set(draft.pendingVesselIds.filter((id) => !inputIds.has(id)));
    for (const v of result.unplaced) pending.add(v.id);

    await saveSideDraft(planId, side, {
      ...draft,
      assignments,
      pendingVesselIds: Array.from(pending),
    });
    return {
      placed: result.placed.length,
      unplaced: result.unplaced.map((v) => ({ id: v.id, name: v.name })),
    };
  }

  /** 手动在某一侧加入 / 覆盖一条安排；返回 null 表示与本侧时段或水深冲突 */
  async function setSideAssignment(
    planId: string,
    side: PlanSide,
    input: ManualAssignmentInput,
  ): Promise<{ ok: boolean; reason: string }> {
    const plan = planById(planId);
    if (!plan) return { ok: false, reason: '方案不存在' };
    const berthDepth = Number(input.berthDepth);
    const vesselDraft = Number(input.vesselDraft);
    if (berthDepth < vesselDraft) {
      return { ok: false, reason: `泊位水深 ${berthDepth}m 小于渔船吃水 ${vesselDraft}m` };
    }
    const startAt = toIso(input.slot.startAt);
    const endAt = toIso(input.slot.endAt);
    const draft = plan[side];
    const key = buildAssignmentKey(plan.portId, input.berthNo, startAt);

    const clashBerth = draft.assignments.find(
      (a) => a.key !== key && a.berthNo === input.berthNo && intervalsOverlap(startAt, endAt, a.startAt, a.endAt),
    );
    if (clashBerth) return { ok: false, reason: `与 ${clashBerth.vesselName} 在 ${input.berthNo} 的靠泊时段重叠` };
    const clashVessel = draft.assignments.find(
      (a) => a.key !== key && a.vesselId === input.vesselId && intervalsOverlap(startAt, endAt, a.startAt, a.endAt),
    );
    if (clashVessel) return { ok: false, reason: `${input.vesselName} 在重叠时段已排到 ${clashVessel.berthNo}` };

    const assignment: BerthAssignment = {
      key,
      portId: plan.portId,
      berthNo: input.berthNo,
      berthDepth,
      vesselId: input.vesselId,
      vesselName: input.vesselName,
      vesselDraft,
      startAt,
      endAt,
      slotLabel: input.slot.label,
      source: side,
      status: '待落实',
      updatedAt: new Date().toISOString(),
    };
    const rest = draft.assignments.filter((a) => a.key !== key);
    const pending = new Set(draft.pendingVesselIds.filter((id) => id !== input.vesselId));
    await saveSideDraft(planId, side, {
      ...draft,
      assignments: sortAssignments([...rest, assignment]),
      pendingVesselIds: Array.from(pending),
    });
    return { ok: true, reason: '' };
  }

  async function removeSideAssignment(planId: string, side: PlanSide, key: string): Promise<void> {
    const plan = planById(planId);
    if (!plan) return;
    const draft = plan[side];
    await saveSideDraft(planId, side, {
      ...draft,
      assignments: draft.assignments.filter((a) => a.key !== key),
    });
  }

  /**
   * 合并两侧离线草稿。整份覆盖权威结果；有冲突 / 违反或抛异常时不覆盖，
   * 两侧原草稿保持不变（恢复原草稿语义），仅记录冲突与原因供查看。
   */
  async function merge(planId: string, berths: Berth[]): Promise<MergeOutcome> {
    const plan = planById(planId);
    if (!plan) return { ok: false, conflictCount: 0, violationCount: 0, mergedCount: 0, pendingCount: 0 };
    const snapshot = toPlain(plan);
    try {
      const result = mergeSideDrafts({
        portId: plan.portId,
        coop: toPlain(plan.coop),
        duty: toPlain(plan.duty),
        berths,
        previousMerged: plan.merged,
      });

      if (!result.ok) {
        // 失败：保留两侧原草稿，只写回诊断信息，权威结果与修订号不动
        await persist({
          ...plan,
          conflicts: result.conflicts,
          violations: result.violations,
          lastMergeOk: false,
        });
        return {
          ok: false,
          conflictCount: result.conflicts.length,
          violationCount: result.violations.length,
          mergedCount: result.assignments.length,
          pendingCount: result.pendingVesselIds.length,
        };
      }

      await persist({
        ...plan,
        merged: result.assignments,
        pendingVesselIds: result.pendingVesselIds,
        mergedAt: result.mergedAt,
        revision: plan.revision + 1,
        conflicts: [],
        violations: [],
        lastMergeOk: true,
      });
      return {
        ok: true,
        conflictCount: 0,
        violationCount: 0,
        mergedCount: result.assignments.length,
        pendingCount: result.pendingVesselIds.length,
      };
    } catch (error) {
      // 异常：整体回滚到合并前快照（恢复原来草稿）
      await db.shelterPlans.put(toPlain(snapshot));
      plans.value = plans.value.map((p) => (p.id === snapshot.id ? snapshot : p));
      throw error;
    }
  }

  /** 登记实际进出港后对账：时间 / 泊位变化让旧安排失效，事件写入历史（不删记录） */
  async function reconcileWithCalls(planId: string, calls: PortCall[]): Promise<number> {
    const plan = planById(planId);
    if (!plan || !plan.merged.length) return 0;
    const { next, events } = reconcileAssignments(toPlain(plan.merged), calls, plan.alertAt);
    if (!events.length) return 0;

    const existingKeys = new Set(plan.history.map((h) => `${h.assignmentKey}|${h.result}|${h.actualCallId ?? ''}`));
    const added: AssignmentHistory[] = events
      .filter((e) => !existingKeys.has(`${e.key}|${e.result}|${e.callId ?? ''}`))
      .map((e) => ({
        id: uid('sph'),
        assignmentKey: e.key,
        vesselId: e.vesselId,
        vesselName: e.vesselName,
        portId: e.portId,
        berthNo: e.berthNo,
        slotLabel: e.slotLabel,
        plannedStartAt: e.plannedStartAt,
        plannedEndAt: e.plannedEndAt,
        actualCallId: e.callId,
        actualTime: e.actualTime,
        actualBerthNo: e.actualBerthNo,
        result: e.result,
        reason: e.reason,
        at: e.at,
      }));

    await persist({ ...plan, merged: next, history: [...plan.history, ...added] });
    return added.length;
  }

  /** 对全部方案做一次对账（进出港登记页提交后调用） */
  async function reconcileAll(calls: PortCall[]): Promise<number> {
    let total = 0;
    for (const plan of [...plans.value]) {
      total += await reconcileWithCalls(plan.id, calls);
    }
    return total;
  }

  async function removePlan(planId: string): Promise<void> {
    await db.shelterPlans.delete(planId);
    plans.value = plans.value.filter((p) => p.id !== planId);
    if (activeId.value === planId) activeId.value = sortedPlans.value[0]?.id ?? '';
  }

  return {
    plans,
    loading,
    activeId,
    activePlan,
    sortedPlans,
    loadAll,
    planById,
    setActive,
    latestPlanOfPort,
    assignmentsOfVessel,
    mergedAssignmentsOfPort,
    pendingVesselsOfPlan,
    createPlan,
    saveSideDraft,
    autoArrangeSide,
    setSideAssignment,
    removeSideAssignment,
    merge,
    reconcileWithCalls,
    reconcileAll,
    removePlan,
  };
});
