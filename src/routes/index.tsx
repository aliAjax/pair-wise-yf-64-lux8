import { $, component$, useSignal, useStore, useVisibleTask$ } from '@builder.io/qwik';
import { Progress } from '@qwik-ui/headless';
import { QueryClient } from '@tanstack/query-core';
import { useForm, zodForm$ } from '@modular-forms/qwik';
import { useSpeakLocale } from 'qwik-speak';
import { z } from 'zod';
import type { DocumentHead } from '@builder.io/qwik-city';
import {
  applyCaptionLocal,
  applyHandoffLocal,
  applySpeechAddLocal,
  applySpeechStatusLocal,
  describeOp,
  loadState,
  makeOp,
  mergeRemoteOps,
  readPeerLog,
  resolveConflict,
  saveState,
  simulatePeerActivity
} from '~/lib/sync';
import type { ConferenceState, SpeechStatus } from '~/lib/sync';

const captionSchema = z.object({ text: z.string().min(1, '字幕不能为空') });
const queueSchema = z.object({
  speaker: z.string().min(2, '请输入发言人'),
  delegation: z.string().min(2, '请输入代表团'),
  language: z.string().min(2),
  topic: z.string().min(3, '请输入议题'),
  plannedSeconds: z.coerce.number().min(60).max(3600)
});
type QueueForm = z.infer<typeof queueSchema>;

const advanceSpeech$ = $((state: ConferenceState, id: string, status: SpeechStatus) => {
  const speech = state.speechQueue.find((item) => item.id === id);
  if (!speech) return;
  // 先记带操作编号和会议厅的待同步操作，再乐观应用到本地
  const op = makeOp(state, {
    type: 'speech-status',
    roomId: state.activeRoomId,
    speechId: id,
    speechSeq: speech.seq,
    to: status,
    baseSpeechVersion: speech.version
  });
  applySpeechStatusLocal(state, op);
  state.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), roomId: state.activeRoomId, message: `发言 #${speech.seq} 状态更新为 ${status}（操作 ${op.opId}，基于 v${speech.version - 1}）` });
});

const addCaption$ = $((state: ConferenceState, speechId: string, text: string) => {
  const speech = state.speechQueue.find((item) => item.id === speechId);
  const channel = state.channels.find((item) => item.roomId === speech?.roomId && item.language === '中文');
  if (!speech || !channel || !text.trim()) return;
  const existing = state.captions.find((item) => item.speechId === speechId && item.language === channel.language);
  const op = makeOp(state, {
    type: 'caption-revise',
    roomId: state.activeRoomId,
    speechId,
    language: channel.language,
    text: text.trim(),
    baseCaptionRevision: existing?.revision ?? 0
  });
  applyCaptionLocal(state, op);
  state.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), roomId: state.activeRoomId, message: `字幕修订已提交（操作 ${op.opId}，基于 v${existing?.revision ?? 0}）` });
});

export default component$(() => {
  const locale = useSpeakLocale();
  const state = useStore<ConferenceState>(loadState());
  const captionLoader = useSignal({ text: '' });
  const [captionForm, { Form: CaptionForm, Field: CaptionField }] = useForm<z.infer<typeof captionSchema>>({
    loader: captionLoader,
    validate: zodForm$(captionSchema)
  });
  const queueLoader = useSignal<QueueForm>({ speaker: '', delegation: '', language: '英语', topic: '', plannedSeconds: 300 });
  const [queueForm, { Form: QueueForm, Field: QueueField }] = useForm<QueueForm>({
    loader: queueLoader,
    validate: zodForm$(queueSchema)
  });

  useVisibleTask$(({ track }) => {
    track(() => state);
    saveState(state); // 待同步操作随 state 持久化，重开浏览器仍在
  });

  const activeRoom = () => state.rooms.find((room) => room.id === state.activeRoomId) ?? state.rooms[0];
  const roomQueue = () => state.speechQueue.filter((item) => item.roomId === state.activeRoomId);
  const roomChannels = () => state.channels.filter((item) => item.roomId === state.activeRoomId);
  const currentSpeech = () => roomQueue().find((item) => item.status === 'speaking');
  const roomOps = () => state.opLog.filter((op) => op.roomId === state.activeRoomId);
  const pendingOps = () => roomOps().filter((op) => op.status === 'pending');
  const supersededOps = () => roomOps().filter((op) => op.status === 'superseded');
  const roomConflicts = () => state.conflicts.filter((c) => c.roomId === state.activeRoomId && !c.resolution);

  const selectRoom$ = $((roomId: string) => {
    state.activeRoomId = roomId;
    state.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), roomId, message: `切换到 ${state.rooms.find((room) => room.id === roomId)?.name}，同步只处理本厅操作` });
  });

  const addSpeech$ = $((values: QueueForm) => {
    const seq = Math.max(0, ...state.speechQueue.filter((s) => s.roomId === state.activeRoomId).map((s) => s.seq)) + 1;
    const op = makeOp(state, {
      type: 'speech-add',
      roomId: state.activeRoomId,
      speechSeq: seq,
      speech: { speaker: values.speaker, delegation: values.delegation, language: values.language, topic: values.topic, plannedSeconds: values.plannedSeconds }
    });
    applySpeechAddLocal(state, op);
    state.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), roomId: state.activeRoomId, message: `${values.speaker} 已加入发言队列 #${seq}（操作 ${op.opId}）` });
  });

  const handoff$ = $((channelId: string) => {
    const batchId = `batch-${state.consoleId}-${crypto.randomUUID().slice(0, 8)}`;
    const op = makeOp(state, { type: 'handoff-start', roomId: state.activeRoomId, channelId, handoffBatch: batchId });
    applyHandoffLocal(state, op);
    state.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), roomId: state.activeRoomId, message: `${channelId} 启动译员交接（批次 ${batchId}，操作 ${op.opId}），原译文版本已冻结` });
  });

  const completeHandoff$ = $((channelId: string, interpreter: string) => {
    const channel = state.channels.find((c) => c.id === channelId);
    const batchId = channel?.activeBatch;
    const op = makeOp(state, { type: 'handoff-complete', roomId: state.activeRoomId, channelId, handoffBatch: batchId, interpreter });
    applyHandoffLocal(state, op);
    state.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), roomId: state.activeRoomId, message: `${interpreter} 接续 ${channelId}（批次 ${batchId ?? '无'}，操作 ${op.opId}），后续字幕归属新译员` });
  });

  const publishCaption$ = $(async (values: z.infer<typeof captionSchema>) => {
    const speech = state.speechQueue.find((item) => item.roomId === state.activeRoomId && item.status === 'speaking');
    if (!speech) return;
    const queryClient = new QueryClient();
    const confirmed = await queryClient.fetchQuery({
      queryKey: ['caption-publish', speech.id, values.text],
      queryFn: async () => values.text === values.text.trim(),
      staleTime: 0
    });
    if (confirmed) await addCaption$(state, speech.id, values.text);
  });

  const approveTerm$ = $((id: string) => {
    state.terms = state.terms.map((term) => term.id === id ? { ...term, approved: true } : term);
    state.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), roomId: state.activeRoomId, message: `术语已批准：${state.terms.find((term) => term.id === id)?.phrase}` });
  });

  const toggleNetwork$ = $(() => {
    state.online = !state.online;
    if (state.online) {
      // 恢复网络：合并对端待同步操作（只拉取本厅操作）
      const remote = readPeerLog();
      const result = mergeRemoteOps(state, remote);
      state.audits.unshift({
        id: crypto.randomUUID(), at: new Date().toISOString(), roomId: state.activeRoomId,
        message: `网络恢复，指挥流合并完成：应用 ${result.applied} · 失效 ${result.superseded} · 冲突 ${result.conflicts} · 跳过 ${result.skipped}`
      });
    } else {
      state.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), roomId: state.activeRoomId, message: '网络断开：发言队列、译员交接、字幕操作将保存在本地待同步队列，恢复后合并' });
    }
  });

  const simulatePeer$ = $(() => {
    const n = simulatePeerActivity(state);
    state.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), roomId: state.activeRoomId, message: `对端操作台在断网期间产生 ${n} 条并行操作（已写入对端待同步日志）` });
  });

  const resolve$ = $((conflictId: string, side: 'local' | 'remote') => {
    resolveConflict(state, conflictId, side);
  });

  return (
    <main class={`conference-shell ${state.lowLatency ? 'low-latency' : ''}`}>
      <header class="hero">
        <div><span class="pill">{locale.lang}</span><h1>同声传译与发言队列</h1><p>{activeRoom().name} · {activeRoom().topic}</p></div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center">
          <span class="pill" style={state.online ? { background: '#e3f4ee', color: '#1d7a5e' } : { background: '#fdeaea', color: '#b3402f' }}>{state.online ? '在线 · 已同步' : '断网 · 待同步'}</span>
          <select value={state.activeRoomId} onChange$={(event) => selectRoom$((event.target as HTMLSelectElement).value)}>{state.rooms.map((room) => <option value={room.id}>{room.name}</option>)}</select>
          <button class="secondary" onClick$={() => state.lowLatency = !state.lowLatency}>{state.lowLatency ? '退出低延迟' : '低延迟模式'}</button>
          <button onClick$={toggleNetwork$}>{state.online ? '断开网络' : '恢复网络并同步'}</button>
        </div>
      </header>

      {!state.online && (
        <section class="panel" style={{ borderColor: '#f0c4bd', background: '#fdf3f1' }}>
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
            <div><b>断网中</b><div style="color:#638087;font-size:13px">本台操作先记入待同步队列（带操作编号与会议厅），重开浏览器也不会丢失；恢复网络后与对端合并。</div></div>
            <button class="secondary" onClick$={simulatePeer$}>模拟对端断网期间操作</button>
          </div>
        </section>
      )}

      <section class="grid">
        <article class="panel">
          <div style="display:flex;justify-content:space-between;align-items:center"><h2>发言队列</h2><span class="pill">{roomQueue().length} 条 · {activeRoom().simultaneousChannels} 个同传频道</span></div>
          {roomQueue().map((speech, index) => (
            <div class={`queue-row ${speech.status === 'speaking' ? 'active' : ''}`} key={speech.id}>
              <strong>#{index + 1}</strong>
              <div><b>{speech.speaker}</b><div style="color:#638087;font-size:13px">{speech.delegation} · {speech.language} · {speech.topic}</div></div>
              <span class="pill">{speech.status} · v{speech.version}</span>
              <div style="display:flex;gap:6px">
                {speech.status === 'queued' && <button onClick$={() => advanceSpeech$(state, speech.id, 'speaking')}>开始</button>}
                {speech.status === 'speaking' && <><button onClick$={() => advanceSpeech$(state, speech.id, 'done')}>结束</button><button class="secondary" onClick$={() => speech.remainingSeconds = Math.max(0, speech.remainingSeconds - 60)}>减1分钟</button></>}
                {speech.status === 'queued' && <button class="danger" onClick$={() => advanceSpeech$(state, speech.id, 'skipped')}>跳过</button>}
              </div>
            </div>
          ))}
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:18px">
            <QueueForm onSubmit$={addSpeech$}>
              <QueueField name="speaker">{(field, props) => <input {...props} value={field.value} onInput$={(event) => field.value = (event.target as HTMLInputElement).value} placeholder="发言人" />}</QueueField>
              <QueueField name="delegation">{(field, props) => <input {...props} value={field.value} onInput$={(event) => field.value = (event.target as HTMLInputElement).value} placeholder="代表团" />}</QueueField>
              <QueueField name="topic">{(field, props) => <input {...props} value={field.value} onInput$={(event) => field.value = (event.target as HTMLInputElement).value} placeholder="议题" />}</QueueField>
              <QueueField name="plannedSeconds" type="number">{(field, props) => <input {...props} type="number" value={field.value} onInput$={(event) => field.value = Number((event.target as HTMLInputElement).value)} placeholder="计划秒数" />}</QueueField>
              <button type="submit">加入队列</button>
            </QueueForm>
          </div>
        </article>

        <aside class="panel">
          <h2>频道与译员</h2>
          {roomChannels().map((channel) => (
            <div style="padding:12px 0;border-bottom:1px solid #e6efee" key={channel.id}>
              <div style="display:flex;justify-content:space-between"><b>{channel.language} · {channel.interpreter}</b><span class="pill">{channel.status}{channel.activeBatch ? ` · ${channel.activeBatch}` : ''}</span></div>
              <div class="decorative" style="margin:8px 0"><Progress.Root value={channel.health} max={100} /></div>
              <div style="display:flex;gap:8px"><button class="secondary" onClick$={() => handoff$(channel.id)}>开始交接</button>{channel.status === 'handoff' && <button onClick$={() => completeHandoff$(channel.id, `替补译员-${channel.language}`)}>完成交接</button>}</div>
            </div>
          ))}
          <h3>实时字幕修正</h3>
          {currentSpeech() ? <CaptionForm onSubmit$={publishCaption$}><CaptionField name="text">{(field, props) => <textarea {...props} rows={3} value={field.value} onInput$={(event) => field.value = (event.target as HTMLTextAreaElement).value} placeholder="输入或修正当前字幕" />}</CaptionField><button type="submit">提交新版字幕</button></CaptionForm> : <p>当前没有发言中的代表。</p>}
          {state.captions.filter((caption) => caption.roomId === state.activeRoomId).map((caption) => <div style="margin-top:10px;padding:10px;background:#f1f8f7;border-radius:10px" key={caption.id}><b>{caption.interpreter} · v{caption.revision}</b><p>{caption.text}</p></div>)}
        </aside>
      </section>

      <section class="grid" style="margin-top:18px">
        <article class="panel">
          <h2>指挥流同步</h2>
          <p style="color:#638087;font-size:13px">仅处理{activeRoom().name}的操作 · 待同步 {pendingOps().length} · 冲突 {roomConflicts().length} · 已失效 {supersededOps().length}</p>

          <h3 style="margin-top:14px">待同步操作</h3>
          {pendingOps().length === 0 && <p style="color:#638087;font-size:13px">没有待同步操作。断网期间的操作会在这里列出，重开浏览器仍在。</p>}
          {pendingOps().slice(0, 8).map((op) => (
            <div style="padding:8px 0;border-bottom:1px solid #e6efee;font-size:14px" key={op.opId}>
              <b>{op.opId}</b> <span class="pill">{op.consoleId === state.consoleId ? '本台' : '对端'}</span> {describeOp(op)}
            </div>
          ))}

          <h3 style="margin-top:14px">冲突（两边保留，列出差异）</h3>
          {roomConflicts().length === 0 && <p style="color:#638087;font-size:13px">没有未裁决的冲突。</p>}
          {roomConflicts().map((c) => (
            <div style="padding:10px;margin-top:8px;border:1px solid #e8c9c2;border-radius:10px;background:#fdf6f4" key={c.id}>
              <div style="font-size:13px;color:#b3402f;margin-bottom:6px">{c.kind === 'speech-status' ? `发言 #${c.seq} 状态冲突` : c.kind === 'caption-revise' ? `字幕修订冲突（${c.language}）` : `交接批次冲突（${c.handoffBatch}）`}</div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:13px">
                <div style="padding:8px;background:#fff;border-radius:8px"><b>{c.local.opId}（{c.local.consoleId}）</b><div>{c.local.value}</div></div>
                <div style="padding:8px;background:#fff;border-radius:8px"><b>{c.remote.opId}（{c.remote.consoleId}）</b><div>{c.remote.value}</div></div>
              </div>
              <div style="display:flex;gap:8px;margin-top:8px">
                <button class="secondary" onClick$={() => resolve$(c.id, 'local')}>采用本台</button>
                <button onClick$={() => resolve$(c.id, 'remote')}>采用对端</button>
              </div>
            </div>
          ))}

          <h3 style="margin-top:14px">已失效操作（旧版合并操作）</h3>
          {supersededOps().length === 0 && <p style="color:#638087;font-size:13px">没有失效操作。</p>}
          {supersededOps().slice(0, 8).map((op) => (
            <div style="padding:8px 0;border-bottom:1px solid #e6efee;font-size:14px;color:#8a9799" key={op.opId}>
              <b>{op.opId}</b> {describeOp(op)} <span class="pill">superseded</span>
            </div>
          ))}
        </article>

        <article class="panel">
          <h2>术语库</h2>
          {state.terms.map((term) => <div class="queue-row" key={term.id}><span/><div><b>{term.phrase}</b><div>{term.translation} · {term.language}</div></div><span class="pill">{term.approved ? '已批准' : '待审'}</span><button disabled={term.approved} onClick$={() => approveTerm$(term.id)}>批准</button></div>)}
        </article>
      </section>

      <section class="grid" style="margin-top:18px">
        <article class="panel">
          <h2>操作与交接时间线</h2>
          {state.audits.filter((audit) => audit.roomId === state.activeRoomId).slice(0, 12).map((audit) => <div style="padding:10px 0;border-bottom:1px solid #e6efee" key={audit.id}><small>{new Date(audit.at).toLocaleTimeString()}</small><div>{audit.message}</div></div>)}
        </article>
      </section>
    </main>
  );
});

export const head: DocumentHead = {
  title: '国际会议同声传译控制台',
  meta: [{ name: 'description', content: '发言队列、多语种频道、术语、译员交接与实时字幕修正原型' }]
};
