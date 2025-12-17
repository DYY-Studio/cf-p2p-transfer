<script setup lang="ts">
import { ref, onUnmounted, computed } from 'vue';
import streamSaver from 'streamsaver';
import VueTurnstile from 'vue-turnstile';
// 引入 Naive UI 组件库
import { 
  NConfigProvider, NGlobalStyle, NCard, NInput, NButton, NSpace, 
  NProgress, NTag, NLog, NModal, NGrid, NGi, NStatistic, NIcon,
  useOsTheme, darkTheme, NMessageProvider, useMessage, NAlert, NDivider
} from 'naive-ui';
// 引入图标 (需要 npm install @vicons/ionicons5)
// 如果没安装图标库，可以把 template 里的 <n-icon> 部分删掉，不影响功能
import { CloudUploadOutline, CloudDownloadOutline, LogInOutline, DocumentAttachOutline, Refresh } from '@vicons/ionicons5';

// --- UI 主题配置 ---
const osTheme = useOsTheme();
const theme = computed(() => (osTheme.value === 'dark' ? darkTheme : null));

// 为了在 setup 中使用 message，我们需要包裹一个内部组件，或者简单地在这里定义一个占位符
// 在实际项目中，建议将逻辑拆分，这里为了单文件运行，我们使用 ref 绑定 message
const messageRef = ref<any>(null); // Hack: 获取 message 实例

// --- Cloudflare 配置 ---
const workerHost = 'file-sharing.yyfll.eu.org'; 

// --- Turnstile 状态 ---
const turnstileToken = ref('');
const siteKey = '0x4AAAAAACHLVZIn1HqZuXAa';

// --- 状态变量 ---
const roomId = ref('1234');
const isConnected = ref(false); 
const p2pStatus = ref('disconnected'); 
const logs = ref<string>(''); // 改为字符串以便 NLog 使用
const saverMethod = ref('StreamSaver');
const inputFile = ref<File | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);

// --- UI 交互状态 ---
const isJoining = ref(false); // 防止重复点击连接
const showLogModal = ref(false); // 移动端日志折叠

// --- 文件传输状态 ---
const transferProgress = ref(0);
const transferStatus = ref(''); 
const receivedFileUrl = ref<string | null>(null);
const receivedFileName = ref('');

// --- 核心对象 ---
let socket: WebSocket | null = null;
let peerConnection: RTCPeerConnection | null = null;
let dataChannel: RTCDataChannel | null = null;
const candidateQueue: RTCIceCandidateInit[] = [];
let isRemoteDescriptionSet = false;

// --- 接收端缓存变量 ---
let receivedChunks: Blob[] = []; 
let fileWriter: WritableStreamDefaultWriter | null = null; 
let receivingMeta: { name: string; size: number; type: string } | null = null;
let receivedBytes = 0;

// --- 角色控制变量 ---
const myRole = ref<'host' | 'guest' | ''>('');
const isPendingApproval = ref(false); 
const pendingGuest = ref<{ name: string; id: number } | null>(null);

// --- 常量配置 ---
const CHUNK_SIZE = 16 * 1024; 
const MAX_BUFFERED_AMOUNT = 64 * 1024; 

const rtcConfig = ref<RTCConfiguration>({
  iceServers: [
    { urls: 'stun:stun.cloudflare.com:3478' },
  ],
  bundlePolicy: 'max-bundle',
  iceTransportPolicy: 'all'
});

// --- 辅助函数 ---
const log = (msg: string) => {
  const time = new Date().toLocaleTimeString();
  logs.value += `[${time}] ${msg}\n`;
};

const notify = (type: 'success' | 'error' | 'warning' | 'info', content: string) => {
    if(messageRef.value) {
        messageRef.value[type](content);
    } else {
        console.log(`[${type.toUpperCase()}] ${content}`);
    }
}

// --- 逻辑部分 ---

const onTurnstileExpire = () => {
  turnstileToken.value = ''; 
};

const onTurnstileVerify = (token: string) => {
  log('🛡️ 人机验证通过');
  turnstileToken.value = token;
};

const fetchTurnCredentials = async () => {
  if (!turnstileToken.value) {
    notify('warning', "请等待人机验证完成");
    throw new Error("Turnstile token missing");
  }

  log('正在获取 TURN 凭证...');
  try {
    const res = await fetch('/api/turn', { 
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: turnstileToken.value }) 
    });

    if (!res.ok) throw new Error('验证失败或服务器拒绝');

    const data = await res.json();
    if (data.iceServers) {
      rtcConfig.value.iceServers = data.iceServers;
      log('✅ TURN 凭证获取成功');
    }
  } catch (e) {
    log('❌ 获取 TURN 凭证被拒绝');
    turnstileToken.value = '';
    throw e;
  }
};

const joinRoom = async () => {
  if (isJoining.value || isConnected.value) return;
  isJoining.value = true;

  try {
    await fetchTurnCredentials();
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    
    socket = new WebSocket(`${wsProtocol}//${workerHost}/api/room?id=${roomId.value}`);

    socket.onopen = () => {
      isConnected.value = true;
      isJoining.value = false;
      notify('success', '已连接服务器，等待配对...');
      log('WebSocket 已连接');
      setupPeerConnection(); 
    };

    socket.onmessage = async (event) => {
      const msg = JSON.parse(event.data);
      handleSocketMessage(msg);
    };

    socket.onclose = (event) => {
      isConnected.value = false;
      isJoining.value = false;
      p2pStatus.value = 'disconnected';
      log(`WebSocket 已关闭: ${event.reason}`);
      notify('error', '连接已断开');
    }

    socket.onerror = () => {
      isConnected.value = false;
      isJoining.value = false;
      log(`WebSocket 错误`);
      notify('error', '连接发生错误');
    }
  } catch (e) {
    isJoining.value = false;
    notify('error', '无法加入房间，请检查网络或验证码');
  }
};

const setupPeerConnection = () => {
  peerConnection = new RTCPeerConnection(rtcConfig.value);
  isRemoteDescriptionSet = false; 
  candidateQueue.length = 0;

  peerConnection.onicecandidate = (event) => {
    if (event.candidate && socket) {
      socket.send(JSON.stringify({ type: 'candidate', candidate: event.candidate }));
    } else {
      log('本端 Candidate 收集完毕');
    }
  };

  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection?.connectionState || 'unknown';
    p2pStatus.value = state;
    log(`ICE 状态: ${state}`);
    if (state === 'connected') notify('success', 'P2P 通道已建立！');
    if (state === 'disconnected' || state === 'failed') notify('error', 'P2P 连接断开');
  };

  peerConnection.ondatachannel = (event) => {
    log('收到数据通道请求');
    setupDataChannel(event.channel);
  };
};

const handleSocketMessage = (msg: any) => {
    if (msg.type === 'role') {
        myRole.value = msg.role;
        log(`角色分配: ${msg.role === 'host' ? '房主' : '访客'}`);
        if (msg.role === 'guest') {
            isPendingApproval.value = true;
            socket?.send(JSON.stringify({ type: 'join_request' }));
            log('已发送入房申请...');
        } else {
            isConnected.value = true;
        }
    }
    else if (msg.type === 'join_request') {
        pendingGuest.value = { name: msg.deviceName, id: msg.guestId };
    }
    else if (msg.type === 'join_approve') {
        isPendingApproval.value = false;
        isConnected.value = true; 
        notify('success', '房主已同意加入！');
        log('房主同意，建立 P2P 中...');
    }
    else if (msg.type === 'join_reject') {
        notify('error', '房主拒绝了请求');
        setTimeout(() => location.reload(), 2000);
    }
    else {
        handleSignalingMessage(msg);
    }
}

const handleSignalingMessage = async (msg: any) => {
  if (!peerConnection) return;
  try {
    if (msg.type === 'offer') {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      isRemoteDescriptionSet = true;
      processCandidateQueue();
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      socket?.send(JSON.stringify({ type: 'answer', sdp: answer }));
    } else if (msg.type === 'answer') {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      isRemoteDescriptionSet = true;
      processCandidateQueue();
    } else if (msg.type === 'candidate') {
      if (!msg.candidate) return;
      if (isRemoteDescriptionSet) {
        await peerConnection.addIceCandidate(new RTCIceCandidate(msg.candidate));
      } else {
        candidateQueue.push(msg.candidate);
      }
    }
  } catch (e) {
    console.error(e);
  }
};

const processCandidateQueue = async () => {
  for (const candidate of candidateQueue) {
    try { await peerConnection?.addIceCandidate(new RTCIceCandidate(candidate)); } 
    catch (e) { console.warn(e); }
  }
  candidateQueue.length = 0;
};

const startCall = async () => {
  if (!peerConnection) return;
  dataChannel = peerConnection.createDataChannel("file-transfer");
  setupDataChannel(dataChannel);
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  socket?.send(JSON.stringify({ type: 'offer', sdp: offer }));
  log('已发送 Offer');
};

const setupDataChannel = (channel: RTCDataChannel) => {
  dataChannel = channel;
  dataChannel.binaryType = 'arraybuffer';
  channel.onopen = () => {
    p2pStatus.value = 'connected';
  };
  
  if (saverMethod.value === 'blob') {
     channel.onmessage = handleDataMessageBlobArray;
  } else {
     channel.onmessage = handleDataMessage;
  }
};

// --- StreamSaver ---
const handleDataMessage = async (event: MessageEvent) => {
  const data = event.data;
  if (typeof data === 'string') {
    const msg = JSON.parse(data);
    if (msg.type === 'meta') {
      log(`⬇️ 开始下载: ${msg.name}`);
      notify('info', `开始接收: ${msg.name}`);
      receivingMeta = msg;
      receivedBytes = 0;
      transferStatus.value = `正在下载: ${msg.name}`;
      const fileStream = streamSaver.createWriteStream(msg.name, { size: msg.size });
      fileWriter = fileStream.getWriter();
    } else if (msg.type === 'eof') {
      if (fileWriter) { await fileWriter.close(); fileWriter = null; }
      receivingMeta = null;
      transferStatus.value = '下载完成';
      notify('success', '文件下载完成');
      log('⬇️ 文件写入完毕');
    }
  } else if (data instanceof ArrayBuffer) {
    if (!fileWriter || !receivingMeta) return;
    await fileWriter.write(new Uint8Array(data));
    receivedBytes += data.byteLength;
    transferProgress.value = Math.floor((receivedBytes / receivingMeta.size) * 100);
  }
};

// --- Blob ---
const handleDataMessageBlobArray = (event: MessageEvent) => {
  const data = event.data;
  if (typeof data === 'string') {
    const msg = JSON.parse(data);
    if (msg.type === 'meta') {
      receivingMeta = msg;
      receivedChunks = [];
      receivedBytes = 0;
      receivedFileUrl.value = null;
      transferStatus.value = `正在缓存: ${msg.name}`;
      log(`⬇️ 开始接收(内存): ${msg.name}`);
    } else if (msg.type === 'eof') {
      if (!receivingMeta) return;
      const fileBlob = new Blob(receivedChunks, { type: receivingMeta.type });
      receivedFileUrl.value = URL.createObjectURL(fileBlob);
      receivedFileName.value = receivingMeta.name;
      transferStatus.value = '接收完成';
      notify('success', '文件准备就绪，请点击下载');
      receivedChunks = [];
      receivingMeta = null;
    }
  } else if (data instanceof ArrayBuffer) {
    if (!receivingMeta) return;
    receivedChunks.push(new Blob([data]));
    receivedBytes += data.byteLength;
    transferProgress.value = Math.floor((receivedBytes / receivingMeta.size) * 100);
  }
};

const triggerFileSelect = () => {
    fileInputRef.value?.click();
}

const onFileInputChange = async (event: Event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if(file) {
      inputFile.value = file;
      log(`已选择文件: ${file.name} (${formatSize(file.size)})`);
  }
}

const sendFile = async () => {
  const file = inputFile.value;
  if (!file || !dataChannel || dataChannel.readyState !== 'open') return;

  transferProgress.value = 0;
  transferStatus.value = `准备发送: ${file.name}`;
  notify('info', '开始发送文件...');
  log(`⬆️ 开始发送: ${file.name}`);

  try {
      dataChannel.send(JSON.stringify({
        type: 'meta', name: file.name, size: file.size, mime: file.type
      }));

      let offset = 0;
      while (offset < file.size) {
        while (dataChannel.bufferedAmount > MAX_BUFFERED_AMOUNT) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        const chunk = file.slice(offset, offset + CHUNK_SIZE);
        const buffer = await chunk.arrayBuffer();
        dataChannel.send(buffer);
        offset += CHUNK_SIZE;
        transferProgress.value = Math.min(100, Math.floor((offset / file.size) * 100));
        transferStatus.value = "发送中...";
      }

      while (dataChannel.bufferedAmount > 0) {
          await new Promise(resolve => setTimeout(resolve, 10));
      }
      dataChannel.send(JSON.stringify({ type: 'eof' }));
      
      transferStatus.value = '发送完成';
      notify('success', '文件发送成功！');
      log('⬆️ 发送完毕');
  } catch(e) {
      log('发送出错: ' + e);
      notify('error', '发送过程中断');
  }
};

const approveGuest = () => {
    if (!socket || !pendingGuest.value) return;
    socket.send(JSON.stringify({ type: 'join_approve', guestId: pendingGuest.value.id }));
    log(`已允许 ${pendingGuest.value.name} 加入`);
    pendingGuest.value = null;
    startCall(); 
};

const rejectGuest = () => {
    if (!socket || !pendingGuest.value) return;
    socket.send(JSON.stringify({ type: 'join_reject', guestId: pendingGuest.value.id }));
    pendingGuest.value = null;
};

const formatSize = (bytes: number) => {
  if (bytes === 0) return '0 B';
  const k = 1024, sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

onUnmounted(async () => {
  if (fileWriter) {
    try { await fileWriter.abort("User closed page"); } catch (e) { /* ignore */ }
  }
  socket?.close();
  peerConnection?.close();
});

const MessageRegister = {
  setup() {
    messageRef.value = useMessage();
    return () => null;
  }
};
</script>

<template>
  <n-config-provider :theme="theme">
    <n-global-style />
    <n-message-provider>
        <MessageRegister />
        
        <div class="main-layout">
            <n-card class="app-card" size="huge" :bordered="false">
                <template #header>
                    <div class="header-content">
                        <h2>WebRTC 极速传</h2>
                        <n-tag :type="isConnected ? 'success' : 'default'" round>
                            {{ isConnected ? '已联网' : '离线' }}
                        </n-tag>
                    </div>
                </template>

                <n-space vertical size="large">
                    <div class="section">
                        <n-grid x-gap="12" :cols="2">
                            <n-gi :span="2">
                                <n-input 
                                    v-model:value="roomId" 
                                    placeholder="请输入房间号 (例如 1234)" 
                                    size="large"
                                    :disabled="isConnected || isJoining"
                                >
                                    <template #prefix>#</template>
                                </n-input>
                            </n-gi>
                        </n-grid>
                        
                        <div style="margin-top: 15px">
                            <n-button 
                                type="primary" 
                                block 
                                size="large" 
                                :loading="isJoining"
                                :disabled="isConnected"
                                @click="joinRoom"
                            >
                                <template #icon>
                                    <n-icon><log-in-outline /></n-icon>
                                </template>
                                {{ isConnected ? '已在房间中' : '加入 / 创建房间' }}
                            </n-button>
                        </div>
                    </div>

                    <div v-if="!isConnected && !turnstileToken" class="turnstile-container">
                        <vue-turnstile 
                            :site-key="siteKey" 
                            :model-value="turnstileToken" 
                            @update:model-value="onTurnstileVerify" 
                            @expire="onTurnstileExpire"
                        />
                    </div>

                    <n-divider v-if="isConnected" />
                    
                    <div v-if="isConnected">
                        <n-alert :type="p2pStatus === 'connected' ? 'success' : 'warning'" :show-icon="true">
                            <template #header>
                                P2P 连接状态: {{ p2pStatus.toUpperCase() }}
                            </template>
                            {{ p2pStatus === 'connected' ? '通道畅通，可以开始高速传输。' : '正在寻找对方或建立穿透...' }}
                        </n-alert>

                        <div v-if="p2pStatus === 'connected'" class="transfer-zone">
                            <n-grid :cols="1" y-gap="16">
                                <n-gi>
                                    <n-space justify="space-between" align="center">
                                        <span>保存方式:</span>
                                        <n-space>
                                            <n-tag checkable :checked="saverMethod === 'StreamSaver'" @click="saverMethod='StreamSaver'">直接下载 (推荐)</n-tag>
                                            <n-tag checkable :checked="saverMethod === 'blob'" @click="saverMethod='blob'">内存缓存 (兼容)</n-tag>
                                        </n-space>
                                    </n-space>
                                </n-gi>

                                <n-gi>
                                    <input type="file" ref="fileInputRef" style="display: none" @change="onFileInputChange" />
                                    <n-card class="drop-zone" :class="{ 'has-file': !!inputFile }" @click="triggerFileSelect">
                                      <n-space vertical align="center">
                                          <n-icon size="40" color="#888">
                                              <document-attach-outline />
                                          </n-icon>
                                          <div v-if="!inputFile" style="color: #666">点击选择文件</div>
                                          
                                          <div v-else style="max-width: 100%; overflow: hidden; text-align: center; padding: 0 10px;">
                                              <div style="font-weight: bold; font-size: 1.1em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                                                  {{ inputFile.name }}
                                              </div>
                                              <div style="font-size: 0.9em; color: #888">{{ formatSize(inputFile.size) }}</div>
                                          </div>
                                          </n-space>
                                  </n-card>
                                </n-gi>

                                <n-gi>
                                    <n-button 
                                        type="success" 
                                        block 
                                        size="large" 
                                        :disabled="!inputFile || transferStatus.includes('发送中')"
                                        @click="sendFile"
                                    >
                                        <template #icon><n-icon><cloud-upload-outline /></n-icon></template>
                                        开始传输
                                    </n-button>
                                </n-gi>
                            </n-grid>

                            <div v-if="transferStatus" class="progress-area">
                                <div style="display: flex; justify-content: space-between; margin-bottom: 5px;">
                                    <span>{{ transferStatus }}</span>
                                    <!-- <span>{{ transferProgress }}%</span> -->
                                </div>
                                <n-progress 
                                    type="line" 
                                    :percentage="transferProgress" 
                                    :status="transferProgress === 100 ? 'success' : 'default'"
                                    processing
                                />
                            </div>
                            
                            <div v-if="receivedFileUrl" style="margin-top: 15px; text-align: center;">
                                <n-button tag="a" :href="receivedFileUrl" :download="receivedFileName" type="info" ghost>
                                    <template #icon><n-icon><cloud-download-outline /></n-icon></template>
                                    保存 {{ receivedFileName }}
                                </n-button>
                            </div>
                        </div>
                    </div>

                    <n-divider />
                    <n-button size="small" secondary @click="showLogModal = true">查看运行日志</n-button>
                </n-space>
            </n-card>
        </div>

        <n-modal v-model:show="showLogModal" preset="card" title="系统日志" style="width: 90%; max-width: 600px">
            <n-log :log="logs" :rows="15" style="font-family: monospace;" />
        </n-modal>

        <n-modal :show="isPendingApproval" :mask-closable="false">
            <n-card style="width: 300px; text-align: center;" :bordered="false" size="huge">
                <template #header>🚪 敲门中...</template>
                <n-space vertical align="center">
                    <n-icon size="50" color="#f0a020"><refresh class="spin" /></n-icon>
                    <p>正在等待房主允许您加入...</p>
                </n-space>
            </n-card>
        </n-modal>

        <n-modal :show="!!pendingGuest" :mask-closable="false">
            <n-card style="width: 90%; max-width: 400px" title="🔔 新连接请求" :bordered="false" size="huge">
                <p style="font-size: 1.1em; margin-bottom: 20px;">
                    <strong>{{ pendingGuest?.name }}</strong> 请求加入房间 #{{ roomId }}
                </p>
                <n-grid :cols="2" x-gap="12">
                    <n-gi><n-button block type="error" ghost @click="rejectGuest">拒绝</n-button></n-gi>
                    <n-gi><n-button block type="success" @click="approveGuest">允许加入</n-button></n-gi>
                </n-grid>
            </n-card>
        </n-modal>

    </n-message-provider>
  </n-config-provider>
</template>

<style scoped>
.main-layout {
    min-height: 100vh;
    display: flex;
    justify-content: center;
    align-items: center; 
    padding: 20px;
    background-color: v-bind('theme ? "#101014" : "#f0f2f5"');
    transition: background-color 0.3s;
    box-sizing: border-box; 
}

.app-card {
    width: 500px;
    /* max-width: 500px;
    min-width: 320px;  */
    border-radius: 16px;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.05);
    overflow: visible; 
}
.header-content {
    display: flex;
    justify-content: space-between;
    align-items: center;
}
.header-content h2 { margin: 0; font-size: 1.5rem; }

.turnstile-container {
    display: flex;
    justify-content: center;
    margin-top: 10px;
    overflow-x: visible;
}

.drop-zone {
    cursor: pointer;
    border: 2px dashed rgba(128, 128, 128, 0.3);
    background-color: rgba(128, 128, 128, 0.05);
    transition: all 0.2s;
    text-align: center;
}
.drop-zone:hover {
    border-color: #63e2b7; /* Naive UI Green */
    background-color: rgba(99, 226, 183, 0.05);
}
.drop-zone.has-file {
    border-style: solid;
    border-color: #63e2b7;
    background-color: rgba(99, 226, 183, 0.1);
}

.progress-area {
    margin-top: 20px;
    padding: 15px;
    background: rgba(128, 128, 128, 0.05);
    border-radius: 8px;
}

.spin {
    animation: spin 1s linear infinite;
}
@keyframes spin { 100% { transform: rotate(360deg); } }

@media (max-width: 600px) {
    .main-layout {
        padding: 0;
        align-items: flex-start; 
    }
    .app-card {
        border-radius: 0;
        box-shadow: none;
        min-height: 100vh; 
        height: auto;
    }
}
</style>