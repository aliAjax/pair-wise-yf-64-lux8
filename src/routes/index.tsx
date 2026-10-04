import { $, component$, useSignal, useStore, useVisibleTask$ } from '@builder.io/qwik';
import { Progress } from '@qwik-ui/headless';
import { QueryClient } from '@tanstack/query-core';
import { useForm, zodForm$ } from '@modular-forms/qwik';
import { useSpeakLocale } from 'qwik-speak';
import { z } from 'zod';
import type { DocumentHead } from '@builder.io/qwik-city';
import {
  STATUS_LABEL,
  buildTextDiff,
  migrate,
  mutateCaption,
  mutateEnqueue,
  mutateHandoffComplete,
  mutateHandoffStart,
  mutateSpeechStatus,
  mutateTimeAdjust,
  nextHandoffBatch,
  nextSeq,
  opSummary,
  pushAudit,
  syncRoom
} from '~/lib/sync';
import type {
  CaptionReviseOp,
  Channel,
  ConferenceState,
  ConsoleId,
  HandoffCompleteOp,
  HandoffStartOp,
  MergeConflict,
  PendingOp,
  Room,
  Speech,
  SpeechEnqueueOp,
  SpeechStatus,
  SpeechStatusOp,
  TimeAdjustOp
} from '~/lib/sync';

/* ------------------------------------------------------------------ */
/* 种子数据（旧 v1 结构，启动时迁移到 v2）                               */
/* ------------------------------------------------------------------ */

const now = new Date().toISOString();
const seedRooms: Room[] = [
  { id: 'hall-a', name: 'A厅 · 全体会议', topic: '全球气候融资', simultaneousChannels: 6 },
  { id: 'hall-b', name: 'B厅 · 技术分会', topic: '人工智能基础设施', simultaneousChannels: 4 }
];
const seedV1 = {
  schemaVersion: 1 as const,
  rooms: seedRooms,
  activeRoomId: 'hall-a',
  speechQueue: [
    { id: 'speech-1', roomId: 'hall-a', speaker: 'Amina Diallo', delegation: '塞内加尔', language: '英语', topic: '适应性融资缺口', plannedSeconds: 600, remainingSeconds: 214, status: 'speaking' as SpeechStatus, updatedAt: now },
    { id: 'speech-2', roomId: 'hall-a', speaker: '李明远', delegation: '中国', language: '中文', topic: '绿色基础设施机制', plannedSeconds: 600, remainingSeconds: 600, status: 'queued' as SpeechStatus, updatedAt: now },
    { id: 'speech-3', roomId: 'hall-b', speaker: 'Maria Silva', delegation: '巴西', language: '葡萄牙语', topic: '边缘算力与能源', plannedSeconds: 420, remainingSeconds: 420, status: 'queued' as SpeechStatus, updatedAt: now }
  ],
  channels: [
    { id: 'ch-a-zh', roomId: 'hall-a', language: '中文', interpreter: '周雨', status: 'active' as const, health: 96 },
    { id: 'ch-a-es', roomId: 'hall-a', language: '西班牙语', interpreter: 'Lucía M.', status: 'active' as const, health: 91 },
    { id: 'ch-a-fr', roomId: 'hall-a', language: '法语', interpreter: 'Noah B.', status: 'standby' as const, health: 88 },
    { id: 'ch-b-zh', roomId: 'hall-b', language: '中文', interpreter: '何佳', status: 'active' as const, health: 94 }
  ],
  terms: [
    { id: 'term-1', phrase: 'loss and damage', translation: '损失与损害', language: '中文', approved: true },
    { id: 'term-2', phrase: 'edge inference', translation: '边缘推理', language: '中文', approved: true },
    { id: 'term-3', phrase: 'just transition', translation: '公正转型', language: '中文', approved: false }
  ],
  captions: [
    { id: 'caption-1', speechId: 'speech-1', roomId: 'hall-a', language: '中文', interpreter: '周雨', text: '我们需要把适应资金与可衡量的社区韧性目标绑定。', revision: 2, at: now }
  ],
  audits: [
    { id: 'audit-1', at: now, roomId: 'hall-a', message: 'Amina Diallo 开始发言，中文频道由周雨接续' },
    { id: 'audit-2', at: new Date(Date.now() - 90000).toISOString(), roomId: 'hall-a', message: '临时插话申请已插入队列第2位' }
  ],
  lowLatency: false
};

/* ------------------------------------------------------------------ */
/* 存档：v2 直接读取；旧 v1 存档升级后继续打开                            */
/* ------------------------------------------------------------------ */

const STORAGE_KEY = 'conference-interpretation-v2';
const STORAGE_KEY_V1 = 'conference-interpretation-v1';

function readState(): ConferenceState {
  if (typeof localStorage === 'undefined') return migrate(seedV1, seedRooms);
  try {
    const v2 = localStorage.getItem(STORAGE_KEY);
    if (v2) return migrate(JSON.parse(v2), seedRooms);
    const v1 = localStorage.getItem(STORAGE_KEY_V1);
    if (v1) {
      const upgraded = migrate(JSON.parse(v1), seedRooms);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(upgraded));
      return upgraded;
    }
  } catch {
    /* 损坏存档回落到种子 */
  }
  return migrate(seedV1, seedRooms);
}

const opId = (consoleId: ConsoleId) => `${consoleId}-${crypto.randomUUID()}`;

/* ------------------------------------------------------------------ */
/* 页面                                                                 */
/* ------------------------------------------------------------------ */

const captionSchema = z.object({ text: z.string().min(1, '字幕不能为空') });
const queueSchema = z.object({
  speaker: z.string().min(2, '请输入发言人'),
  delegation: z.string().min(2, '请输入代表团'),
  language: z.string().min(2),
  topic: z.string().min(3, '请输入议题'),
  plannedSeconds: z.coerce.number().min(60).max(3600)
});
type QueueForm = z.infer<typeof queueSchema>;

export default component$(() => {
  const locale = useSpeakLocale();
  const state = useStore<ConferenceState>(readState(), { deep: true });
  const captionLoader = useSignal({ text: '' });
  const captionLanguage = useSignal('中文');
  const [captionForm, { Form: CaptionForm, Field: CaptionField }] = useForm<z.infer<typeof captionSchema>>({
    loader: captionLoader,
    validate: zodForm$(captionSchema)
  });
  const queueLoader = useSignal<QueueForm>({ speaker: '', delegation: '', language: '英语', topic: '', plannedSeconds: 300 });
  const [queueForm, { Form: QueueForm, Field: QueueField }] = useForm<QueueForm>({
    loader: queueLoader,
    validate: zodForm$(queueSchema)
  });

  // 未同步操作也在存档内：重开浏览器仍在
  useVisibleTask$(({ track }) => {
    track(() => state);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  });

  const activeRoomId = () => state.perConsoleActiveRoom[state.activeConsole];
  const activeRoom = () => state.rooms.find((room) => room.id === activeRoomId()) ?? state.rooms[0];
  const roomQueue = () =>
    state.speechQueue
      .filter((item) => item.roomId === activeRoomId())
      .sort((a, b) => a.seq - b.seq || a.updatedAt.localeCompare(b.updatedAt));
  const roomChannels = () => state.channels.filter((item) => item.roomId === activeRoomId());
  const currentSpeech = () => roomQueue().find((item) => item.status === 'speaking');
  const online = () => state.online[state.activeConsole];
  const localPending = () => state.outboxes[state.activeConsole].filter((op) => op.roomId === activeRoomId());
  const peerPending = () => state.peerOutboxes[state.activeConsole].filter((op) => op.roomId === activeRoomId());
  const roomConflicts = () => state.conflicts.filter((c) => c.roomId === activeRoomId() && !c.resolved);

  /** 所有变更统一入口：在线直接生效；断网先乐观执行并记带编号/厅的待同步操作 */
  const recordOp$ = $(async (build: () => PendingOp, apply: (op: PendingOp) => void) => {
    const op = build();
    apply(op);
    if (!online()) {
      state.outboxes[state.activeConsole].push(op);
    } else {
      state.appliedOpIds = [...state.appliedOpIds, op.id].slice(-800);
    }
  });

  // 切换会议厅只处理本厅
  const selectRoom$ = $((roomId: string) => {
    state.perConsoleActiveRoom[state.activeConsole] = roomId;
    pushAudit(state, roomId, `切换到 ${state.rooms.find((room) => room.id === roomId)?.name}`);
    if (online()) syncRoom(state, roomId);
  });

  const selectConsole$ = $((target: ConsoleId) => {
    if (target === state.activeConsole) return;
    const prev = state.activeConsole;
    // 操作台视角互换：在本台模拟的对端操作，回到对端就是它自己的待同步队列
    const carriedToOwn = state.peerOutboxes[prev];
    const ownPendingOfPrev = state.outboxes[prev];
    const mergeById = (base: PendingOp[], incoming: PendingOp[]) => {
      const ids = new Set(base.map((o) => o.id));
      return [...base, ...incoming.filter((o) => !ids.has(o.id))];
    };
    state.outboxes[target] = mergeById(state.outboxes[target], carriedToOwn);
    state.peerOutboxes[target] = mergeById(state.peerOutboxes[target], ownPendingOfPrev);
    state.peerOutboxes[prev] = [];
    state.activeConsole = target;
    pushAudit(state, state.perConsoleActiveRoom[target], `切换到 ${target === 'console-1' ? '1号操作台' : '2号操作台'}`);
    if (state.online[target]) syncRoom(state, state.perConsoleActiveRoom[target]);
  });

  const toggleLink$ = $(() => {
    const next = !online();
    state.online[state.activeConsole] = next;
    if (next) {
      pushAudit(state, activeRoomId(), '网络恢复，开始合并本厅待同步指挥流');
      syncRoom(state, activeRoomId());
    } else {
      pushAudit(state, activeRoomId(), '网络断开，后续操作先在本机执行并记入待同步队列');
    }
  });

  const syncNow$ = $(() => syncRoom(state, activeRoomId()));

  const addSpeech$ = $(async (values: QueueForm) => {
    const speechId = `speech-${crypto.randomUUID()}`;
    const roomId = activeRoomId();
    const consoleId = state.activeConsole;
    const at = new Date().toISOString();
    const seq = nextSeq(state, roomId);
    await recordOp$(
      () => ({
        id: opId(consoleId),
        console: consoleId,
        roomId,
        at,
        type: 'speech-enqueue',
        speechId,
        seq,
        speaker: values.speaker,
        delegation: values.delegation,
        language: values.language,
        topic: values.topic,
        plannedSeconds: values.plannedSeconds
      }),
      (op) => {
        mutateEnqueue(state, op as SpeechEnqueueOp);
        pushAudit(state, roomId, `${values.speaker} 已加入发言队列${online() ? '' : '（待同步）'}`);
      }
    );
  });

  const advanceSpeech$ = $(async (speech: Speech, status: SpeechStatus) => {
    const roomId = activeRoomId();
    const consoleId = state.activeConsole;
    await recordOp$(
      () => ({
        id: opId(consoleId),
        console: consoleId,
        roomId,
        at: new Date().toISOString(),
        type: 'speech-status',
        speechId: speech.id,
        speechSeq: speech.seq,
        baseStatusVersion: speech.statusVersion,
        status
      }),
      (op) => {
        mutateSpeechStatus(state, op as SpeechStatusOp);
        pushAudit(state, roomId, `发言 #${speech.seq} 状态更新为 ${STATUS_LABEL[status]}${online() ? '' : '（待同步）'}`);
      }
    );
  });

  const adjustTime$ = $(async (speech: Speech) => {
    const roomId = activeRoomId();
    const consoleId = state.activeConsole;
    const remainingSeconds = Math.max(0, speech.remainingSeconds - 60);
    await recordOp$(
      () => ({
        id: opId(consoleId),
        console: consoleId,
        roomId,
        at: new Date().toISOString(),
        type: 'time-adjust',
        speechId: speech.id,
        speechSeq: speech.seq,
        baseStatusVersion: speech.statusVersion,
        remainingSeconds
      }),
      (op) => mutateTimeAdjust(state, op as TimeAdjustOp)
    );
  });

  const handoff$ = $(async (channel: Channel) => {
    const roomId = activeRoomId();
    const consoleId = state.activeConsole;
    const batchId = nextHandoffBatch(channel);
    await recordOp$(
      () => ({
        id: opId(consoleId),
        console: consoleId,
        roomId,
        at: new Date().toISOString(),
        type: 'handoff-start',
        channelId: channel.id,
        baseHandoffVersion: channel.handoffVersion,
        batchId
      }),
      (op) => {
        mutateHandoffStart(state, op as HandoffStartOp);
        pushAudit(state, roomId, `启动译员交接批次 ${batchId}，原译文版本已冻结${online() ? '' : '（待同步）'}`);
      }
    );
  });

  const completeHandoff$ = $(async (channel: Channel, interpreter: string) => {
    const roomId = activeRoomId();
    const consoleId = state.activeConsole;
    const batchId = channel.openHandoffBatch ?? nextHandoffBatch(channel);
    await recordOp$(
      () => ({
        id: opId(consoleId),
        console: consoleId,
        roomId,
        at: new Date().toISOString(),
        type: 'handoff-complete',
        channelId: channel.id,
        baseHandoffVersion: channel.handoffVersion,
        batchId,
        interpreter
      }),
      (op) => {
        mutateHandoffComplete(state, op as HandoffCompleteOp);
        pushAudit(state, roomId, `${interpreter} 接续 ${channel.language} 频道，后续字幕归属新译员${online() ? '' : '（待同步）'}`);
      }
    );
  });

  const publishCaption$ = $(async (values: z.infer<typeof captionSchema>) => {
    const speech = state.speechQueue.find((item) => item.roomId === activeRoomId() && item.status === 'speaking');
    if (!speech) return;
    const queryClient = new QueryClient();
    const confirmed = await queryClient.fetchQuery({
      queryKey: ['caption-publish', speech.id, values.text],
      queryFn: async () => values.text === values.text.trim(),
      staleTime: 0
    });
    if (!confirmed) return;
    const language = captionLanguage.value;
    const channel = state.channels.find((item) => item.roomId === activeRoomId() && item.language === language);
    if (!channel) return;
    const head = state.captions.find((c) => c.speechId === speech.id && c.language === language && !c.forked);
    const roomId = activeRoomId();
    const consoleId = state.activeConsole;
    await recordOp$(
      () => ({
        id: opId(consoleId),
        console: consoleId,
        roomId,
        at: new Date().toISOString(),
        type: 'caption-revise',
        speechId: speech.id,
        speechSeq: speech.seq,
        language,
        handoffBatch: channel.openHandoffBatch,
        interpreter: channel.interpreter,
        baseRevision: head?.revision ?? 0,
        revision: (head?.revision ?? 0) + 1,
        text: values.text.trim()
      }),
      (op) => mutateCaption(state, op as CaptionReviseOp, false)
    );
    captionLoader.value = { text: '' };
  });

  /* -------- 模拟对端操作台（断网期间）产生待同步操作 -------- */

  const peerSim$ = $((kind: 'done' | 'revert' | 'caption' | 'handoff') => {
    const speech = currentSpeech();
    const roomId = activeRoomId();
    const peer: ConsoleId = state.activeConsole === 'console-1' ? 'console-2' : 'console-1';
    const base = (extra: object): PendingOp =>
      ({ id: opId(peer), console: peer, roomId, at: new Date().toISOString(), ...extra }) as PendingOp;
    if (kind === 'done' && speech) {
      state.peerOutboxes[state.activeConsole].push(
        base({
          type: 'speech-status',
          speechId: speech.id,
          speechSeq: speech.seq,
          baseStatusVersion: speech.statusVersion,
          status: 'done'
        }) as SpeechStatusOp
      );
    } else if (kind === 'revert' && speech) {
      // 对端基于断线前的旧版本，要求把发言退回排队 —— 合并时必须失效
      state.peerOutboxes[state.activeConsole].push(
        base({
          type: 'speech-status',
          speechId: speech.id,
          speechSeq: speech.seq,
          baseStatusVersion: Math.max(0, speech.statusVersion - 1),
          status: 'queued'
        }) as SpeechStatusOp
      );
    } else if (kind === 'caption' && speech) {
      const channel = state.channels.find((c) => c.roomId === roomId && c.language === captionLanguage.value);
      const head = state.captions.find((c) => c.speechId === speech.id && c.language === captionLanguage.value && !c.forked);
      if (channel) {
        state.peerOutboxes[state.activeConsole].push(
          base({
            type: 'caption-revise',
            speechId: speech.id,
            speechSeq: speech.seq,
            language: channel.language,
            handoffBatch: channel.openHandoffBatch,
            interpreter: channel.interpreter,
            baseRevision: head?.revision ?? 0,
            revision: (head?.revision ?? 0) + 1,
            text: `（对端修订 v${(head?.revision ?? 0) + 1}）适应资金应锚定可核查的社区韧性指标。`
          }) as CaptionReviseOp
        );
      }
    } else if (kind === 'handoff') {
      const channel = roomChannels().find((c) => c.language === captionLanguage.value) ?? roomChannels()[0];
      if (channel) {
        const batchId = nextHandoffBatch(channel);
        state.peerOutboxes[state.activeConsole].push(
          base({ type: 'handoff-start', channelId: channel.id, baseHandoffVersion: channel.handoffVersion, batchId }) as HandoffStartOp
        );
        state.peerOutboxes[state.activeConsole].push(
          base({
            type: 'handoff-complete',
            channelId: channel.id,
            baseHandoffVersion: channel.handoffVersion + 1,
            batchId,
            interpreter: `对端替补-${channel.language}`
          }) as HandoffCompleteOp
        );
      }
    }
  });

  /* ---------------- 冲突裁定 ---------------- */

  const resolveStatus$ = $(async (conflict: Extract<MergeConflict, { kind: 'speech-status' }>, pick: 'local' | 'peer') => {
    const speech = state.speechQueue.find((s) => s.id === conflict.speechId);
    if (speech) {
      const status = pick === 'local' ? conflict.localStatus : conflict.peerStatus;
      mutateSpeechStatus(state, {
        id: `resolve-${crypto.randomUUID()}`,
        console: state.activeConsole,
        roomId: conflict.roomId,
        at: new Date().toISOString(),
        type: 'speech-status',
        speechId: speech.id,
        speechSeq: conflict.speechSeq,
        baseStatusVersion: speech.statusVersion,
        status
      });
      pushAudit(state, conflict.roomId, `冲突裁定：第 ${conflict.speechSeq} 条采用${pick === 'local' ? '本台' : '对端'}状态「${STATUS_LABEL[status]}」`);
    }
    conflict.resolved = true;
  });

  const resolveCaption$ = $(async (conflict: Extract<MergeConflict, { kind: 'caption' }>, pick: 'local' | 'peer') => {
    const head =
      state.captions.find((c) => c.id === conflict.localOpId) ??
      state.captions.find((c) => c.speechId === conflict.speechId && c.language === conflict.language && !c.forked);
    const fork = state.captions.find((c) => c.id === `caption-${conflict.peerOpId}`);
    if (pick === 'peer' && fork) {
      if (head) {
        head.text = fork.text;
        head.interpreter = fork.interpreter;
        head.handoffBatch = fork.handoffBatch;
        head.revision = Math.max(head.revision, fork.revision) + 1;
        head.at = new Date().toISOString();
      }
      fork.forkWinner = true;
    } else if (head) {
      head.forkWinner = true;
    }
    pushAudit(state, conflict.roomId, `冲突裁定：第 ${conflict.speechSeq} 条 ${conflict.language}字幕采用${pick === 'local' ? '本台' : '对端'}版本`);
    conflict.resolved = true;
  });

  const resolveHandoff$ = $(async (conflict: Extract<MergeConflict, { kind: 'handoff' }>, pick: 'local' | 'peer') => {
    const channel = state.channels.find((c) => c.id === conflict.channelId);
    if (channel) {
      channel.interpreter = pick === 'local' ? conflict.localInterpreter : conflict.peerInterpreter;
      channel.status = 'active';
      channel.openHandoffBatch = null;
      pushAudit(state, conflict.roomId, `冲突裁定：${channel.language} 频道采用${pick === 'local' ? '本台' : '对端'}译员 ${channel.interpreter}`);
    }
    conflict.resolved = true;
  });

  const adoptOrphan$ = $(async (conflict: Extract<MergeConflict, { kind: 'caption-orphan' }>, discard = false) => {
    const speech = state.speechQueue.find((s) => s.roomId === conflict.roomId && s.seq === conflict.speechSeq);
    if (!discard && speech) {
      state.captions.unshift({
        id: `caption-adopt-${crypto.randomUUID()}`,
        speechId: speech.id,
        roomId: conflict.roomId,
        language: conflict.language,
        interpreter: conflict.peerInterpreter,
        handoffBatch: null,
        text: conflict.peerText,
        revision: 1,
        baseRevision: 0,
        forked: false,
        forkWinner: true,
        at: new Date().toISOString()
      });
      pushAudit(state, conflict.roomId, `挂空字幕已人工挂到第 ${conflict.speechSeq} 条发言`);
    } else if (discard) {
      pushAudit(state, conflict.roomId, `挂空字幕已丢弃，保持不挂接`);
    }
    conflict.resolved = true;
  });

  const approveTerm$ = $((id: string) => {
    state.terms = state.terms.map((term) => (term.id === id ? { ...term, approved: true } : term));
    pushAudit(state, activeRoomId(), `术语已批准：${state.terms.find((term) => term.id === id)?.phrase}`);
  });

  const pendingTotal = localPending().length + peerPending().length;

  return (
    <main class={`conference-shell ${state.lowLatency ? 'low-latency' : ''}`}>
      <header class="hero">
        <div>
          <span class="pill">{locale.lang}</span>
          <h1>同声传译与发言队列</h1>
          <p>{activeRoom().name} · {activeRoom().topic}</p>
        </div>
        <div style="display:flex;gap:12px;flex-wrap:wrap">
          <select value={state.activeConsole} onChange$={(event) => selectConsole$(((event.target as HTMLSelectElement | null)?.value as ConsoleId) ?? 'console-1')}>
            <option value="console-1">1号操作台</option>
            <option value="console-2">2号操作台</option>
          </select>
          <select value={activeRoomId()} onChange$={(event) => selectRoom$((event.target as HTMLSelectElement).value)}>
            {state.rooms.map((room) => (
              <option value={room.id} key={room.id}>{room.name}</option>
            ))}
          </select>
          <button class={online() ? 'secondary' : 'danger'} onClick$={toggleLink$}>
            {online() ? '● 网络在线' : '○ 网络断开'}
          </button>
          <button class="secondary" onClick$={() => (state.lowLatency = !state.lowLatency)}>
            {state.lowLatency ? '退出低延迟' : '低延迟模式'}
          </button>
        </div>
      </header>

      {/* 可恢复指挥流：待同步操作 + 合并 + 冲突 */}
      <section class="panel sync-panel">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
          <h2 style="margin:0">待同步指挥流（{activeRoom().name}）</h2>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <span class={`pill ${online() ? 'pill-ok' : 'pill-bad'}`}>{online() ? '本台在线' : '本台离线：操作先本地执行'}</span>
            <span class="pill">本台待同步 {localPending().length}</span>
            <span class="pill">对端待合并 {peerPending().length}</span>
            <span class={roomConflicts().length ? 'pill pill-bad' : 'pill'}>待裁定冲突 {roomConflicts().length}</span>
            <button disabled={!online() || pendingTotal === 0} onClick$={syncNow$}>
              恢复网络后合并本厅
            </button>
          </div>
        </div>

        <div class="op-grid">
          <div>
            <h3>本台待同步（带操作编号 / 会议厅 / 对应依据）</h3>
            {localPending().length === 0 && <p class="muted">无。操作即时生效或已全部同步。</p>}
            {localPending().map((op) => (
              <div class="op-row" key={op.id}>
                <small>{new Date(op.at).toLocaleTimeString()}</small>
                <div>{opSummary(op)}</div>
                <code>{op.id.slice(0, 18)}… · {op.roomId}</code>
              </div>
            ))}
          </div>
          <div>
            <h3>对端推来的待合并操作</h3>
            {peerPending().length === 0 && <p class="muted">无。</p>}
            {peerPending().map((op) => (
              <div class="op-row peer" key={op.id}>
                <small>{new Date(op.at).toLocaleTimeString()} · {op.console === 'console-1' ? '1号台' : '2号台'}</small>
                <div>{opSummary(op)}</div>
                <code>{op.id.slice(0, 18)}…</code>
              </div>
            ))}
            <div class="peer-sim">
              <b>模拟对端断网期间操作（重连后验证失效/分叉）：</b>
              <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
                <button class="secondary" onClick$={() => peerSim$('done')}>对端结束当前发言</button>
                <button class="secondary" onClick$={() => peerSim$('revert')}>对端旧版要求退回排队</button>
                <button class="secondary" onClick$={() => peerSim$('caption')}>对端修订同条字幕</button>
                <button class="secondary" onClick$={() => peerSim$('handoff')}>对端完成一轮交接</button>
              </div>
            </div>
          </div>
        </div>

        {roomConflicts().length > 0 && (
          <div class="conflict-box">
            <h3>冲突清单（两边保留，差异如下，裁定前不互相覆盖）</h3>
            {roomConflicts().map((conflict) => (
              <div class="conflict-row" key={conflict.id}>
                {conflict.kind === 'speech-status' && (
                  <>
                    <div><b>第 {conflict.speechSeq} 条发言状态分叉</b>（共同基于 v{conflict.baseStatusVersion}）</div>
                    <div class="diff-cols">
                      <div class="side local-side"><span class="pill">本台</span><b>{STATUS_LABEL[conflict.localStatus]}</b></div>
                      <div class="side peer-side"><span class="pill">对端</span><b>{STATUS_LABEL[conflict.peerStatus]}</b></div>
                    </div>
                    <div style="display:flex;gap:8px">
                      <button onClick$={() => resolveStatus$(conflict, 'local')}>采用本台</button>
                      <button class="secondary" onClick$={() => resolveStatus$(conflict, 'peer')}>采用对端</button>
                    </div>
                  </>
                )}
                {conflict.kind === 'caption' && (
                  <>
                    <div><b>第 {conflict.speechSeq} 条 {conflict.language}字幕分叉</b> · {conflict.lineLabel}</div>
                    <div class="diff-cols">
                      <div class="side local-side">
                        <span class="pill">本台 · {conflict.localInterpreter}</span>
                        <p>
                          {buildTextDiff(conflict.localText, conflict.peerText)
                            .filter((p) => p.kind !== 'ins')
                            .map((p, i) => (
                              <span class={p.kind === 'del' ? 'diff-del' : ''} key={i}>{p.text}</span>
                            ))}
                        </p>
                      </div>
                      <div class="side peer-side">
                        <span class="pill">对端 · {conflict.peerInterpreter}</span>
                        <p>
                          {buildTextDiff(conflict.localText, conflict.peerText)
                            .filter((p) => p.kind !== 'del')
                            .map((p, i) => (
                              <span class={p.kind === 'ins' ? 'diff-ins' : ''} key={i}>{p.text}</span>
                            ))}
                        </p>
                      </div>
                    </div>
                    <div style="display:flex;gap:8px">
                      <button onClick$={() => resolveCaption$(conflict, 'local')}>采用本台</button>
                      <button class="secondary" onClick$={() => resolveCaption$(conflict, 'peer')}>采用对端</button>
                    </div>
                  </>
                )}
                {conflict.kind === 'handoff' && (
                  <>
                    <div><b>同一交接批次双方指定了不同译员</b> · {conflict.channelId}</div>
                    <div class="diff-cols">
                      <div class="side local-side"><span class="pill">本台</span><b>{conflict.localInterpreter}</b></div>
                      <div class="side peer-side"><span class="pill">对端</span><b>{conflict.peerInterpreter}</b></div>
                    </div>
                    <div style="display:flex;gap:8px">
                      <button onClick$={() => resolveHandoff$(conflict, 'local')}>采用本台</button>
                      <button class="secondary" onClick$={() => resolveHandoff$(conflict, 'peer')}>采用对端</button>
                    </div>
                  </>
                )}
                {conflict.kind === 'caption-orphan' && (
                  <>
                    <div>
                      <b>对端字幕找不到第 {conflict.speechSeq} 条发言</b> · {conflict.language} · {conflict.peerInterpreter}
                      （已隔离，未挂到任何新发言）
                    </div>
                    <div class="side peer-side"><p>{conflict.peerText}</p></div>
                    <div style="display:flex;gap:8px">
                      <button
                        disabled={!state.speechQueue.some((s) => s.roomId === activeRoomId() && s.seq === conflict.speechSeq)}
                        onClick$={() => adoptOrphan$(conflict)}
                      >
                        挂到同序号发言
                      </button>
                      <button class="secondary" onClick$={() => adoptOrphan$(conflict, true)}>丢弃（保持不挂接）</button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section class="grid" style="margin-top:18px">
        <article class="panel">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <h2>发言队列</h2>
            <span class="pill">{roomQueue().length} 条 · {activeRoom().simultaneousChannels} 个同传频道</span>
          </div>
          {roomQueue().map((speech) => (
            <div class={`queue-row ${speech.status === 'speaking' ? 'active' : ''}`} key={speech.id}>
              <strong>#{speech.seq}</strong>
              <div>
                <b>{speech.speaker}</b>
                <div style="color:#638087;font-size:13px">{speech.delegation} · {speech.language} · {speech.topic}</div>
                <small class="muted">状态版本 v{speech.statusVersion}</small>
              </div>
              <span class="pill">{STATUS_LABEL[speech.status]}</span>
              <div style="display:flex;gap:6px;flex-wrap:wrap">
                {speech.status === 'queued' && <button onClick$={() => advanceSpeech$(speech, 'speaking')}>开始</button>}
                {speech.status === 'speaking' && (
                  <>
                    <button onClick$={() => advanceSpeech$(speech, 'done')}>结束</button>
                    <button class="secondary" onClick$={() => adjustTime$(speech)}>减1分钟</button>
                  </>
                )}
                {speech.status === 'queued' && <button class="danger" onClick$={() => advanceSpeech$(speech, 'skipped')}>跳过</button>}
              </div>
            </div>
          ))}
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:18px">
            <QueueForm onSubmit$={addSpeech$}>
              <QueueField name="speaker">
                {(field, props) => (
                  <input {...props} value={field.value} onInput$={(event) => (field.value = (event.target as HTMLInputElement).value)} placeholder="发言人" />
                )}
              </QueueField>
              <QueueField name="delegation">
                {(field, props) => (
                  <input {...props} value={field.value} onInput$={(event) => (field.value = (event.target as HTMLInputElement).value)} placeholder="代表团" />
                )}
              </QueueField>
              <QueueField name="topic">
                {(field, props) => (
                  <input {...props} value={field.value} onInput$={(event) => (field.value = (event.target as HTMLInputElement).value)} placeholder="议题" />
                )}
              </QueueField>
              <QueueField name="plannedSeconds" type="number">
                {(field, props) => (
                  <input
                    {...props}
                    type="number"
                    value={field.value}
                    onInput$={(event) => (field.value = Number((event.target as HTMLInputElement).value))}
                    placeholder="计划秒数"
                  />
                )}
              </QueueField>
              <button type="submit">{online() ? '加入队列' : '加入队列（离线待同步）'}</button>
            </QueueForm>
          </div>
        </article>

        <aside class="panel">
          <h2>频道与译员</h2>
          {roomChannels().map((channel) => (
            <div style="padding:12px 0;border-bottom:1px solid #e6efee" key={channel.id}>
              <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap">
                <b>{channel.language} · {channel.interpreter}</b>
                <span class="pill">
                  {channel.status === 'active' ? '在岗' : channel.status === 'handoff' ? `交接中 ${channel.openHandoffBatch ?? ''}` : '待命'} · v{channel.handoffVersion}
                </span>
              </div>
              <div class="decorative" style="margin:8px 0"><Progress.Root value={channel.health} max={100} /></div>
              <div style="display:flex;gap:8px">
                <button class="secondary" disabled={channel.status === 'handoff'} onClick$={() => handoff$(channel)}>
                  开始交接
                </button>
                {channel.status === 'handoff' && (
                  <button onClick$={() => completeHandoff$(channel, `替补译员-${channel.language}`)}>完成交接</button>
                )}
              </div>
            </div>
          ))}
          <h3>实时字幕修正（按发言序号与修订号对应）</h3>
          {currentSpeech() ? (
            <CaptionForm onSubmit$={publishCaption$}>
              <select
                value={captionLanguage.value}
                onChange$={(e) => (captionLanguage.value = ((e.target as HTMLSelectElement | null)?.value) ?? '中文')}
              >
                {roomChannels().map((c) => (
                  <option value={c.language} key={c.id}>{`${c.language}（${c.interpreter}）`}</option>
                ))}
              </select>
              <div style="margin-top:8px">
                <CaptionField name="text">
                  {(field, props) => (
                    <textarea
                      {...props}
                      rows={3}
                      value={field.value}
                      onInput$={(event) => (field.value = (event.target as HTMLTextAreaElement).value)}
                      placeholder="输入或修正当前字幕"
                    />
                  )}
                </CaptionField>
              </div>
              <button type="submit" style="margin-top:8px">{online() ? '提交新版字幕' : '提交字幕（离线待同步）'}</button>
            </CaptionForm>
          ) : (
            <p>当前没有发言中的代表。</p>
          )}
          {state.captions
            .filter((caption) => caption.roomId === activeRoomId())
            .sort((a, b) => Number(a.forked) - Number(b.forked) || b.revision - a.revision)
            .map((caption) => {
              const seq = state.speechQueue.find((s) => s.id === caption.speechId)?.seq;
              return (
                <div class={`caption-card ${caption.forked ? 'fork' : ''} ${caption.forkWinner ? 'winner' : ''}`} style="margin-top:10px;padding:10px;border-radius:10px" key={caption.id}>
                  <b>
                    #{seq ?? '?'} · {caption.interpreter} · v{caption.revision}
                    {caption.baseRevision > 0 && <span class="muted">（基于 v{caption.baseRevision}）</span>}
                  </b>
                  {caption.handoffBatch && <span class="pill" style="margin-left:6px">交接 {caption.handoffBatch}</span>}
                  {caption.forked && <span class="pill pill-bad" style="margin-left:6px">分叉保留</span>}
                  {caption.forkWinner && <span class="pill pill-ok" style="margin-left:6px">裁定采用</span>}
                  <p style="margin:6px 0 0">{caption.text}</p>
                </div>
              );
            })}
        </aside>
      </section>

      <section class="grid" style="margin-top:18px">
        <article class="panel">
          <h2>术语库</h2>
          {state.terms.map((term) => (
            <div class="queue-row" key={term.id}>
              <span />
              <div><b>{term.phrase}</b><div>{term.translation} · {term.language}</div></div>
              <span class="pill">{term.approved ? '已批准' : '待审'}</span>
              <button disabled={term.approved} onClick$={() => approveTerm$(term.id)}>
                批准
              </button>
            </div>
          ))}
        </article>
        <article class="panel">
          <h2>操作与交接时间线（{activeRoom().name}）</h2>
          {state.audits
            .filter((audit) => audit.roomId === activeRoomId())
            .slice(0, 14)
            .map((audit) => (
              <div style="padding:10px 0;border-bottom:1px solid #e6efee" key={audit.id}>
                <small>{new Date(audit.at).toLocaleTimeString()}</small>
                <div>{audit.message}</div>
              </div>
            ))}
        </article>
      </section>
    </main>
  );
});

export const head: DocumentHead = {
  title: '国际会议同声传译控制台',
  meta: [{ name: 'description', content: '发言队列、多语种频道、术语、译员交接、实时字幕修正与断网可恢复合并' }]
};
