<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import VueTurnstile from 'vue-turnstile';
import {
  NConfigProvider, NGlobalStyle, NCard, NInput, NButton, NSpace,
  NProgress, NTag, NLog, NModal, NGrid, NGi, NSwitch, NTooltip, NIcon,
  useOsTheme, darkTheme, NMessageProvider, useMessage, NAlert, NDivider, NTabs, NTabPane
} from 'naive-ui';
import { CloudUploadOutline, CloudDownloadOutline, LogInOutline, DocumentAttachOutline, Refresh, FlashOutline } from '@vicons/ionicons5';

import { useRoomConnection } from './composables/useRoomConnection';
import { useFileTransfer } from './composables/useFileTransfer';
import { formatSize } from './utils';

const {
  roomId, isConnected, isJoining, p2pStatus, myRole, logs,
  isPendingApproval, pendingGuest, rtcConfig,
  connectSocket, leaveRoom, approveGuest, rejectGuest, log, setDataChannelCallback
} = useRoomConnection();

const {
  transferProgress, transferStatus, 
  receivedFileUrl, receivedFileName, 
  saverMethod,
  transferSpeed, timeRemaining,
  setupTransferChannel, sendFiles, cancelTransfer
} = useFileTransfer(log);

// --- UI 主题配置 ---
const osTheme = useOsTheme();
const theme = computed(() => (osTheme.value === 'dark' ? darkTheme : null));
const messageRef = ref<any>(null);

// --- Turnstile 状态 ---
const turnstileToken = ref('');
const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY;

// --- 状态变量 ---
const inputFiles = ref<File[]>([]);
const fileInputRef = ref<HTMLInputElement | null>(null);
const folderInputRef = ref<HTMLInputElement | null>(null);
const activeTab = ref('join');

const storedTurn = localStorage.getItem('useTurnServer');
const useTurnServer = ref(storedTurn === 'true');

const storedUseRandomRoomId = localStorage.getItem('useRandomRoomId');
const useRandomRoomId = ref(storedUseRandomRoomId === 'true');

watch(useTurnServer, (newValue) => {
  localStorage.setItem('useTurnServer', String(newValue));
});

watch(useRandomRoomId, (newValue) => {
  localStorage.setItem('useRandomRooId', String(newValue))
})

watch(myRole, (newRole) =>{
  if (activeTab.value === 'join' && newRole === 'host') {
    leaveRoom();
    log('错误：不能加入空房间');
    notify('error', '不能加入空房间');
    isConnected.value = false;
    isJoining.value = false;
  }
})

// --- UI 交互状态 ---
const showLogModal = ref(false); // 移动端日志折叠

setDataChannelCallback((channel) => {
  setupTransferChannel(channel);
  notify('success', 'P2P 数据通道就绪，可以传输文件了！');
});

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

const createAndJoin = () => {
  if (useRandomRoomId.value) {
    roomId.value = Math.floor(100000 + Math.random() * 900000).toString();
  }
  handleJoinRoom();
};

const handleJoinRoom = async () => {
  if (!roomId.value || roomId.value.length < 4) {
    notify('warning', '请输入有效的房间号');
    return;
  }

  // 1. 处理 TURN 配置 (如果开启)
  if (useTurnServer.value) {
    if (!turnstileToken.value) {
      notify('warning', "请等待人机验证完成");
      return;
    }
    try {
      log('正在获取 TURN 凭证...');
      const res = await fetch('/api/turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: turnstileToken.value })
      });
      if (!res.ok) throw new Error('验证失败');
      const data = await res.json();
      
      // 更新 Composable 中的配置
      if (data.iceServers) {
        rtcConfig.value.iceServers = data.iceServers;
        log('✅ TURN 凭证获取成功');
      }
    } catch (e) {
      notify('error', '获取 TURN 凭证失败，将尝试直连');
      turnstileToken.value = ''; // 重置验证码
    }
  } else {
    // 强制使用默认 STUN
    rtcConfig.value.iceServers = [{ urls: 'stun:stun.cloudflare.com:3478' }];
    log('⚠️ 已禁用 TURN 中继，仅使用 STUN');
  }

  // 2. 发起连接
  try {
    connectSocket(roomId.value);
    notify('info', '正在连接服务器...');
  } catch (e) {
    notify('error', '连接失败');
  }
};

const triggerFolderSelect = () => folderInputRef.value?.click();
const triggerFileSelect = () => fileInputRef.value?.click();

const onFileInputChange = (event: Event) => {
  const input = event.target as HTMLInputElement;
  if (input.files && input.files.length > 0) {
    // 将 FileList 转为 Array
    inputFiles.value = Array.from(input.files);
    
    const count = inputFiles.value.length;
    if (!inputFiles.value[0]) return;
    const name = inputFiles.value[0].name;
    const totalSize = inputFiles.value.reduce((a, b) => a + b.size, 0);
    
    if (count === 1) {
        log(`UI: 已选择文件 ${name} (${formatSize(totalSize)})`);
    } else {
        log(`UI: 已选择 ${count} 个文件/文件夹, 总大小 ${formatSize(totalSize)}`);
    }
  } else {
    log(`UI: 没有选择文件`)
  }
};

const handleSendClick = async () => {
  if (inputFiles.value.length === 0) return;
  try {
    await sendFiles(inputFiles.value);
    if (!transferStatus.value.includes('完成')) {
      notify('info', '发送已取消（详见日志）');
    } else {
      notify('success', '发送完成');
    }
  } catch (e) {
    notify('error', '发送失败');
  }
};

const connectionStateText = computed(() => {
    if (isConnected.value) return '在线';
    if (isJoining.value) return '连接中...';
    return '离线';
});

const connectionStateType = computed(() => {
    if (isConnected.value) return 'success';
    if (isJoining.value) return 'warning';
    return 'error';
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
              <h2>CF点对点快传</h2>
              <n-tag :type="connectionStateType" round>
                {{ connectionStateText }}
              </n-tag>
            </div>
          </template>
          
          <n-space vertical size="large">
            <n-input 
            v-model:value="roomId" 
            placeholder="输入对方提供的房间号" 
            size="large"
            :disabled="isConnected || isJoining || (useRandomRoomId && activeTab !== 'join')"
            @keydown.enter="handleJoinRoom"
            >
            <template #prefix>#</template>
          </n-input>
          
          <div class="section">
            
            <n-tabs type="segment" animated v-model:value="activeTab">
              
              <n-tab-pane name="join" tab="加入房间" :disabled="isConnected || isJoining">
                <n-space vertical size="large" style="padding-top: 10px">
                  <n-button 
                    type="primary" 
                    block 
                    size="large" 
                    :loading="isJoining && activeTab === 'join'"
                    :disabled="isConnected"
                    @click="handleJoinRoom"
                  >
                  <template #icon><n-icon><log-in-outline /></n-icon></template>
                  加入房间
                  </n-button>
                </n-space>
              </n-tab-pane>
            
              <n-tab-pane name="create" tab="创建新房间" :disabled="isConnected || isJoining">
                <n-space vertical size="large" style="padding-top: 10px; text-align: center;">
                  <div style="display: flex; justify-content: space-between; align-items: center;">
                    <n-space align="center">
                      <span style="font-size: 0.9em; color: #666">随机生成6位房间号</span>
                    </n-space>
                    
                    <n-switch v-model:value="useRandomRoomId" :disabled="isConnected || isJoining" />
                  </div>
                  
                  <n-button 
                    type="success" 
                    block 
                    size="large" 
                    :loading="isJoining && activeTab === 'create'"
                    :disabled="isConnected"
                    @click="createAndJoin"
                  >
                  <template #icon><n-icon><refresh /></n-icon></template>
                  创建并连接
                  </n-button>
                </n-space>
              </n-tab-pane>
            </n-tabs>
          </div>
        
          <div style="margin-top: 15px; display: flex; justify-content: space-between; align-items: center;">
            <n-space align="center">
              <span style="font-size: 0.9em; color: #666">启用穿透中继 (TURN)</span>
              <n-tooltip trigger="hover">
                <template #trigger><n-icon size="16" color="#999"><help-circle-outline /></n-icon> </template>
                开启后可穿透复杂网络，但需要人机验证并启用Cloudflare TURN服务器。
              </n-tooltip>
            </n-space>
            
            <n-switch v-model:value="useTurnServer" :disabled="isConnected || isJoining" />
          </div>
          
          <div v-if="useTurnServer && !isConnected && !turnstileToken" class="turnstile-container">
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
              <strong>你是本房间的{{ myRole.toUpperCase() }}</strong><br/>
              {{ p2pStatus === 'connected' ? '通道畅通，可以开始高速传输。' : '正在寻找对方或建立穿透...' }}
            </n-alert>
            
            <div v-if="p2pStatus === 'connected'" class="transfer-zone">
              <n-grid :cols="1" y-gap="16">
                <n-gi>
                  <n-space justify="space-between" align="center">
                    <span>保存方式:</span>
                    <n-space>
                      <n-tag checkable :checked="saverMethod === 'StreamSaver'" @click="saverMethod='StreamSaver'" :disabled="transferStatus.startsWith('正在下载')">直接下载 (推荐)</n-tag>
                      <n-tag checkable :checked="saverMethod === 'blob'" @click="saverMethod='blob'" :disabled="transferStatus.startsWith('正在下载')">内存缓存 (兼容)</n-tag>
                    </n-space>
                  </n-space>
                </n-gi>
                
                <n-gi>
                  <input 
                    type="file" 
                    multiple 
                    ref="fileInputRef" 
                    style="display: none" 
                    @change="onFileInputChange" 
                  />
                  
                  <input 
                    type="file" 
                    webkitdirectory 
                    ref="folderInputRef" 
                    style="display: none" 
                    @change="onFileInputChange" 
                  />
                  
                  <n-card class="drop-zone" :class="{ 'has-file': inputFiles.length > 0 }">
                    <n-space vertical align="center">
                      <n-icon size="40" color="#888">
                        <document-attach-outline />
                      </n-icon>
                      <div v-if="inputFiles.length === 0">
                        <n-space>
                          <n-button dashed size="small" @click="triggerFileSelect">选择文件 (可多选)</n-button>
                          <n-button dashed size="small" @click="triggerFolderSelect">选择文件夹</n-button>
                        </n-space>
                      </div>
                      
                      <div v-else style="text-align: center;">
                        <div style="font-weight: bold; font-size: 1.1em;">
                          <span v-if="inputFiles.length === 1">{{ inputFiles[0]!.name }}</span>
                          <span v-else>已选择 {{ inputFiles.length }} 个文件</span>
                        </div>
                        <div style="font-size: 0.9em; color: #888">
                          总大小: {{ formatSize(inputFiles.reduce((a,b)=>a+b.size, 0)) }}
                        </div>
                        <n-button text type="error" size="tiny" @click="inputFiles = []" style="margin-top:5px">
                          清除重新选择
                        </n-button>
                      </div>
                    </n-space>
                  </n-card>
                </n-gi>
                
                <n-gi>
                  <n-button
                    type="success"
                    block
                    size="large"
                    :disabled="inputFiles.length === 0 || transferStatus.includes('发送中')"
                    @click="handleSendClick"
                  >
                  <template #icon><n-icon><cloud-upload-outline /></n-icon></template>
                  开始传输
                  </n-button>
                </n-gi>
              </n-grid>
            
              <div v-if="transferStatus" class="progress-area">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px;">
                  <n-button 
                    v-if="transferProgress < 100 && !transferStatus.includes('完成') && !transferStatus.includes('中断')" 
                    size="tiny" 
                    type="error" 
                    secondary
                    @click="cancelTransfer"
                  >
                  取消
                  </n-button>
                </div>
                <div style="display: flex; justify-content: space-between; margin-bottom: 5px;">
                  <span>{{ transferStatus }}</span>
                </div>
                <span v-if="transferProgress > 0 && transferProgress < 100" style="font-size: 0.9em; color: #666">
                  <n-icon style="vertical-align: -2px"><flash-outline /></n-icon> 
                  {{ transferSpeed }} · 剩余 {{ timeRemaining }}
                </span>
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
        <p style="font-size: 1.1em; margin-bottom: 20px;"><strong>{{ pendingGuest?.name }}</strong></p>
        <p style="font-size: 1.1em; margin-bottom: 20px;">请求加入房间 #{{ roomId }}</p>
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