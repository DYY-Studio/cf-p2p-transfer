<script setup lang="ts">
import { ref, onUnmounted } from 'vue';
import streamSaver from 'streamsaver';
import VueTurnstile from 'vue-turnstile'; 

// --- Cloudflare 配置 ---
const workerHost = 'file-sharing.yyfll.eu.org'; 

// --- Turnstile 状态 ---
const turnstileToken = ref('');
const siteKey = '0x4AAAAAACHLVZIn1HqZuXAa';

// --- 状态变量 ---
const roomId = ref('1234');
const isConnected = ref(false); // WebSocket 连接状态
const p2pStatus = ref('disconnected'); // P2P 连接状态
const logs = ref<string[]>([]);
const saverMethod = ref('StreamSaver');
const inputFile = ref<File>();

// --- 文件传输状态 ---
const transferProgress = ref(0);
const transferStatus = ref(''); // 例如: "正在发送 45%", "正在接收..."
const receivedFileUrl = ref<string | null>(null);
const receivedFileName = ref('');

// --- 核心对象 ---
let socket: WebSocket | null = null;
let peerConnection: RTCPeerConnection | null = null;
let dataChannel: RTCDataChannel | null = null;
const candidateQueue: RTCIceCandidateInit[] = [];
let isRemoteDescriptionSet = false;

// --- 接收端缓存变量 ---
let receivedChunks: Blob[] = []; // 暂存收到的切片
let fileWriter: WritableStreamDefaultWriter | null = null; //用于写入硬盘的笔
let receivingMeta: { name: string; size: number; type: string } | null = null;
let receivedBytes = 0;

// --- 角色控制变量 ---
const myRole = ref<'host' | 'guest' | ''>('');
const isPendingApproval = ref(false); // Guest 是否在等
const pendingGuest = ref<{ name: string; id: number } | null>(null);

// --- 常量配置 ---
const CHUNK_SIZE = 16 * 1024; // 16KB (WebRTC 推荐的安全分片大小)
const MAX_BUFFERED_AMOUNT = 64 * 1024; // 64KB (背压阈值，超过就暂停发送)

// 配置 STUN 服务器 (用于穿透 NAT)
const rtcConfig = ref<RTCConfiguration>({
  iceServers: [
    { urls: 'stun:stun.cloudflare.com:3478' },
  ],
  bundlePolicy: 'max-bundle',
  iceTransportPolicy: 'all'
});

// 验证过期或失败的回调
const onTurnstileExpire = () => {
  turnstileToken.value = ''; // 清空 token，迫使重新验证
};

const onTurnstileVerify = (token: string) => {
  log('人机验证通过');
  turnstileToken.value = token;
};

// --- 修改后的获取凭证函数 ---
const fetchTurnCredentials = async () => {
  // 1. 检查是否完成了验证
  if (!turnstileToken.value) {
    alert("请等待人机验证完成，或手动点击验证框。");
    return;
  }

  log('正在获取 TURN 凭证...');
  try {
    // 2. 发送 POST 请求，带上 token
    const res = await fetch('/api/turn', { 
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ 
        token: turnstileToken.value // <--- 关键：发送 Token 给后端
      }) 
    });

    if (!res.ok) {
      throw new Error('验证失败或服务器拒绝');
    }

    const data = await res.json();
    if (data.iceServers) {
      rtcConfig.value.iceServers = data.iceServers;
      log('TURN 凭证获取成功');
    }
  } catch (e) {
    log('获取 TURN 凭证被拒绝 (人机验证失败?)');
    console.error(e);
    // 验证失败后，通常需要重置验证码
    turnstileToken.value = ''; 
  }
};

// --- 1. WebSocket 信令部分 ---
const joinRoom = async () => {
  await fetchTurnCredentials();
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  
  socket = new WebSocket(`${wsProtocol}//${workerHost}/api/room?id=${roomId.value}`);

  socket.onopen = () => {
    isConnected.value = true;
    log('WebSocket 已连接，等待对方...');
    setupPeerConnection(); // 建立连接的基础
  };

  socket.onmessage = async (event) => {
    const msg = JSON.parse(event.data);
    handleSocketMessage(msg);
  };

  socket.onclose = (event) => {
    isConnected.value = false;
    log(`WebSocket 已关闭，原因: ${event.reason}`);
  }

  socket.onerror = (event) => {
    isConnected.value = false;
    log(`WebSocket 发生错误，已断开连接`);
  }
};

// --- 2. WebRTC 核心逻辑 ---
const setupPeerConnection = () => {
  peerConnection = new RTCPeerConnection(rtcConfig.value);
  isRemoteDescriptionSet = false; // <--- 重置
  candidateQueue.length = 0;

  // A. 监听 ICE 候选 (网络路径发现)
  peerConnection.onicecandidate = (event) => {
    // 核心修复：必须判断 event.candidate 是否存在
    // 当 candidate 为 null 时，表示收集结束，Firefox 不喜欢接收 null
    if (event.candidate && socket) {
      const c = event.candidate.candidate;
      log(`收集到 Candidate: ${c.split(' ')[4]} (${c.split(' ')[2]})`);
      socket.send(JSON.stringify({ 
        type: 'candidate', 
        candidate: event.candidate 
      }));
    } else {
      // 这里是收集结束的信号，通常不需要发给对方，或者需要特殊处理
      log('本端 Candidate 收集完毕');
    }
  };

  // B. 监听连接状态变化
  peerConnection.onconnectionstatechange = () => {
    p2pStatus.value = peerConnection?.connectionState || 'unknown';
    log(`ICE 连接状态变更: ${p2pStatus.value}`);
  };

  // C. 监听对方发来的数据通道 (接收端逻辑)
  peerConnection.ondatachannel = (event) => {
    log('收到数据通道请求');
    const receiveChannel = event.channel;
    setupDataChannel(receiveChannel);
  };
};

const handleSocketMessage = (msg: any) => {
    // 1. 角色分配
    if (msg.type === 'role') {
        myRole.value = msg.role;
        log(`我的角色: ${msg.role === 'host' ? '房主 (Host)' : '访客 (Guest)'}`);
        
        if (msg.role === 'guest') {
            // 如果是访客，进房立刻敲门
            isPendingApproval.value = true;
            socket?.send(JSON.stringify({ type: 'join_request' }));
            log('已发送加入申请，等待房主通过...');
        } else {
            // 如果是房主，直接显示 P2P 准备就绪
            isConnected.value = true;
        }
    }

    // 2. 房主收到请求
    else if (msg.type === 'join_request') {
        // 弹窗显示
        pendingGuest.value = { name: msg.deviceName, id: msg.guestId };
    }

    // 3. 访客收到许可
    else if (msg.type === 'join_approve') {
        isPendingApproval.value = false;
        isConnected.value = true; // 此时才算真正“入房”成功
        log('房主已同意！正在建立 P2P 连接...');
        
        // 访客作为后入者，通常不需要主动发起 Offer，
        // 但为了保险，我们可以约定由 Guest 发起，或者由 Host 发起。
        // 这里沿用之前的逻辑：如果你希望谁主动都行，现在双方都具备资格了。
    }
    
    // 4. 访客被拒绝
    else if (msg.type === 'join_reject') {
        alert('房主拒绝了您的加入请求。');
        location.reload();
    }

    // 5. 正常的 WebRTC 信令
    else {
        handleSignalingMessage(msg);
    }
}

// 处理信令消息 (Offer, Answer, Candidate)
const handleSignalingMessage = async (msg: any) => {
  if (!peerConnection) return;

  try {
    if (msg.type === 'offer') {
      // 收到发起请求，我是接收方
      log('收到 Offer，准备应答...');
      await peerConnection.setRemoteDescription(new RTCSessionDescription(msg.sdp));

      isRemoteDescriptionSet = true;
      processCandidateQueue();

      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      socket?.send(JSON.stringify({ type: 'answer', sdp: answer }));
      log('Answer 已发送');
      
    } else if (msg.type === 'answer') {
      // 收到应答，我是发起方
      log('收到 Answer，握手完成');
      await peerConnection.setRemoteDescription(new RTCSessionDescription(msg.sdp));

      isRemoteDescriptionSet = true;
      processCandidateQueue();
      
    } else if (msg.type === 'candidate') {
      // 收到网络路径候选
      const candidate = msg.candidate;
      if (!candidate) return;

      try {
        const iceCandidate = new RTCIceCandidate(candidate);
        
        if (isRemoteDescriptionSet) {
          await peerConnection.addIceCandidate(iceCandidate);
          log('已添加 Candidate');
        } else {
          candidateQueue.push(candidate);
          log('Candidate 已暂存队列');
        }
      } catch (e) {
        // 核心修复：捕获并忽略单个 Candidate 的错误，防止整个连接崩溃
        console.warn('添加 Candidate 失败 (可能是非标准格式，已忽略):', e);
      }
    }
  } catch (e) {
    log('信令处理错误: ' + e);
    console.error(e);
  }
};

const processCandidateQueue = async () => {
  log(`处理积压的 ${candidateQueue.length} 个 Candidate...`);
  for (const candidate of candidateQueue) {
    try {
      // 这里的 candidate 是纯对象，需要转换
      await peerConnection?.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.warn('队列 Candidate 添加失败:', e);
    }
  }
  candidateQueue.length = 0;
};

// --- 3. 发起连接 (发起方逻辑) ---
const startCall = async () => {
  if (!peerConnection) return;
  
  // 创建数据通道 (仅发起方需要主动创建)
  dataChannel = peerConnection.createDataChannel("file-transfer");
  setupDataChannel(dataChannel);

  // 创建 Offer
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  socket?.send(JSON.stringify({ type: 'offer', sdp: offer }));
  log('已发送 Offer，等待对方...');
};

// --- 4. 数据通道与文件传输 ---
const setupDataChannel = (channel: RTCDataChannel) => {
  dataChannel = channel;
  dataChannel.binaryType = 'arraybuffer';
  
  channel.onopen = () => {
    log('P2P 数据通道已打开！可以直接传输文件了');
    p2pStatus.value = 'connected';
  };
  
  switch (saverMethod.value) {
    case "blob":
      log('使用In-Memory方式保存文件');
      channel.onmessage = handleDataMessageBlobArray;
      break;
    case "StreamSaver":
      log('使用StreamSaver保存文件');
      channel.onmessage = handleDataMessage;
      break;
    default:
      channel.onmessage = handleDataMessage;
  }
};

// --- A. 接收端逻辑：流式写入 (Modern) ---
const handleDataMessage = async (event: MessageEvent) => {
  const data = event.data;

  // 1. 处理控制信令 (Metadata / EOF)
  if (typeof data === 'string') {
    const msg = JSON.parse(data);

    if (msg.type === 'meta') {
      // [新增] 收到元数据，立即触发浏览器的“保存文件”对话框
      log(`开始接收文件流: ${msg.name}`);
      receivingMeta = msg;
      receivedBytes = 0;
      transferStatus.value = `正在下载: ${msg.name}`;

      // --- 核心变化点：创建文件流 ---
      //这一步会让浏览器立刻弹出下载任务，或者在底部显示“正在下载...”
      const fileStream = streamSaver.createWriteStream(msg.name, {
        size: msg.size // 告诉浏览器文件总大小，这样浏览器能显示准确的进度条
      });
      
      // 获取 writer (写入器)
      fileWriter = fileStream.getWriter();
    } 
    else if (msg.type === 'eof') {
      // [新增] 传输结束，关闭流
      if (fileWriter) {
        await fileWriter.close();
        fileWriter = null;
      }
      
      receivingMeta = null;
      transferStatus.value = '下载完成！';
      log(`文件写入完毕。`);
      // 注意：流式下载完成后，文件已经躺在用户的“下载”文件夹里了，
      // 不需要再生成 receivedFileUrl 供用户点击。
    }
  } 
  // 2. 处理文件切片 (ArrayBuffer)
  else if (data instanceof ArrayBuffer) {
    if (!fileWriter || !receivingMeta) return;

    // --- 核心变化点：直接写入硬盘 ---
    // Streams API 需要 Uint8Array，而不是 Blob
    // 这一步是异步的，但通常很快。
    // 在极高速网络下，这里其实也应该做背压控制(await writer.ready)，
    // 但 StreamSaver 内部处理了部分缓冲。
    await fileWriter.write(new Uint8Array(data));

    receivedBytes += data.byteLength;

    // 更新 UI 进度
    const percent = Math.floor((receivedBytes / receivingMeta.size) * 100);
    transferProgress.value = percent;
  }
};

// --- A. 接收端逻辑：状态机 ---
// 传统的BlobArray In-Memory形式接收
const handleDataMessageBlobArray = (event: MessageEvent) => {
  const data = event.data;

  // 1. 如果是字符串，说明是控制信令（元数据 或 结束标记）
  if (typeof data === 'string') {
    const msg = JSON.parse(data);

    if (msg.type === 'meta') {
      // 开始新文件传输
      receivingMeta = msg;
      receivedChunks = [];
      receivedBytes = 0;
      receivedFileUrl.value = null;
      transferStatus.value = `正在接收: ${msg.name}`;
      log(`开始接收文件: ${msg.name} (${formatSize(msg.size)})`);
    } 
    else if (msg.type === 'eof') {
      // 文件传输结束，开始组装
      if (!receivingMeta) return;
      const fileBlob = new Blob(receivedChunks, { type: receivingMeta.type });
      receivedFileUrl.value = URL.createObjectURL(fileBlob);
      receivedFileName.value = receivingMeta.name;
      transferStatus.value = '接收完成！';
      log(`文件接收完成。`);
      
      // 清理内存
      receivedChunks = [];
      receivingMeta = null;
    }
  } 
  // 2. 如果是 ArrayBuffer，说明是文件切片
  else if (data instanceof ArrayBuffer) {
    if (!receivingMeta) return;

    // 存入 Blob 数组 (比纯 ArrayBuffer 省一点内存)
    receivedChunks.push(new Blob([data]));
    receivedBytes += data.byteLength;

    // 更新进度条
    const percent = Math.floor((receivedBytes / receivingMeta.size) * 100);
    transferProgress.value = percent;
  }
};

const onFileInputChange = async (event: Event) => {
  const input = event.target as HTMLInputElement;
  inputFile.value = input.files?.[0];
}

// --- B. 发送端逻辑：切片 + 背压 ---
const sendFile = async () => {
  const file = inputFile.value;
  if (!file || !dataChannel || dataChannel.readyState !== 'open') return;

  // 重置状态
  transferProgress.value = 0;
  transferStatus.value = `准备发送: ${file.name}`;
  log(`开始发送文件: ${file.name}`);

  // 1. 发送元数据 (Metadata)
  dataChannel.send(JSON.stringify({
    type: 'meta',
    name: file.name,
    size: file.size,
    mime: file.type
  }));

  // 2. 切片发送循环
  let offset = 0;
  
  while (offset < file.size) {
    // 检查背压：如果缓冲区满了，暂停一下
    // 这一步至关重要，否则会把浏览器内存撑爆或导致连接断开
    while (dataChannel.bufferedAmount > MAX_BUFFERED_AMOUNT) {
      await new Promise(resolve => setTimeout(resolve, 10)); // 等待 10ms
    }

    // 切片
    const chunk = file.slice(offset, offset + CHUNK_SIZE);
    const buffer = await chunk.arrayBuffer(); // 将 Blob 转为 ArrayBuffer

    // 发送
    dataChannel.send(buffer);

    // 移动指针
    offset += CHUNK_SIZE;

    // 更新 UI
    const percent = Math.min(100, Math.floor((offset / file.size) * 100));
    transferProgress.value = percent;
    transferStatus.value = `发送中... ${percent}%`;
  }

  // 3. 发送结束标记 (EOF)
  // 再次检查缓冲区，确保最后的数据发出去后再发 EOF
  while (dataChannel.bufferedAmount > 0) {
      await new Promise(resolve => setTimeout(resolve, 10));
  }
  dataChannel.send(JSON.stringify({ type: 'eof' }));
  
  transferStatus.value = '发送完成！';
  log('文件发送完毕');
};

const onChangeSaveMethod = async (event: Event) => {
  const select = event.target as HTMLSelectElement;
  saverMethod.value = select.value;
}

// --- 房主操作函数 ---
const approveGuest = () => {
    if (!socket || !pendingGuest.value) return;
    socket.send(JSON.stringify({ 
        type: 'join_approve', 
        guestId: pendingGuest.value.id 
    }));
    log(`已允许 ${pendingGuest.value.name} 加入`);
    pendingGuest.value = null;
    
    // 房主主动发起连接 (优化体验)
    startCall(); 
};

const rejectGuest = () => {
    if (!socket || !pendingGuest.value) return;
    socket.send(JSON.stringify({ 
        type: 'join_reject', 
        guestId: pendingGuest.value.id 
    }));
    pendingGuest.value = null;
};

// --- 辅助工具 ---
const log = (msg: string) => logs.value.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
const formatSize = (bytes: number) => {
  if (bytes === 0) return '0 B';
  const k = 1024, sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

// 清理
onUnmounted(async () => {
  if (fileWriter) {
    try {
      await fileWriter.abort("User closed page"); // 中断下载
    } catch (e) { /* ignore */ }
  }
  socket?.close();
  peerConnection?.close();
});
</script>

<template>
  <div class="container">
    <h1>WebRTC P2P 文件传输 (分片版)</h1>

    <div v-if="isPendingApproval" class="modal-overlay">
      <div class="modal">
        <h3>🚪 请求连接...</h3>
        <p>正在等待房主允许您加入房间。</p>
        <div class="spinner"></div>
      </div>
    </div>

    <div v-if="pendingGuest" class="modal-overlay">
      <div class="modal">
        <h3>🔔 新设备请求连接</h3>
        <p><strong>{{ pendingGuest.name }}</strong></p>
        <p>房间号码: {{ roomId }}</p>
        <div class="modal-actions">
          <button @click="rejectGuest" class="btn-reject">拒绝</button>
          <button @click="approveGuest" class="btn-approve">允许加入</button>
        </div>
      </div>
    </div>
    
    <div class="box control-box">
      <input v-model="roomId" placeholder="输入房间号" class="input-room"/>
      <div class="buttons">
        <button @click="joinRoom" :disabled="isConnected">1. 进入房间</button>
        <!-- <button @click="startCall" :disabled="!isConnected || p2pStatus === 'connected'">2. 发起连接</button> -->
        <button @click="sendFile" :disabled="!inputFile || !isConnected || p2pStatus !== 'connected'">2. 开始传输</button>
      </div>
      <div class="status">
        <p>WebSocket: {{ isConnected ? '✅' : '❌' }}</p>
        <p>P2P: <strong>{{ p2pStatus }}</strong></p>
      </div>
      <div>
        <span>文件接收方式</span>
        <select @change="onChangeSaveMethod">
          <option value="StreamSaver">StreamSaver</option>
          <option value="blob">Blob (In-Memory)</option>
        </select>
      </div>
      <div v-if="!isConnected && !turnstileToken" class="turnstile-wrapper">
        <vue-turnstile :site-key="siteKey" :model-value="turnstileToken" @update:model-value="onTurnstileVerify" @expire="onTurnstileExpire"/>
      </div>
    </div>

    <div v-if="isConnected && p2pStatus === 'connected'" class="box transfer-box">
      <h3>文件操作</h3>
      
      <input type="file" class="file-input" @change="onFileInputChange" />
      
      <div v-if="transferStatus" class="progress-section">
        <p>{{ transferStatus }}</p>
        <div class="progress-bar">
          <div class="progress-fill" :style="{ width: transferProgress + '%' }"></div>
        </div>
      </div>

      <div v-if="receivedFileUrl" class="download-section">
        <p>✅ 收到文件:</p>
        <a :href="receivedFileUrl" :download="receivedFileName" class="download-btn">
          下载 {{ receivedFileName }}
        </a>
      </div>
    </div>

    <div class="logs">
      <div v-for="(l, i) in logs" :key="i">{{ l }}</div>
    </div>
  </div>
</template>

<style scoped>
.container { max-width: 600px; margin: 0 auto; padding: 20px; font-family: sans-serif; }
.box { border: 1px solid #ddd; padding: 15px; border-radius: 8px; margin-bottom: 20px; background: #f9f9f9; }
.input-room { padding: 8px; width: 100px; margin-right: 10px; }
.buttons button { padding: 8px 15px; margin-right: 10px; cursor: pointer; }
.status { margin-top: 10px; font-size: 0.9em; color: #666; }
.progress-bar { width: 100%; height: 10px; background: #ddd; border-radius: 5px; overflow: hidden; margin-top: 5px; }
.progress-fill { height: 100%; background: #4caf50; transition: width 0.2s; }
.download-btn { display: inline-block; padding: 10px 20px; background: #2196f3; color: white; text-decoration: none; border-radius: 4px; margin-top: 10px; }
.logs { background: #222; color: #0f0; padding: 10px; height: 150px; overflow-y: auto; font-size: 12px; font-family: monospace; border-radius: 4px; }
.turnstile-wrapper {
  margin-bottom: 15px;
  display: flex;
  justify-content: center; /* 居中显示 */
}
.join-actions {
  display: flex;
  justify-content: center;
}
.modal-overlay {
  position: fixed; top: 0; left: 0; width: 100%; height: 100%;
  background: rgba(0,0,0,0.5);
  display: flex; justify-content: center; align-items: center;
  z-index: 1000;
}
.modal {
  background: white; padding: 25px; border-radius: 12px;
  text-align: center; box-shadow: 0 4px 12px rgba(0,0,0,0.2);
  min-width: 300px;
}
.modal-actions {
  display: flex; gap: 15px; justify-content: center; margin-top: 20px;
}
.btn-approve { background: #4caf50; color: white; border: none; }
.btn-reject { background: #ff5252; color: white; border: none; }
</style>