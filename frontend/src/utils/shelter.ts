/**
 * 避风预排纯逻辑：吃水估算、水深适配、时段重叠判定、容量约束自动分配、
 * 两边离线草稿按稳定编号合并、合并结果容量校验。
 */
import type { Berth } from '../types/berth';
import type { FishingVessel } from '../types/vessel';
import {
  shelterEntryId,
  type ShelterConflict,
  type ShelterDraft,
  type ShelterEntry,
  type ShelterMergeResult,
  type ShelterProblem,
  type ShelterWindow,
} from '../types/shelter';

/** 富裕水深余量 m：泊位水深至少比渔船吃水深这么多 */
export const UKC_MARGIN = 0.3;

const MINUTE = 60 * 1000;

/** 由渔船主尺度估算吃水 m（未登记实际吃水时的兜底，与型宽、吨位正相关） */
export function estimateDraft(vessel: FishingVessel): number {
  const beam = Number(vessel.beam) || 0;
  const tonnage = Number(vessel.grossTonnage) || 0;
  const raw = 0.5 * beam + 0.002 * tonnage;
  return Math.round(Math.max(1.2, raw) * 10) / 10;
}

/** 渔船吃水（优先取档案登记值） */
export function vesselDraft(vessel: FishingVessel): number {
  const d = Number(vessel.draft);
  return Number.isFinite(d) && d > 0 ? d : estimateDraft(vessel);
}

/** 水深适配：泊位设计水深 ≥ 吃水 + 富裕余量 */
export function isDepthCompatible(berth: Berth, draft: number): boolean {
  return berth.designDepth + 1e-6 >= draft + UKC_MARGIN;
}

/** 两个时段是否重叠（首尾相接不算重叠） */
export function intervalsOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  const as = new Date(aStart).getTime();
  const ae = new Date(aEnd).getTime();
  const bs = new Date(bStart).getTime();
  const be = new Date(bEnd).getTime();
  if ([as, ae, bs, be].some((t) => Number.isNaN(t))) return false;
  return as < be && bs < ae;
}

interface Interval {
  start: string;
  end: string;
}

/** 泊位在预排窗口内被占用的时段（现有在港占用 + 维修） */
function blockedIntervals(berth: Berth, window: ShelterWindow): Interval[] {
  const list: Interval[] = [];
  const ws = new Date(window.start).getTime();
  const we = new Date(window.end).getTime();
  if (Number.isNaN(ws) || Number.isNaN(we)) return list;

  if (berth.status === '维修') {
    list.push({ start: window.start, end: window.end });
    return list;
  }
  if (berth.status === '占用' && berth.berthAt) {
    const start = new Date(berth.berthAt).getTime();
    const end = berth.leaveAt ? new Date(berth.leaveAt).getTime() : we;
    if (!Number.isNaN(start) && !Number.isNaN(end)) {
      const bs = Math.max(start, ws);
      const be = Math.min(end, we);
      if (bs < be) list.push({ start: new Date(bs).toISOString(), end: new Date(be).toISOString() });
    }
  }
  return list;
}

export interface ScheduleInput {
  vessels: FishingVessel[];
  berths: Berth[];
  window: ShelterWindow;
}

export interface ScheduleOutput {
  scheduled: ShelterEntry[];
  pending: ShelterEntry[];
}

function makeEntry(
  vessel: FishingVessel,
  window: ShelterWindow,
  berth: Berth | null,
  status: ShelterEntry['status'],
  note?: string,
): ShelterEntry {
  return {
    id: shelterEntryId(vessel.id),
    vesselId: vessel.id,
    vesselName: vessel.name,
    draft: vesselDraft(vessel),
    berthId: berth?.id ?? null,
    berthNo: berth?.berthNo ?? null,
    start: window.start,
    end: window.end,
    status,
    note,
  };
}

/**
 * 容量约束自动分配：
 * - 按吃水从大到小分配（大船优先选深泊位）
 * - 候选泊位：非维修且水深适配，按水深从小到大排序（深泊位留给大船）
 * - 同一泊位时段不重叠：现有在港占用、维修、已排条目都算进去
 * - 排不下的船进入待排（保留已排船只，不强行超容）
 */
export function scheduleShelter(input: ScheduleInput): ScheduleOutput {
  const { vessels, berths, window } = input;
  // 调用方传入的 berths 已按渔港过滤（portStore.berthsOf(portId)）
  const scoped = berths;
  const intervalsByBerth = new Map<string, Interval[]>();
  for (const b of scoped) intervalsByBerth.set(b.id, blockedIntervals(b, window));

  const sortedVessels = [...vessels].sort((a, b) => vesselDraft(b) - vesselDraft(b) || b.grossTonnage - a.grossTonnage);
  const scheduled: ShelterEntry[] = [];
  const pending: ShelterEntry[] = [];

  for (const vessel of sortedVessels) {
    const draft = vesselDraft(vessel);
    const candidates = scoped
      .filter((b) => b.status !== '维修' && isDepthCompatible(b, draft))
      .sort((a, b) => a.designDepth - b.designDepth);

    let hit: Berth | null = null;
    for (const berth of candidates) {
      const blocked = intervalsByBerth.get(berth.id) ?? [];
      const clash = blocked.some((iv) => intervalsOverlap(iv.start, iv.end, window.start, window.end));
      if (!clash) {
        hit = berth;
        break;
      }
    }

    if (hit) {
      scheduled.push(makeEntry(vessel, window, hit, 'scheduled'));
      intervalsByBerth.get(hit.id)?.push({ start: window.start, end: window.end });
    } else {
      const anyDeep = scoped.some((b) => b.status !== '维修' && isDepthCompatible(b, draft));
      const note = anyDeep ? '预排时段内泊位已满' : `吃水 ${draft.toFixed(1)}m，无适配水深泊位（需 ≥ ${(draft + UKC_MARGIN).toFixed(1)}m）`;
      pending.push(makeEntry(vessel, window, null, 'pending', note));
    }
  }

  return { scheduled, pending };
}

function entrySignature(e: ShelterEntry): string {
  return `${e.berthId ?? ''}|${e.start}|${e.end}`;
}

/**
 * 两边离线草稿按稳定编号合并：
 * - 仅一方有的条目直接并入
 * - 双方都有且内容一致（泊位 + 时段相同）直接并入
 * - 双方都改过且不一致 → 列入冲突，交人工选择
 */
export function mergeDrafts(base: ShelterDraft, incoming: ShelterDraft): ShelterMergeResult {
  const baseMap = new Map(base.entries.map((e) => [e.id, e]));
  const incomingMap = new Map(incoming.entries.map((e) => [e.id, e]));
  const ids = new Set([...baseMap.keys(), ...incomingMap.keys()]);

  const entries: ShelterEntry[] = [];
  const conflicts: ShelterConflict[] = [];

  for (const id of ids) {
    const a = baseMap.get(id) ?? null;
    const b = incomingMap.get(id) ?? null;
    if (a && !b) {
      entries.push(a);
    } else if (!a && b) {
      entries.push(b);
    } else if (a && b) {
      if (entrySignature(a) === entrySignature(b)) {
        entries.push(a);
      } else {
        conflicts.push({ entryId: id, vesselId: a.vesselId, vesselName: a.vesselName, base: a, incoming: b });
      }
    }
  }

  return { entries, conflicts };
}

/** 按人工选择（base / incoming）消解冲突，返回合并后完整条目列表 */
export function resolveConflicts(
  merged: ShelterMergeResult,
  resolutions: Record<string, 'base' | 'incoming'>,
): ShelterEntry[] {
  const out = new Map(merged.entries.map((e) => [e.id, e]));
  for (const conflict of merged.conflicts) {
    const pick = resolutions[conflict.entryId];
    const chosen = pick === 'incoming' ? conflict.incoming : pick === 'base' ? conflict.base : null;
    if (chosen) out.set(conflict.entryId, chosen);
  }
  return [...out.values()];
}

/**
 * 合并结果容量校验：已排条目不得与现有占用 / 维修冲突、不得同泊位时段重叠、
 * 泊位水深必须适配。任一问题都导致合并失败（调用方恢复原草稿）。
 */
export function validateMergedEntries(entries: ShelterEntry[], berths: Berth[], window: ShelterWindow): ShelterProblem[] {
  const problems: ShelterProblem[] = [];
  const berthMap = new Map(berths.map((b) => [b.id, b]));
  const intervalsByBerth = new Map<string, Interval[]>();
  for (const b of berths) intervalsByBerth.set(b.id, blockedIntervals(b, window));

  const scheduled = entries.filter((e) => e.status === 'scheduled' && e.berthId);
  for (const entry of scheduled) {
    const berth = berthMap.get(entry.berthId as string);
    if (!berth) {
      problems.push({ entryId: entry.id, vesselName: entry.vesselName, message: '泊位不存在' });
      continue;
    }
    if (berth.status === '维修') {
      problems.push({ entryId: entry.id, vesselName: entry.vesselName, message: `${berth.berthNo} 为维修泊位` });
      continue;
    }
    if (!isDepthCompatible(berth, entry.draft)) {
      problems.push({
        entryId: entry.id,
        vesselName: entry.vesselName,
        message: `${berth.berthNo} 水深 ${berth.designDepth.toFixed(1)}m 不适配吃水 ${entry.draft.toFixed(1)}m`,
      });
    }
    const blocked = intervalsByBerth.get(berth.id) ?? [];
    if (blocked.some((iv) => intervalsOverlap(iv.start, iv.end, entry.start, entry.end))) {
      problems.push({ entryId: entry.id, vesselName: entry.vesselName, message: `${berth.berthNo} 与现有占用时段冲突` });
    }
    intervalsByBerth.get(berth.id)?.push({ start: entry.start, end: entry.end });
  }
  return problems;
}

/** 计划条目计数：已排 / 待排 / 失效 */
export function planCounts(entries: ShelterEntry[]): { scheduled: number; pending: number; invalidated: number } {
  return {
    scheduled: entries.filter((e) => e.status === 'scheduled').length,
    pending: entries.filter((e) => e.status === 'pending').length,
    invalidated: entries.filter((e) => e.status === 'invalidated').length,
  };
}

/** 两个 ISO 时间相差毫秒数（绝对值） */
export function diffMinutes(a: string, b: string): number {
  const da = new Date(a).getTime();
  const db = new Date(b).getTime();
  if (Number.isNaN(da) || Number.isNaN(db)) return Number.NaN;
  return Math.abs(da - db) / MINUTE;
}
