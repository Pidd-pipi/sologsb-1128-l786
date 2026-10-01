import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { db } from '../db';
import { toPlain, uid } from '../utils/format';
import { usePortStore } from './portStore';
import { useVesselStore } from './vesselStore';
import {
  mergeDrafts as mergeDraftEntries,
  resolveConflicts,
  scheduleShelter,
  validateMergedEntries,
} from '../utils/shelter';
import type { PortCall } from '../types/call';
import {
  type ShelterConflict,
  type ShelterDraft,
  type ShelterEntry,
  type ShelterPlan,
  type ShelterSide,
  type ShelterWindow,
} from '../types/shelter';
import { formatDateTime } from '../utils/format';

const DRAFT_PREFIX = 'gbfishport:shelter-draft:';

export interface MergeOutcome {
  ok: boolean;
  /** 合并后的条目（成功时返回） */
  entries?: ShelterEntry[];
  /** 两边都改过且未消解的冲突 */
  conflicts?: ShelterConflict[];
  /** 容量 / 适配校验问题（合并失败） */
  problems?: string[];
  error?: string;
}

/**
 * 避风预排状态：
 * - 草稿（合作社 / 值班室各一份）断网保存在 localStorage，模拟两台离线电脑
 * - 回到港区后合并，结果整份覆盖写入 IndexedDB shelterPlans 表
 * - 实际进出港登记会让不符的旧安排失效，但历史安排保留不删
 */
export const useShelterStore = defineStore('shelter', () => {
  const plans = ref<ShelterPlan[]>([]);
  const loaded = ref(false);

  const plansSorted = computed(() =>
    [...plans.value].sort((a, b) => new Date(b.mergedAt).getTime() - new Date(a.mergedAt).getTime()),
  );

  function activePlanOfPort(portId: string): ShelterPlan | undefined {
    return plansSorted.value.find((p) => p.portId === portId && p.status === 'active');
  }

  function plansOfPort(portId: string): ShelterPlan[] {
    return plansSorted.value.filter((p) => p.portId === portId);
  }

  /** 渔船当前生效的避风安排（地图 / 渔港详情 / 渔船档案共用同一批结果） */
  function planOfVessel(vesselId: string): ShelterPlan | undefined {
    return plansSorted.value.find(
      (p) => p.status === 'active' && p.entries.some((e) => e.vesselId === vesselId && e.status === 'scheduled'),
    );
  }

  function entryOfVessel(vesselId: string): ShelterEntry | undefined {
    const plan = planOfVessel(vesselId);
    return plan?.entries.find((e) => e.vesselId === vesselId && e.status === 'scheduled');
  }

  async function loadAll(): Promise<void> {
    loaded.value = true;
    plans.value = await db.shelterPlans.toArray();
  }

  // ---- 离线草稿（localStorage） ----

  function draftKey(portId: string, side: ShelterSide): string {
    return `${DRAFT_PREFIX}${portId}:${side}`;
  }

  function readDraft(portId: string, side: ShelterSide): ShelterDraft | null {
    try {
      const raw = localStorage.getItem(draftKey(portId, side));
      if (!raw) return null;
      return JSON.parse(raw) as ShelterDraft;
    } catch {
      return null;
    }
  }

  function saveDraft(draft: ShelterDraft): void {
    try {
      localStorage.setItem(draftKey(draft.portId, draft.side), JSON.stringify(draft));
    } catch {
      // localStorage 不可用时静默降级
    }
  }

  function clearDraft(portId: string, side: ShelterSide): void {
    try {
      localStorage.removeItem(draftKey(portId, side));
    } catch {
      // 忽略
    }
  }

  /**
   * 按渔船吃水与泊位水深适配、同一泊位时段不重叠、港内已有占用也算进去，
   * 容量不足时留下已排船只与待排数量，生成一方离线草稿。
   */
  function autoSchedule(portId: string, side: ShelterSide, typhoonNo: string, window: ShelterWindow): ShelterDraft {
    const portStore = usePortStore();
    const vesselStore = useVesselStore();
    const { scheduled, pending } = scheduleShelter({
      vessels: vesselStore.vessels,
      berths: portStore.berthsOf(portId),
      window,
    });
    const draft: ShelterDraft = {
      portId,
      typhoonNo: typhoonNo.trim() || '未命名台风',
      side,
      window,
      entries: [...scheduled, ...pending],
      savedAt: new Date().toISOString(),
    };
    saveDraft(draft);
    return draft;
  }

  /** 手工调整某条草稿条目（改泊位 / 改待排），改完立即落草稿 */
  function updateDraftEntry(
    portId: string,
    side: ShelterSide,
    entryId: string,
    patch: Partial<Pick<ShelterEntry, 'berthId' | 'berthNo' | 'status' | 'note'>>,
  ): ShelterDraft | null {
    const draft = readDraft(portId, side);
    if (!draft) return null;
    draft.entries = draft.entries.map((e) => (e.id === entryId ? { ...e, ...patch } : e));
    draft.savedAt = new Date().toISOString();
    saveDraft(draft);
    return draft;
  }

  // ---- 回到港区合并 ----

  /**
   * 合并两边离线草稿：
   * - 不同条目直接并入；同一稳定编号两边都改且不一致 → 冲突（需人工选择）
   * - 冲突未消解或容量校验失败 → 合并失败，草稿原样保留（调用方提示恢复）
   */
  function mergeDrafts(portId: string, resolutions?: Record<string, 'base' | 'incoming'>): MergeOutcome {
    const base = readDraft(portId, 'cooperative');
    const incoming = readDraft(portId, 'duty');
    if (!base || !incoming) {
      return { ok: false, error: '缺少合作社或值班室的离线草稿，无法合并' };
    }
    if (base.portId !== incoming.portId) {
      return { ok: false, error: '两份草稿不属于同一渔港，已恢复原草稿' };
    }
    const merged = mergeDraftEntries(base, incoming);
    if (merged.conflicts.length && !resolutions) {
      return { ok: false, conflicts: merged.conflicts };
    }
    if (merged.conflicts.length && merged.conflicts.some((c) => !resolutions?.[c.entryId])) {
      return { ok: false, conflicts: merged.conflicts };
    }
    const entries = merged.conflicts.length ? resolveConflicts(merged, resolutions ?? {}) : merged.entries;

    const portStore = usePortStore();
    const problems = validateMergedEntries(entries, portStore.berthsOf(portId), base.window);
    if (problems.length) {
      return { ok: false, problems: problems.map((p) => `${p.vesselName}：${p.message}`) };
    }
    return { ok: true, entries };
  }

  /**
   * 整份覆盖：用合并结果替换该渔港当前生效的避风安排（旧安排置为 superseded，历史不丢）。
   */
  async function applyPlan(portId: string, typhoonNo: string, entries: ShelterEntry[]): Promise<ShelterPlan> {
    const now = new Date().toISOString();
    const times = entries.flatMap((e) => [e.start, e.end]).sort();
    const window: ShelterWindow = {
      start: times[0] ?? now,
      end: times[times.length - 1] ?? now,
    };

    for (const plan of plans.value.filter((p) => p.portId === portId && p.status === 'active')) {
      const next: ShelterPlan = { ...plan, status: 'superseded' };
      await db.shelterPlans.put(toPlain(next));
    }

    const plan: ShelterPlan = {
      id: uid('sp'),
      portId,
      typhoonNo: typhoonNo.trim() || '未命名台风',
      window,
      entries: entries.map((e) => ({ ...e })),
      status: 'active',
      mergedAt: now,
      createdAt: now,
    };
    await db.shelterPlans.put(toPlain(plan));
    plans.value = [...plans.value.map((p) => (p.portId === portId && p.status === 'active' ? { ...p, status: 'superseded' as const } : p)), plan];
    return plan;
  }

  /**
   * 预排后登记实际进出港：实际时间 / 泊位与预排不符 → 旧安排失效（保留历史，不删除）。
   * 由 portStore.registerCall 在登记成功后调用。
   */
  async function invalidateForCall(call: PortCall): Promise<void> {
    if (!loaded.value) await loadAll();
    let changed = false;
    for (const plan of plans.value.filter((p) => p.status === 'active')) {
      const entry = plan.entries.find((e) => e.vesselId === call.vesselId && e.status === 'scheduled');
      if (!entry) continue;
      const t = new Date(call.time).getTime();
      const start = new Date(entry.start).getTime();
      const end = new Date(entry.end).getTime();
      const inWindow = !Number.isNaN(t) && !Number.isNaN(start) && !Number.isNaN(end) && t >= start && t <= end;
      const berthMatch = entry.berthNo === call.berthNo;
      const mismatch =
        call.type === '出港'
          ? !berthMatch || (!Number.isNaN(end) && !Number.isNaN(t) && t < end)
          : !berthMatch || !inWindow;
      if (!mismatch) continue;

      entry.status = 'invalidated';
      entry.invalidatedReason = `实际${call.type} ${formatDateTime(call.time)} 泊位 ${call.berthNo}，与预排（${entry.berthNo} · ${formatDateTime(entry.start)} ~ ${formatDateTime(entry.end)}）不符`;
      if (plan.entries.every((e) => e.status === 'invalidated' || e.status === 'pending')) {
        plan.status = 'invalidated';
      }
      await db.shelterPlans.put(toPlain(plan));
      changed = true;
    }
    if (changed) plans.value = [...plans.value];
  }

  return {
    plans,
    plansSorted,
    loaded,
    loadAll,
    activePlanOfPort,
    plansOfPort,
    planOfVessel,
    entryOfVessel,
    readDraft,
    saveDraft,
    clearDraft,
    autoSchedule,
    updateDraftEntry,
    mergeDrafts,
    applyPlan,
    invalidateForCall,
  };
});
