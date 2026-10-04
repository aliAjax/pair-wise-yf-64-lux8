// 可恢复指挥流：待同步操作日志、按序合并、冲突与失效裁决、本地持久化与旧数据迁移
// 每台操作台先记带操作编号和会议厅的待同步操作；按发言序号、交接批次、字幕修订对应；
// 发言状态更新后旧版合并操作失效；冲突项两边保留并列出差异；切换会议厅只处理本厅。

export const STORAGE_KEY = 'conference-interpretation-v2';
export const PEER_KEY = 'conference-peer-v1';
const LEGACY_KEY = 'conference-interpretation-v1';

export type SpeechStatus = 'queued' | 'speaking' | 'done' | 'skipped';
export type ChannelStatus = 'active' | 'handoff' | 'standby';
export type OpStatus = 'pending' | 'synced' | 'conflict' | 'superseded';
export type OpType = 'speech-add' | 'speech-status' | 'handoff-start' | 'handoff-complete' | 'caption-revise';

export interface Room { id: string; name: string; topic: string; simultaneousChannels: number; }
export interface Speech {
  id: string;
  roomId: string;
  /** 发言序号（厅内递增，合并对齐键） */
  seq: number;
  speaker: string;
  delegation: string;
  language: string;
  topic: string;
  plannedSeconds: number;
  remainingSeconds: number;
  status: SpeechStatus;
  /** 发言状态版本：每次状态更新 +1，旧版合并操作据此失效 */
  version: number;
  updatedAt: string;
}
export interface Channel { id: string; roomId: string; language: string; interpreter: string; status: ChannelStatus; health: number; activeBatch?: string; }
export interface Term { id: string; phrase: string; translation: string; language: string; approved: boolean; }
export interface Caption { id: string; speechId: string; roomId: string; language: string; interpreter: string; text: string; revision: number; at: string; }
export interface Audit { id: string; at: string; roomId: string; message: string; }

export interface SyncOp {
  /** 操作编号，如 A-0001 */
  opId: string;
  consoleId: string;
  roomId: string;
  type: OpType;
  at: string;
  status: OpStatus;
  /** 发言序号 */
  speechSeq?: number;
  /** 交接批次 */
  handoffBatch?: string;
  /** 字幕修订（操作基于的版本） */
  baseCaptionRevision?: number;
  /** 乐观并发：操作基于的发言状态版本 */
  baseSpeechVersion?: number;
  speechId?: string;
  to?: SpeechStatus;
  channelId?: string;
  interpreter?: string;
  language?: string;
  text?: string;
  speech?: { speaker: string; delegation: string; language: string; topic: string; plannedSeconds: number };
}

export interface ConflictSide { opId: string; consoleId: string; summary: string; value: string; }
export interface ConflictRecord {
  id: string;
  at: string;
  roomId: string;
  kind: 'speech-status' | 'caption-revise' | 'handoff-batch';
  /** 发言冲突：发言序号 */
  seq?: number;
  /** 字幕冲突：发言 + 语言 */
  speechId?: string;
  language?: string;
  /** 交接冲突：批次号 */
  handoffBatch?: string;
  local: ConflictSide;
  remote: ConflictSide;
  resolution?: 'local' | 'remote';
}

export interface ConferenceState {
  dataVersion: number;
  consoleId: string;
  /** 本台操作编号计数 */
  opSeq: number;
  online: boolean;
  rooms: Room[];
  activeRoomId: string;
  speechQueue: Speech[];
  channels: Channel[];
  terms: Term[];
  captions: Caption[];
  audits: Audit[];
  /** 待同步操作日志（指挥流） */
  opLog: SyncOp[];
  conflicts: ConflictRecord[];
  lowLatency: boolean;
}

const now = () => new Date().toISOString();

export function seedState(): ConferenceState {
  const t = now();
  return {
    dataVersion: 2,
    consoleId: 'A',
    opSeq: 0,
    online: true,
    rooms: [
      { id: 'hall-a', name: 'A厅 · 全体会议', topic: '全球气候融资', simultaneousChannels: 6 },
      { id: 'hall-b', name: 'B厅 · 技术分会', topic: '人工智能基础设施', simultaneousChannels: 4 }
    ],
    activeRoomId: 'hall-a',
    speechQueue: [
      { id: 'speech-1', roomId: 'hall-a', seq: 1, speaker: 'Amina Diallo', delegation: '塞内加尔', language: '英语', topic: '适应性融资缺口', plannedSeconds: 600, remainingSeconds: 214, status: 'speaking', version: 1, updatedAt: t },
      { id: 'speech-2', roomId: 'hall-a', seq: 2, speaker: '李明远', delegation: '中国', language: '中文', topic: '绿色基础设施机制', plannedSeconds: 600, remainingSeconds: 600, status: 'queued', version: 1, updatedAt: t },
      { id: 'speech-3', roomId: 'hall-b', seq: 1, speaker: 'Maria Silva', delegation: '巴西', language: '葡萄牙语', topic: '边缘算力与能源', plannedSeconds: 420, remainingSeconds: 420, status: 'queued', version: 1, updatedAt: t }
    ],
    channels: [
      { id: 'ch-a-zh', roomId: 'hall-a', language: '中文', interpreter: '周雨', status: 'active', health: 96 },
      { id: 'ch-a-es', roomId: 'hall-a', language: '西班牙语', interpreter: 'Lucía M.', status: 'active', health: 91 },
      { id: 'ch-a-fr', roomId: 'hall-a', language: '法语', interpreter: 'Noah B.', status: 'standby', health: 88 },
      { id: 'ch-b-zh', roomId: 'hall-b', language: '中文', interpreter: '何佳', status: 'active', health: 94 }
    ],
    terms: [
      { id: 'term-1', phrase: 'loss and damage', translation: '损失与损害', language: '中文', approved: true },
      { id: 'term-2', phrase: 'edge inference', translation: '边缘推理', language: '中文', approved: true },
      { id: 'term-3', phrase: 'just transition', translation: '公正转型', language: '中文', approved: false }
    ],
    captions: [
      { id: 'caption-1', speechId: 'speech-1', roomId: 'hall-a', language: '中文', interpreter: '周雨', text: '我们需要把适应资金与可衡量的社区韧性目标绑定。', revision: 2, at: t }
    ],
    audits: [
      { id: 'audit-1', at: t, roomId: 'hall-a', message: 'Amina Diallo 开始发言，中文频道由周雨接续' },
      { id: 'audit-2', at: new Date(Date.now() - 90000).toISOString(), roomId: 'hall-a', message: '临时插话申请已插入队列第2位' }
    ],
    opLog: [],
    conflicts: [],
    lowLatency: false
  };
}

/** v1 旧数据升级：补发言序号、版本号与空指挥流，升级后可继续打开 */
function migrateLegacy(raw: any): ConferenceState {
  const seed = seedState();
  const byRoom = new Map<string, number>();
  const speechQueue: Speech[] = (raw.speechQueue ?? seed.speechQueue).map((s: any) => {
    const seq = (byRoom.get(s.roomId) ?? 0) + 1;
    byRoom.set(s.roomId, seq);
    return { ...s, seq, version: 1 };
  });
  return {
    ...seed,
    ...raw,
    dataVersion: 2,
    consoleId: 'A',
    opSeq: 0,
    online: true,
    speechQueue,
    channels: (raw.channels ?? seed.channels).map((c: Channel) => ({ ...c, activeBatch: undefined })),
    opLog: [],
    conflicts: [],
    lowLatency: raw.lowLatency ?? false
  };
}

export function loadState(): ConferenceState {
  if (typeof localStorage === 'undefined') return seedState();
  try {
    const v2 = localStorage.getItem(STORAGE_KEY);
    if (v2) {
      const parsed = JSON.parse(v2);
      if (parsed && parsed.dataVersion === 2 && Array.isArray(parsed.opLog)) return parsed as ConferenceState;
    }
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) return migrateLegacy(JSON.parse(legacy));
  } catch { /* 数据损坏时回到种子，保证可继续打开 */ }
  return seedState();
}

export function saveState(state: ConferenceState) {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function readPeerLog(): SyncOp[] {
  if (typeof localStorage === 'undefined') return [];
  try { return JSON.parse(localStorage.getItem(PEER_KEY) ?? '[]') as SyncOp[]; } catch { return []; }
}

/** 生成操作编号并构造一条待同步操作（先记日志，再改状态） */
export function makeOp(state: ConferenceState, partial: Omit<SyncOp, 'opId' | 'consoleId' | 'at' | 'status'>): SyncOp {
  state.opSeq += 1;
  const op: SyncOp = {
    opId: `${state.consoleId}-${String(state.opSeq).padStart(4, '0')}`,
    consoleId: state.consoleId,
    at: now(),
    status: state.online ? 'synced' : 'pending',
    ...partial
  };
  state.opLog.push(op);
  return op;
}

export function describeOp(op: SyncOp): string {
  switch (op.type) {
    case 'speech-add': return `新增发言 #${op.speechSeq} ${op.speech?.speaker ?? ''}`;
    case 'speech-status': return `发言 #${op.speechSeq} 状态 → ${op.to}`;
    case 'handoff-start': return `频道 ${op.channelId} 交接开始（批次 ${op.handoffBatch}）`;
    case 'handoff-complete': return `频道 ${op.channelId} 交接完成（批次 ${op.handoffBatch}）`;
    case 'caption-revise': return `字幕 v${op.baseCaptionRevision} 修订：${(op.text ?? '').slice(0, 14)}`;
  }
}

function audit(state: ConferenceState, roomId: string, message: string) {
  state.audits.unshift({ id: crypto.randomUUID(), at: now(), roomId, message });
}

/** 本地乐观应用：发言状态更新（版本 +1，同厅其他发言中→ done） */
export function applySpeechStatusLocal(state: ConferenceState, op: SyncOp) {
  const speech = state.speechQueue.find((s) => s.id === op.speechId && s.roomId === op.roomId);
  if (!speech || !op.to) return;
  speech.status = op.to;
  speech.version += 1;
  speech.updatedAt = op.at;
  if (op.to === 'speaking') {
    state.speechQueue = state.speechQueue.map((s) =>
      s.id !== speech.id && s.roomId === op.roomId && s.status === 'speaking'
        ? { ...s, status: 'done' as SpeechStatus, version: s.version + 1, updatedAt: op.at }
        : s
    );
  }
}

/** 本地乐观应用：字幕修订（按发言+语言对齐，修订号 +1） */
export function applyCaptionLocal(state: ConferenceState, op: SyncOp) {
  const speech = state.speechQueue.find((s) => s.id === op.speechId);
  if (!speech || !op.text) return;
  const channel = state.channels.find((c) => c.roomId === speech.roomId && c.language === op.language);
  if (!channel) return;
  const existing = state.captions.find((c) => c.speechId === op.speechId && c.language === op.language);
  if (existing) {
    existing.text = op.text;
    existing.revision += 1;
    existing.interpreter = channel.interpreter;
    existing.at = op.at;
  } else {
    state.captions.unshift({
      id: crypto.randomUUID(), speechId: op.speechId!, roomId: speech.roomId,
      language: op.language!, interpreter: channel.interpreter, text: op.text, revision: 1, at: op.at
    });
  }
}

/** 本地乐观应用：交接开始/完成（按交接批次对齐） */
export function applyHandoffLocal(state: ConferenceState, op: SyncOp) {
  const channel = state.channels.find((c) => c.id === op.channelId && c.roomId === op.roomId);
  if (!channel) return;
  if (op.type === 'handoff-start') {
    channel.status = 'handoff';
    channel.activeBatch = op.handoffBatch;
  } else if (op.type === 'handoff-complete' && channel.activeBatch === op.handoffBatch) {
    channel.status = 'active';
    channel.interpreter = op.interpreter ?? channel.interpreter;
    channel.health = Math.min(100, channel.health + 2);
    channel.activeBatch = undefined;
  }
}

export function applySpeechAddLocal(state: ConferenceState, op: SyncOp) {
  if (!op.speech) return;
  if (state.speechQueue.some((s) => s.roomId === op.roomId && s.seq === op.speechSeq)) return;
  state.speechQueue.push({
    id: op.speechId ?? crypto.randomUUID(),
    roomId: op.roomId,
    seq: op.speechSeq!,
    speaker: op.speech.speaker,
    delegation: op.speech.delegation,
    language: op.speech.language,
    topic: op.speech.topic,
    plannedSeconds: op.speech.plannedSeconds,
    remainingSeconds: op.speech.plannedSeconds,
    status: 'queued',
    version: 1,
    updatedAt: op.at
  });
}

interface MergeResult { applied: number; superseded: number; conflicts: number; skipped: number; }

/** 合并对端待同步操作：只处理本厅；按关联键对齐；旧版失效；冲突两边保留并列差异 */
export function mergeRemoteOps(state: ConferenceState, remote: SyncOp[]): MergeResult {
  const result: MergeResult = { applied: 0, superseded: 0, conflicts: 0, skipped: 0 };
  for (const op of remote) {
    if (state.opLog.some((o) => o.opId === op.opId)) { result.skipped += 1; continue; }
    if (op.roomId !== state.activeRoomId) { result.skipped += 1; continue; } // 切换会议厅只处理本厅
    state.opLog.push(op);
    applyRemoteOp(state, op, result);
  }
  // 本台待同步操作已推送给对端，标记 synced
  for (const o of state.opLog) {
    if (o.consoleId === state.consoleId && o.status === 'pending') o.status = 'synced';
  }
  return result;
}

/** 同基并行操作：两边都基于同一版本/修订产生，是冲突而非旧版 */
function findSibling(state: ConferenceState, op: SyncOp): SyncOp | undefined {
  return state.opLog.find((o) =>
    o.opId !== op.opId &&
    o.roomId === op.roomId &&
    (o.status === 'pending' || o.status === 'synced') &&
    ((op.type === 'speech-status' && o.type === 'speech-status' && o.speechSeq === op.speechSeq && o.baseSpeechVersion === op.baseSpeechVersion) ||
      (op.type === 'caption-revise' && o.type === 'caption-revise' && o.speechId === op.speechId && o.language === op.language && o.baseCaptionRevision === op.baseCaptionRevision))
  );
}

function emitConflict(state: ConferenceState, op: SyncOp, rival: SyncOp, kind: ConflictRecord['kind'], result: MergeResult) {
  op.status = 'conflict';
  rival.status = 'conflict';
  result.conflicts += 1;
  state.conflicts.push({
    id: crypto.randomUUID(),
    at: now(),
    roomId: op.roomId,
    kind,
    seq: op.speechSeq,
    speechId: op.speechId,
    language: op.language,
    handoffBatch: op.handoffBatch,
    local: { opId: rival.opId, consoleId: rival.consoleId, summary: describeOp(rival), value: rival.to ?? rival.text ?? rival.handoffBatch ?? '' },
    remote: { opId: op.opId, consoleId: op.consoleId, summary: describeOp(op), value: op.to ?? op.text ?? op.handoffBatch ?? '' }
  });
  const target = kind === 'speech-status' ? `发言 #${op.speechSeq} 状态` : kind === 'caption-revise' ? `字幕 ${op.language} 修订` : `频道 ${op.channelId} 交接批次`;
  audit(state, op.roomId, `${target}冲突：${rival.consoleId}（${rival.opId}）与 ${op.consoleId}（${op.opId}）基于同一版本提交不同内容，两边保留并列出差异`);
}

function applyRemoteOp(state: ConferenceState, op: SyncOp, result: MergeResult) {
  switch (op.type) {
    case 'speech-add': {
      if (state.speechQueue.some((s) => s.roomId === op.roomId && s.seq === op.speechSeq)) { op.status = 'synced'; result.skipped += 1; return; }
      applySpeechAddLocal(state, op);
      op.status = 'synced';
      result.applied += 1;
      return;
    }
    case 'speech-status': {
      const speech = state.speechQueue.find((s) => s.roomId === op.roomId && s.seq === op.speechSeq);
      if (!speech) {
        op.status = 'superseded'; result.superseded += 1;
        audit(state, op.roomId, `操作 ${op.opId} 引用的发言 #${op.speechSeq} 不存在，已失效`);
        return;
      }
      if (speech.version === op.baseSpeechVersion) {
        // 版本未前进：正常应用
        applySpeechStatusLocal(state, op);
        op.status = 'synced';
        result.applied += 1;
        return;
      }
      // 版本已前进：同基并行 → 冲突；否则旧版失效
      const sibling = findSibling(state, op);
      if (sibling) {
        if (sibling.to !== op.to) { emitConflict(state, op, sibling, 'speech-status', result); return; }
        op.status = 'synced'; result.skipped += 1; return; // 同基同值，幂等
      }
      op.status = 'superseded'; result.superseded += 1;
      audit(state, op.roomId, `发言 #${speech.seq} 已更新至 v${speech.version}（操作 ${op.opId} 基于 v${op.baseSpeechVersion}），旧版合并操作失效`);
      return;
    }
    case 'caption-revise': {
      const caption = state.captions.find((c) => c.speechId === op.speechId && c.language === op.language && c.roomId === op.roomId);
      const baseRev = caption?.revision ?? 0;
      if (baseRev === op.baseCaptionRevision) {
        applyCaptionLocal(state, op);
        op.status = 'synced';
        result.applied += 1;
        return;
      }
      const sibling = findSibling(state, op);
      if (sibling) {
        if (sibling.text !== op.text) { emitConflict(state, op, sibling, 'caption-revise', result); return; }
        op.status = 'synced'; result.skipped += 1; return; // 同基同值，幂等
      }
      op.status = 'superseded'; result.superseded += 1;
      audit(state, op.roomId, `字幕 ${op.language} 已修订至 v${baseRev}（操作 ${op.opId} 基于 v${op.baseCaptionRevision}），旧版合并操作失效`);
      return;
    }
    case 'handoff-start': {
      const channel = state.channels.find((c) => c.id === op.channelId && c.roomId === op.roomId);
      if (!channel) {
        op.status = 'superseded'; result.superseded += 1;
        audit(state, op.roomId, `操作 ${op.opId} 引用的频道不存在，已失效`);
        return;
      }
      if (channel.activeBatch === op.handoffBatch) { op.status = 'synced'; result.skipped += 1; return; } // 同批次幂等
      if (channel.activeBatch) {
        const rival = state.opLog.find((o) => o.type === 'handoff-start' && o.channelId === op.channelId && o.handoffBatch === channel.activeBatch) ?? op;
        emitConflict(state, op, rival, 'handoff-batch', result);
        return;
      }
      channel.status = 'handoff';
      channel.activeBatch = op.handoffBatch;
      op.status = 'synced';
      result.applied += 1;
      return;
    }
    case 'handoff-complete': {
      const channel = state.channels.find((c) => c.id === op.channelId && c.roomId === op.roomId);
      if (!channel || channel.activeBatch !== op.handoffBatch) {
        op.status = 'superseded'; result.superseded += 1;
        audit(state, op.roomId, `频道 ${op.channelId} 交接批次不匹配（当前批次 ${channel?.activeBatch ?? '无'}），操作 ${op.opId} 已失效`);
        return;
      }
      applyHandoffLocal(state, op);
      op.status = 'synced';
      result.applied += 1;
      return;
    }
  }
}

/** 冲突裁决：采用本地或远端版本，另一端操作标记失效 */
export function resolveConflict(state: ConferenceState, conflictId: string, side: 'local' | 'remote') {
  const c = state.conflicts.find((x) => x.id === conflictId);
  if (!c || c.resolution) return;
  c.resolution = side;
  const chosen = side === 'local' ? c.local : c.remote;
  const other = side === 'local' ? c.remote : c.local;
  const chosenOp = state.opLog.find((o) => o.opId === chosen.opId);
  const otherOp = state.opLog.find((o) => o.opId === other.opId);
  if (c.kind === 'speech-status' && chosenOp?.to) {
    const speech = state.speechQueue.find((s) => s.roomId === c.roomId && s.seq === c.seq);
    if (speech) {
      speech.status = chosenOp.to;
      speech.version += 1;
      speech.updatedAt = now();
    }
  } else if (c.kind === 'caption-revise' && chosenOp?.text) {
    const caption = state.captions.find((cap) => cap.speechId === c.speechId && cap.language === c.language && cap.roomId === c.roomId);
    if (caption) {
      caption.text = chosenOp.text;
      caption.revision += 1;
      caption.at = now();
    }
  } else if (c.kind === 'handoff-batch' && chosenOp?.type === 'handoff-start') {
    const channel = state.channels.find((ch) => ch.id === chosenOp.channelId && ch.roomId === c.roomId);
    if (channel) {
      channel.status = 'handoff';
      channel.activeBatch = chosenOp.handoffBatch;
    }
  }
  if (chosenOp) chosenOp.status = 'synced';
  if (otherOp) otherOp.status = 'superseded';
  audit(state, c.roomId, `冲突已裁决（采用${side === 'local' ? '本台' : '对端'} ${chosen.opId}）：${c.local.summary} ⇄ ${c.remote.summary}`);
}

/** 模拟对端操作台在断网期间基于同一版本产生并行操作，写入独立存储 key */
export function simulatePeerActivity(state: ConferenceState): number {
  const peerLog = readPeerLog();
  const roomId = state.activeRoomId;
  const base = {
    opId: `B-${String(peerLog.length + 1).padStart(4, '0')}`,
    consoleId: 'B',
    roomId,
    at: now(),
    status: 'pending' as const
  };
  const ops: SyncOp[] = [];
  const roll = Math.random();
  const current = state.speechQueue.find((s) => s.roomId === roomId && s.status === 'speaking');
  if (current && roll < 0.45) {
    const caption = state.captions.find((c) => c.speechId === current.id && c.language === '中文');
    ops.push({
      ...base,
      type: 'caption-revise',
      speechId: current.id,
      language: '中文',
      text: `（对端并行修订）${caption?.text ?? '同传草稿'}`,
      baseCaptionRevision: caption?.revision ?? 0
    });
  } else {
    const queued = state.speechQueue.find((s) => s.roomId === roomId && s.status === 'queued');
    if (queued && roll < 0.8) {
      ops.push({
        ...base,
        type: 'speech-status',
        speechSeq: queued.seq,
        speechId: queued.id,
        to: 'speaking',
        baseSpeechVersion: queued.version
      });
    } else {
      const channel = state.channels.find((ch) => ch.roomId === roomId && ch.status !== 'handoff');
      if (channel) {
        ops.push({ ...base, type: 'handoff-start', channelId: channel.id, handoffBatch: `batch-B-${Date.now()}` });
      }
    }
  }
  if (ops.length) localStorage.setItem(PEER_KEY, JSON.stringify([...peerLog, ...ops]));
  return ops.length;
}
