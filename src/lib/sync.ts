/* ------------------------------------------------------------------ */
/* 可恢复指挥流：待同步操作模型与合并引擎（无框架依赖，可独立测试）        */
/* ------------------------------------------------------------------ */

export type SpeechStatus = 'queued' | 'speaking' | 'done' | 'skipped';
export type InterpreterStatus = 'active' | 'handoff' | 'standby';
export type ConsoleId = 'console-1' | 'console-2';

export type Room = { id: string; name: string; topic: string; simultaneousChannels: number };
export type Speech = {
  id: string;
  roomId: string;
  /** 厅内发言序号：合并时按它与对端操作对应 */
  seq: number;
  speaker: string;
  delegation: string;
  language: string;
  topic: string;
  plannedSeconds: number;
  remainingSeconds: number;
  status: SpeechStatus;
  /** 发言状态版本：基于旧版本的合并操作一律判定失效 */
  statusVersion: number;
  updatedAt: string;
};
export type Channel = {
  id: string;
  roomId: string;
  language: string;
  interpreter: string;
  status: InterpreterStatus;
  health: number;
  handoffVersion: number;
  openHandoffBatch: string | null;
};
export type Term = { id: string; phrase: string; translation: string; language: string; approved: boolean };
export type Caption = {
  id: string;
  speechId: string;
  roomId: string;
  language: string;
  interpreter: string;
  /** 提交时快照的交接批次，重放不会改挂新译员 */
  handoffBatch: string | null;
  text: string;
  revision: number;
  baseRevision: number;
  forked: boolean;
  forkWinner: boolean;
  at: string;
};
export type Audit = { id: string; at: string; roomId: string; message: string };

type OpBase = { id: string; console: ConsoleId; roomId: string; at: string };
export type SpeechEnqueueOp = OpBase & {
  type: 'speech-enqueue';
  speechId: string;
  seq: number;
  speaker: string;
  delegation: string;
  language: string;
  topic: string;
  plannedSeconds: number;
};
export type SpeechStatusOp = OpBase & {
  type: 'speech-status';
  speechId: string;
  speechSeq: number;
  baseStatusVersion: number;
  status: SpeechStatus;
};
export type TimeAdjustOp = OpBase & {
  type: 'time-adjust';
  speechId: string;
  speechSeq: number;
  baseStatusVersion: number;
  remainingSeconds: number;
};
export type HandoffStartOp = OpBase & {
  type: 'handoff-start';
  channelId: string;
  baseHandoffVersion: number;
  batchId: string;
};
export type HandoffCompleteOp = OpBase & {
  type: 'handoff-complete';
  channelId: string;
  baseHandoffVersion: number;
  batchId: string;
  interpreter: string;
};
export type CaptionReviseOp = OpBase & {
  type: 'caption-revise';
  speechId: string;
  speechSeq: number;
  language: string;
  handoffBatch: string | null;
  interpreter: string;
  baseRevision: number;
  revision: number;
  text: string;
};
export type PendingOp =
  | SpeechEnqueueOp
  | SpeechStatusOp
  | TimeAdjustOp
  | HandoffStartOp
  | HandoffCompleteOp
  | CaptionReviseOp;

export type MergeConflict =
  | {
      id: string;
      roomId: string;
      kind: 'speech-status';
      at: string;
      resolved: boolean;
      speechSeq: number;
      speechId: string;
      localOpId: string;
      peerOpId: string;
      localStatus: SpeechStatus;
      peerStatus: SpeechStatus;
      baseStatusVersion: number;
    }
  | {
      id: string;
      roomId: string;
      kind: 'caption';
      at: string;
      resolved: boolean;
      speechSeq: number;
      speechId: string;
      language: string;
      localOpId: string;
      peerOpId: string;
      localInterpreter: string;
      peerInterpreter: string;
      localText: string;
      peerText: string;
      lineLabel: string;
    }
  | {
      id: string;
      roomId: string;
      kind: 'handoff';
      at: string;
      resolved: boolean;
      channelId: string;
      localOpId: string;
      peerOpId: string;
      localInterpreter: string;
      peerInterpreter: string;
    }
  | {
      id: string;
      roomId: string;
      kind: 'caption-orphan';
      at: string;
      resolved: boolean;
      speechSeq: number;
      language: string;
      peerOpId: string;
      peerInterpreter: string;
      peerText: string;
    };

export interface ConferenceState {
  schemaVersion: 2;
  rooms: Room[];
  activeConsole: ConsoleId;
  perConsoleActiveRoom: Record<ConsoleId, string>;
  speechQueue: Speech[];
  channels: Channel[];
  terms: Term[];
  captions: Caption[];
  audits: Audit[];
  lowLatency: boolean;
  online: Record<ConsoleId, boolean>;
  /** 本台待同步操作（断网期间乐观执行，重开浏览器仍在） */
  outboxes: Record<ConsoleId, PendingOp[]>;
  /** 对端推过来、尚未合并的操作 */
  peerOutboxes: Record<ConsoleId, PendingOp[]>;
  conflicts: MergeConflict[];
  /** 已应用的操作编号，保证幂等 */
  appliedOpIds: string[];
}

export const STATUS_LABEL: Record<SpeechStatus, string> = {
  queued: '排队',
  speaking: '发言中',
  done: '完成',
  skipped: '跳过'
};
const STATUS_RANK: Record<SpeechStatus, number> = { queued: 0, speaking: 1, done: 2, skipped: 2 };

export const nextSeq = (state: ConferenceState, roomId: string) =>
  state.speechQueue.filter((s) => s.roomId === roomId).reduce((max, s) => Math.max(max, s.seq), 0) + 1;
export const nextHandoffBatch = (channel: Channel) => `batch-${channel.id}-${channel.handoffVersion + 1}`;

export function pushAudit(state: ConferenceState, roomId: string, message: string, at = new Date().toISOString()) {
  state.audits.unshift({ id: `audit-${Math.random().toString(36).slice(2)}-${state.audits.length}`, at, roomId, message });
}

/* ---------------------------- 状态变更 ---------------------------- */

export function mutateSpeechStatus(state: ConferenceState, op: SpeechStatusOp) {
  const target = state.speechQueue.find((s) => s.id === op.speechId);
  if (!target) return;
  target.status = op.status;
  target.statusVersion += 1;
  target.updatedAt = op.at;
  if (op.status === 'speaking') {
    for (const s of state.speechQueue) {
      if (s.id !== target.id && s.roomId === target.roomId && s.status === 'speaking') {
        s.status = 'done';
        s.statusVersion += 1;
        s.updatedAt = op.at;
      }
    }
  }
}

export function mutateTimeAdjust(state: ConferenceState, op: TimeAdjustOp) {
  const target = state.speechQueue.find((s) => s.id === op.speechId);
  if (!target) return;
  target.remainingSeconds = op.remainingSeconds;
  target.statusVersion += 1;
  target.updatedAt = op.at;
}

export function mutateHandoffStart(state: ConferenceState, op: HandoffStartOp) {
  const channel = state.channels.find((c) => c.id === op.channelId);
  if (!channel) return;
  channel.status = 'handoff';
  channel.handoffVersion += 1;
  channel.openHandoffBatch = op.batchId;
}

export function mutateHandoffComplete(state: ConferenceState, op: HandoffCompleteOp) {
  const channel = state.channels.find((c) => c.id === op.channelId);
  if (!channel) return;
  channel.interpreter = op.interpreter;
  channel.status = 'active';
  channel.health = Math.min(100, channel.health + 2);
  channel.handoffVersion += 1;
  channel.openHandoffBatch = null;
}

export function mutateEnqueue(state: ConferenceState, op: SpeechEnqueueOp) {
  if (state.speechQueue.some((s) => s.id === op.speechId)) return;
  let seq = op.seq;
  if (state.speechQueue.some((s) => s.roomId === op.roomId && s.seq === seq)) {
    seq = nextSeq(state, op.roomId);
    pushAudit(state, op.roomId, `序号冲突：对端「${op.speaker}」原申请第 ${op.seq} 位，顺延为第 ${seq} 位`, op.at);
  }
  state.speechQueue.push({
    id: op.speechId,
    roomId: op.roomId,
    seq,
    speaker: op.speaker,
    delegation: op.delegation,
    language: op.language,
    topic: op.topic,
    plannedSeconds: op.plannedSeconds,
    remainingSeconds: op.plannedSeconds,
    status: 'queued',
    statusVersion: 1,
    updatedAt: op.at
  });
}

export function mutateCaption(state: ConferenceState, op: CaptionReviseOp, forceFork: boolean): Caption | null {
  const speech = state.speechQueue.find((s) => s.id === op.speechId);
  if (!speech) return null;
  const head = state.captions.find((c) => c.speechId === op.speechId && c.language === op.language && !c.forked);
  if (head && !forceFork && head.revision === op.baseRevision) {
    head.text = op.text;
    head.revision = op.revision;
    head.interpreter = op.interpreter;
    head.handoffBatch = op.handoffBatch;
    head.at = op.at;
    return head;
  }
  if (!head && !forceFork) {
    const caption: Caption = {
      id: `caption-${op.id}`,
      speechId: op.speechId,
      roomId: op.roomId,
      language: op.language,
      interpreter: op.interpreter,
      handoffBatch: op.handoffBatch,
      text: op.text,
      revision: op.revision,
      baseRevision: op.baseRevision,
      forked: op.baseRevision > 0,
      forkWinner: false,
      at: op.at
    };
    state.captions.unshift(caption);
    return caption;
  }
  if (head) {
    const fork: Caption = {
      id: `caption-${op.id}`,
      speechId: op.speechId,
      roomId: op.roomId,
      language: op.language,
      interpreter: op.interpreter,
      handoffBatch: op.handoffBatch,
      text: op.text,
      revision: op.revision,
      baseRevision: op.baseRevision,
      forked: true,
      forkWinner: false,
      at: op.at
    };
    state.captions.push(fork);
    return fork;
  }
  return null;
}

/* ---------------------------- 合并引擎 ---------------------------- */

const latestBy = <T extends PendingOp>(ops: T[], keyOf: (op: T) => string) => {
  const map = new Map<string, T>();
  for (const op of [...ops].sort((a, b) => a.at.localeCompare(b.at))) map.set(keyOf(op), op);
  return map;
};

function addConflictOnce(state: ConferenceState, conflict: MergeConflict) {
  const signature = `${conflict.kind}:${conflict.roomId}:${'localOpId' in conflict ? conflict.localOpId : ''}:${conflict.peerOpId}`;
  const dup = state.conflicts.some(
    (c) => !c.resolved && `${c.kind}:${c.roomId}:${'localOpId' in c ? c.localOpId : ''}:${c.peerOpId}` === signature
  );
  if (!dup) state.conflicts.unshift(conflict);
}

/**
 * 合并当前操作台与对端在 roomId 内的待同步操作。
 * 仅处理本厅；其它厅的待同步操作原样保留。
 *  - 基于旧发言状态版本的操作失效，不允许把已完成发言改回排队；
 *  - 同基版本分叉（状态/字幕/交接）两边保留并列差异；
 *  - 字幕按发言序号+语言+修订号、交接批次对应，挂不上发言则隔离。
 */
export function syncRoom(state: ConferenceState, roomId: string) {
  const me = state.activeConsole;
  const applied = new Set(state.appliedOpIds);
  const inRoom = (op: PendingOp) => op.roomId === roomId;
  const local = state.outboxes[me].filter(inRoom).filter((op) => !applied.has(op.id));
  const peer = state.peerOutboxes[me].filter(inRoom).filter((op) => !applied.has(op.id));
  if (local.length === 0 && peer.length === 0) return;

  const localStatus = latestBy(local.filter((o): o is SpeechStatusOp => o.type === 'speech-status'), (o) => o.speechId);
  const peerStatus = latestBy(peer.filter((o): o is SpeechStatusOp => o.type === 'speech-status'), (o) => o.speechId);
  const localCaptions = latestBy(local.filter((o): o is CaptionReviseOp => o.type === 'caption-revise'), (o) => `${o.speechId}|${o.language}`);
  const peerCaptions = latestBy(peer.filter((o): o is CaptionReviseOp => o.type === 'caption-revise'), (o) => `${o.speechId}|${o.language}`);
  const localHandoff = latestBy(local.filter((o): o is HandoffCompleteOp => o.type === 'handoff-complete'), (o) => o.channelId);
  const peerHandoff = latestBy(peer.filter((o): o is HandoffCompleteOp => o.type === 'handoff-complete'), (o) => o.channelId);

  const conflictOpIds = new Set<string>();
  const registerConflict = (opIds: string[]) => opIds.forEach((id) => conflictOpIds.add(id));

  for (const [speechId, p] of peerStatus) {
    const l = localStatus.get(speechId);
    if (!l || l.baseStatusVersion !== p.baseStatusVersion || l.status === p.status) continue;
    // 本台操作已乐观落到实体（版本已前进）：对端同基操作属旧版，重放时判失效，
    // 不允许把已完成发言改回排队；只有双方都还没落地时才算分叉冲突。
    const current = state.speechQueue.find((s) => s.id === speechId);
    if (current && current.statusVersion > l.baseStatusVersion) continue;
    registerConflict([l.id, p.id]);
    addConflictOnce(state, {
      id: `conflict-${Math.random().toString(36).slice(2)}`,
      roomId,
      kind: 'speech-status',
      at: new Date().toISOString(),
      resolved: false,
      speechSeq: p.speechSeq,
      speechId,
      localOpId: l.id,
      peerOpId: p.id,
      localStatus: l.status,
      peerStatus: p.status,
      baseStatusVersion: p.baseStatusVersion
    });
  }
  for (const [key, p] of peerCaptions) {
    const l = localCaptions.get(key);
    if (l && l.baseRevision === p.baseRevision && l.text !== p.text) {
      registerConflict([l.id, p.id]);
      addConflictOnce(state, {
        id: `conflict-${Math.random().toString(36).slice(2)}`,
        roomId,
        kind: 'caption',
        at: new Date().toISOString(),
        resolved: false,
        speechSeq: p.speechSeq,
        speechId: p.speechId,
        language: p.language,
        localOpId: l.id,
        peerOpId: p.id,
        localInterpreter: l.interpreter,
        peerInterpreter: p.interpreter,
        localText: l.text,
        peerText: p.text,
        lineLabel: `同基于 v${p.baseRevision} 的分叉修订`
      });
    }
  }
  for (const [channelId, p] of peerHandoff) {
    const l = localHandoff.get(channelId);
    if (l && l.batchId === p.batchId && l.interpreter !== p.interpreter) {
      registerConflict([l.id, p.id]);
      addConflictOnce(state, {
        id: `conflict-${Math.random().toString(36).slice(2)}`,
        roomId,
        kind: 'handoff',
        at: new Date().toISOString(),
        resolved: false,
        channelId,
        localOpId: l.id,
        peerOpId: p.id,
        localInterpreter: l.interpreter,
        peerInterpreter: p.interpreter
      });
    }
  }

  const appliedNow = new Set<string>();
  const invalidNow = new Set<string>();
  const markApplied = (id: string) => {
    appliedNow.add(id);
    applied.add(id);
  };

  for (const op of [...peer].sort((a, b) => a.at.localeCompare(b.at))) {
    if (conflictOpIds.has(op.id)) continue;
    switch (op.type) {
      case 'speech-enqueue': {
        if (!state.speechQueue.some((s) => s.id === op.speechId)) {
          mutateEnqueue(state, op);
          pushAudit(state, roomId, `合并对端入队：#${op.seq} ${op.speaker}`, op.at);
        }
        markApplied(op.id);
        break;
      }
      case 'speech-status': {
        const speech = state.speechQueue.find((s) => s.id === op.speechId);
        const l = localStatus.get(op.speechId);
        if (!speech) {
          invalidNow.add(op.id);
          pushAudit(state, roomId, `对端状态操作失效：第 ${op.speechSeq} 条发言已不存在`, op.at);
          break;
        }
        if (l) {
          if (l.baseStatusVersion >= op.baseStatusVersion) {
            invalidNow.add(op.id);
            pushAudit(
              state,
              roomId,
              `对端旧版状态操作失效（第 ${op.speechSeq} 条，目标「${STATUS_LABEL[op.status]}」），本台保留版本 v${speech.statusVersion}`,
              op.at
            );
          } else {
            mutateSpeechStatus(state, op);
            pushAudit(state, roomId, `对端较新版本生效：第 ${op.speechSeq} 条 → ${STATUS_LABEL[op.status]}`, op.at);
            markApplied(op.id);
          }
          break;
        }
        if (op.baseStatusVersion === speech.statusVersion) {
          mutateSpeechStatus(state, op);
          pushAudit(state, roomId, `对端操作生效：第 ${op.speechSeq} 条 → ${STATUS_LABEL[op.status]}`, op.at);
          markApplied(op.id);
        } else {
          invalidNow.add(op.id);
          const backward = STATUS_RANK[op.status] < STATUS_RANK[speech.status];
          pushAudit(
            state,
            roomId,
            `旧版合并操作失效：第 ${op.speechSeq} 条基于 v${op.baseStatusVersion}，当前 v${speech.statusVersion}（${backward ? `防止回退为「${STATUS_LABEL[op.status]}」` : '已被新版覆盖'}）`,
            op.at
          );
        }
        break;
      }
      case 'time-adjust': {
        const speech = state.speechQueue.find((s) => s.id === op.speechId);
        if (speech && op.baseStatusVersion === speech.statusVersion) {
          mutateTimeAdjust(state, op);
          markApplied(op.id);
        } else {
          invalidNow.add(op.id);
          pushAudit(state, roomId, `对端计时调整失效：第 ${op.speechSeq} 条已有更新版本`, op.at);
        }
        break;
      }
      case 'handoff-start': {
        const channel = state.channels.find((c) => c.id === op.channelId);
        if (channel && op.baseHandoffVersion === channel.handoffVersion) {
          mutateHandoffStart(state, op);
          pushAudit(state, roomId, `对端启动交接批次 ${op.batchId}`, op.at);
          markApplied(op.id);
        } else if (channel) {
          invalidNow.add(op.id);
          pushAudit(state, roomId, `对端交接启动失效：频道已有更新交接（v${channel.handoffVersion}）`, op.at);
        }
        break;
      }
      case 'handoff-complete': {
        const channel = state.channels.find((c) => c.id === op.channelId);
        if (!channel) break;
        if (op.baseHandoffVersion === channel.handoffVersion && channel.openHandoffBatch === op.batchId) {
          mutateHandoffComplete(state, op);
          pushAudit(state, roomId, `对端完成交接：${op.interpreter} 接续 ${channel.language} 频道`, op.at);
          markApplied(op.id);
        } else {
          invalidNow.add(op.id);
          pushAudit(state, roomId, `对端交接完成失效：批次 ${op.batchId} 已关闭或被新版取代`, op.at);
        }
        break;
      }
      case 'caption-revise': {
        const speech = state.speechQueue.find((s) => s.id === op.speechId);
        if (!speech) {
          addConflictOnce(state, {
            id: `conflict-${Math.random().toString(36).slice(2)}`,
            roomId,
            kind: 'caption-orphan',
            at: new Date().toISOString(),
            resolved: false,
            speechSeq: op.speechSeq,
            language: op.language,
            peerOpId: op.id,
            peerInterpreter: op.interpreter,
            peerText: op.text
          });
          conflictOpIds.add(op.id);
          pushAudit(state, roomId, `对端字幕挂空：第 ${op.speechSeq} 条发言不在本厅队列，已隔离待裁定`, op.at);
          break;
        }
        const head = state.captions.find((c) => c.speechId === op.speechId && c.language === op.language && !c.forked);
        const l = localCaptions.get(`${op.speechId}|${op.language}`);
        if (l && l.baseRevision > op.baseRevision) {
          if (l.text === op.text) {
            invalidNow.add(op.id);
          } else {
            mutateCaption(state, op, true);
            addConflictOnce(state, {
              id: `conflict-${Math.random().toString(36).slice(2)}`,
              roomId,
              kind: 'caption',
              at: new Date().toISOString(),
              resolved: false,
              speechSeq: op.speechSeq,
              speechId: op.speechId,
              language: op.language,
              localOpId: l.id,
              peerOpId: op.id,
              localInterpreter: l.interpreter,
              peerInterpreter: op.interpreter,
              localText: l.text,
              peerText: op.text,
              lineLabel: `修订链分叉：本台 v${l.revision} / 对端 v${op.revision}`
            });
            conflictOpIds.add(op.id);
            pushAudit(state, roomId, `字幕修订分叉：第 ${op.speechSeq} 条 ${op.language}，两版均已保留`, op.at);
          }
          break;
        }
        if (!head) {
          mutateCaption(state, op, false);
          pushAudit(state, roomId, `对端字幕合并：第 ${op.speechSeq} 条 ${op.language} v${op.revision}`, op.at);
          markApplied(op.id);
        } else if (head.revision === op.baseRevision) {
          mutateCaption(state, op, false);
          pushAudit(state, roomId, `对端字幕快进合并：第 ${op.speechSeq} 条 ${op.language} → v${op.revision}`, op.at);
          markApplied(op.id);
        } else if (head.revision > op.baseRevision) {
          if (head.text === op.text) {
            invalidNow.add(op.id);
            pushAudit(state, roomId, `对端旧版字幕失效：第 ${op.speechSeq} 条 ${op.language} 内容与现行版本一致`, op.at);
          } else {
            mutateCaption(state, op, true);
            addConflictOnce(state, {
              id: `conflict-${Math.random().toString(36).slice(2)}`,
              roomId,
              kind: 'caption',
              at: new Date().toISOString(),
              resolved: false,
              speechSeq: op.speechSeq,
              speechId: op.speechId,
              language: op.language,
              localOpId: `head-v${head.revision}`,
              peerOpId: op.id,
              localInterpreter: head.interpreter,
              peerInterpreter: op.interpreter,
              localText: head.text,
              peerText: op.text,
              lineLabel: `对端基于旧版 v${op.baseRevision}，本台现行 v${head.revision}`
            });
            conflictOpIds.add(op.id);
            pushAudit(state, roomId, `字幕分叉保留：对端 v${op.revision} 基于旧版 v${op.baseRevision}，未覆盖本台 v${head.revision}`, op.at);
          }
        } else {
          mutateCaption(state, op, false);
          markApplied(op.id);
        }
        break;
      }
    }
  }

  for (const op of local) {
    if (conflictOpIds.has(op.id)) {
      pushAudit(state, roomId, `本台操作与对端冲突，已两边保留待裁定：${opSummary(op)}`, op.at);
    } else {
      markApplied(op.id);
    }
  }
  for (const id of invalidNow) applied.add(id);

  const consumed = new Set<string>([...appliedNow, ...invalidNow, ...conflictOpIds]);
  state.outboxes[me] = state.outboxes[me].filter((op) => !(op.roomId === roomId && consumed.has(op.id)));
  state.peerOutboxes[me] = state.peerOutboxes[me].filter((op) => !(op.roomId === roomId && consumed.has(op.id)));

  state.appliedOpIds = [...applied].slice(-800);
  if (conflictOpIds.size > 0) {
    pushAudit(state, roomId, `本厅合并完成：${conflictOpIds.size} 项冲突两边保留并列差异，请在冲突清单裁定`);
  } else {
    pushAudit(state, roomId, `本厅待同步操作已全部合并，无冲突`);
  }
}

/* ----------------------- 操作摘要与字符级差异 ----------------------- */

export function opSummary(op: PendingOp): string {
  switch (op.type) {
    case 'speech-enqueue':
      return `入队申请 #${op.seq} ${op.speaker}`;
    case 'speech-status':
      return `第 ${op.speechSeq} 条发言 → ${STATUS_LABEL[op.status]}（基于 v${op.baseStatusVersion}）`;
    case 'time-adjust':
      return `第 ${op.speechSeq} 条计时调整为 ${op.remainingSeconds}s`;
    case 'handoff-start':
      return `启动交接批次 ${op.batchId}`;
    case 'handoff-complete':
      return `批次 ${op.batchId} 完成交接 → ${op.interpreter}`;
    case 'caption-revise':
      return `第 ${op.speechSeq} 条 ${op.language}字幕 v${op.baseRevision}→v${op.revision}（${op.interpreter}${op.handoffBatch ? `/${op.handoffBatch}` : ''}）`;
  }
}

export type DiffPart = { text: string; kind: 'same' | 'ins' | 'del' };

/** LCS 字符级差异，用于冲突清单两边对照 */
export function buildTextDiff(a: string, b: string): DiffPart[] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const parts: DiffPart[] = [];
  const flush = (text: string, kind: DiffPart['kind']) => {
    if (!text) return;
    const last = parts[parts.length - 1];
    if (last && last.kind === kind) last.text += text;
    else parts.push({ text, kind });
  };
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      flush(a[i], 'same');
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      flush(a[i], 'del');
      i++;
    } else {
      flush(b[j], 'ins');
      j++;
    }
  }
  flush(a.slice(i), 'del');
  flush(b.slice(j), 'ins');
  return parts;
}

/* ---------------------------- 旧数据升级 ---------------------------- */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function migrate(raw: any, fallbackRooms: Room[]): ConferenceState {
  const speeches: Speech[] = (raw.speechQueue ?? []).map((s: any, _i: number, all: any[]) => ({
    id: String(s.id),
    roomId: String(s.roomId),
    seq: typeof s.seq === 'number' ? s.seq : all.filter((x) => x.roomId === s.roomId).indexOf(s) + 1,
    speaker: String(s.speaker ?? ''),
    delegation: String(s.delegation ?? ''),
    language: String(s.language ?? ''),
    topic: String(s.topic ?? ''),
    plannedSeconds: Number(s.plannedSeconds ?? 300),
    remainingSeconds: Number(s.remainingSeconds ?? s.plannedSeconds ?? 300),
    status: (['queued', 'speaking', 'done', 'skipped'].includes(s.status) ? s.status : 'queued') as SpeechStatus,
    statusVersion: Number(s.statusVersion ?? 1),
    updatedAt: String(s.updatedAt ?? new Date().toISOString())
  }));
  const channels: Channel[] = (raw.channels ?? []).map((c: any) => ({
    id: String(c.id),
    roomId: String(c.roomId),
    language: String(c.language),
    interpreter: String(c.interpreter ?? ''),
    status: (['active', 'handoff', 'standby'].includes(c.status) ? c.status : 'active') as InterpreterStatus,
    health: Number(c.health ?? 90),
    handoffVersion: Number(c.handoffVersion ?? 0),
    openHandoffBatch: typeof c.openHandoffBatch === 'string' ? c.openHandoffBatch : null
  }));
  const captions: Caption[] = (raw.captions ?? []).map((c: any) => ({
    id: String(c.id ?? `caption-${Math.random().toString(36).slice(2)}`),
    speechId: String(c.speechId),
    roomId: String(c.roomId),
    language: String(c.language),
    interpreter: String(c.interpreter ?? ''),
    handoffBatch: typeof c.handoffBatch === 'string' ? c.handoffBatch : null,
    text: String(c.text ?? ''),
    revision: Number(c.revision ?? 1),
    baseRevision: Number(c.baseRevision ?? Math.max(0, Number(c.revision ?? 1) - 1)),
    forked: Boolean(c.forked),
    forkWinner: Boolean(c.forkWinner),
    at: String(c.at ?? new Date().toISOString())
  }));
  const activeConsole: ConsoleId = raw.activeConsole === 'console-2' ? 'console-2' : 'console-1';
  return {
    schemaVersion: 2,
    rooms: raw.rooms ?? fallbackRooms,
    activeConsole,
    perConsoleActiveRoom: {
      'console-1': raw.perConsoleActiveRoom?.['console-1'] ?? raw.activeRoomId ?? 'hall-a',
      'console-2': raw.perConsoleActiveRoom?.['console-2'] ?? raw.activeRoomId ?? 'hall-a'
    },
    speechQueue: speeches,
    channels,
    terms: raw.terms ?? [],
    captions,
    audits: raw.audits ?? [],
    lowLatency: Boolean(raw.lowLatency),
    online: { 'console-1': raw.online?.['console-1'] ?? true, 'console-2': raw.online?.['console-2'] ?? true },
    outboxes: {
      'console-1': Array.isArray(raw.outboxes?.['console-1']) ? raw.outboxes['console-1'] : [],
      'console-2': Array.isArray(raw.outboxes?.['console-2']) ? raw.outboxes['console-2'] : []
    },
    peerOutboxes: {
      'console-1': Array.isArray(raw.peerOutboxes?.['console-1']) ? raw.peerOutboxes['console-1'] : [],
      'console-2': Array.isArray(raw.peerOutboxes?.['console-2']) ? raw.peerOutboxes['console-2'] : []
    },
    conflicts: Array.isArray(raw.conflicts) ? raw.conflicts : [],
    appliedOpIds: Array.isArray(raw.appliedOpIds) ? raw.appliedOpIds : []
  };
}
