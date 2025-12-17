<script setup lang="ts">
import { ref, onUnmounted } from 'vue';

// --- 状态变量 ---
const roomId = ref('1234');
const isConnected = ref(false); // WebSocket 连接状态
const p2pStatus = ref('未连接'); // P2P 连接状态
const logs = ref<string[]>([]);
const receivedFileUrl = ref<string | null>(null);
const receivedFileName = ref<string>('');
const uploadProgress = ref(0);
const candidateQueue: RTCIceCandidateInit[] = [];
let isRemoteDescriptionSet = false;

// --- 核心对象 ---
let socket: WebSocket | null = null;
let peerConnection: RTCPeerConnection | null = null;
let dataChannel: RTCDataChannel | null = null;

// 配置 STUN 服务器 (用于穿透 NAT)
const rtcConfig = ref<RTCConfiguration>({
  iceServers: [
    { urls: 'stun:stun.cloudflare.com:3478' },
  ],
  bundlePolicy: 'max-bundle',
  iceTransportPolicy: 'all'
});

const fetchTurnCredentials = async () => {
  try {
    log('正在获取 TURN 中继服务器配置...');
    // 注意：如果是本地开发，确保 URL 指向你的 Worker 地址
    const response = await fetch('/api/turn', { method: 'POST' });
    const data = await response.json();
    
    // Cloudflare 返回的 iceServers 包含 TURN over UDP, TCP, TLS 等完整配置
    if (data.iceServers) {
      rtcConfig.value.iceServers = data.iceServers;
      log('✅ 成功获取 TURN 凭证 (解决 IPv4/IPv6 互通)');
    }
  } catch (e) {
    log('⚠️ 获取 TURN 凭证失败，将仅使用 STUN (可能会失败)');
    console.error(e);
  }
};

// --- 1. WebSocket 信令部分 ---
const joinRoom = async () => {
  // 注意：本地开发通常是 ws://localhost:8787，生产环境是 wss://your-worker.dev
  // 这里假设你本地开启了 worker dev
  await fetchTurnCredentials();
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  // 假设 Worker 运行在 8787 端口 (如果你是混合开发，请改为实际 Worker 地址)
  const workerHost = 'file-sharing.yyfll.eu.org'; 
  
  socket = new WebSocket(`${wsProtocol}//${workerHost}/api/room?id=${roomId.value}`);

  socket.onopen = () => {
    isConnected.value = true;
    log('WebSocket 已连接，等待对方...');
    setupPeerConnection(); // 建立连接的基础
  };

  socket.onmessage = async (event) => {
    const msg = JSON.parse(event.data);
    handleSignalingMessage(msg);
  };
};

// --- 2. WebRTC 核心逻辑 ---
const setupPeerConnection = () => {
  peerConnection = new RTCPeerConnection(rtcConfig.value);
  isRemoteDescriptionSet = false; // <--- 重置
  candidateQueue.length = 0;

  peerConnection.oniceconnectionstatechange = () => {
    const state = peerConnection?.iceConnectionState;
    log(`ICE 连接状态变更: ${state}`);
    if (state === 'failed') {
      log('提示: 连接失败可能是因为防火墙或同一局域网内的 mDNS 问题。');
      // 这里可以尝试 peerConnection.restartIce() 但对初学者比较复杂
    }
  };

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
  };

  // C. 监听对方发来的数据通道 (接收端逻辑)
  peerConnection.ondatachannel = (event) => {
    const receiveChannel = event.channel;
    setupDataChannel(receiveChannel);
  };
};

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
  
  channel.onopen = () => log('P2P 数据通道已打开！可以直接传输文件了');
  
  // 接收文件逻辑 (简化版：假设一次性传完，大文件需要分片)
  let receivedBuffers: ArrayBuffer[] = [];
  
  channel.onmessage = (event) => {
    const data = event.data;
    // 如果是字符串，可能是元数据（文件名）
    if (typeof data === 'string') {
      try {
        const meta = JSON.parse(data);
        if (meta.fileName) receivedFileName.value = meta.fileName;
        log(`准备接收文件: ${meta.fileName}`);
      } catch (e) { log('收到消息: ' + data); }
    } 
    // 如果是二进制，就是文件内容
    else {
      receivedBuffers.push(data);
      // 简单处理：收到数据就生成下载链接 (实际应判断是否接收完毕)
      const blob = new Blob(receivedBuffers);
      receivedFileUrl.value = URL.createObjectURL(blob);
      log(`文件接收完成，大小: ${blob.size} bytes`);
      receivedBuffers = []; // 清空缓存
    }
  };
};

const sendFile = async (event: Event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file || !dataChannel || dataChannel.readyState !== 'open') return;

  // 1. 先发文件名
  dataChannel.send(JSON.stringify({ fileName: file.name }));
  
  // 2. 发送文件内容
  const arrayBuffer = await file.arrayBuffer();
  dataChannel.send(arrayBuffer);
  log(`文件已发送: ${file.name}`);
};

// 日志辅助
const log = (msg: string) => logs.value.push(msg);

// 清理
onUnmounted(() => {
  socket?.close();
  peerConnection?.close();
});
</script>

<template>
  <div class="container">
    <h1>WebRTC P2P 文件分享</h1>
    
    <div class="control-panel">
      <input v-model="roomId" placeholder="输入房间号 (例如 1234)" />
      <button @click="joinRoom" :disabled="isConnected">1. 进入房间</button>
      <button @click="startCall" :disabled="!isConnected">2. 发起连接 (仅一方点击)</button>
    </div>

    <div class="status-box">
      <p>WebSocket: {{ isConnected ? '✅ 在线' : '❌ 离线' }}</p>
      <p>P2P 状态: <strong>{{ p2pStatus }}</strong></p>
    </div>

    <div v-if="p2pStatus === 'connected'" class="upload-area">
      <h3>发送文件</h3>
      <input type="file" @change="sendFile" />
    </div>

    <div v-if="receivedFileUrl" class="download-area">
      <h3>收到文件</h3>
      <a :href="receivedFileUrl" :download="receivedFileName">点击下载 {{ receivedFileName }}</a>
    </div>

    <div class="logs">
      <div v-for="(l, i) in logs" :key="i">{{ l }}</div>
    </div>
  </div>
</template>

<style scoped>
.container { max-width: 600px; margin: 0 auto; padding: 20px; font-family: sans-serif; }
.control-panel { display: flex; gap: 10px; margin-bottom: 20px; }
.status-box { background: #f0f0f0; padding: 10px; border-radius: 8px; margin-bottom: 20px; }
.logs { background: #333; color: #0f0; padding: 10px; height: 200px; overflow-y: auto; font-size: 12px; border-radius: 4px;}
.upload-area, .download-area { border: 2px dashed #ccc; padding: 20px; margin-bottom: 20px; text-align: center; }
</style>