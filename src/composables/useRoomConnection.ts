import { ref, onUnmounted } from 'vue';

const WORKER_HOST = 'file-sharing.yyfll.eu.org';

export function useRoomConnection() {
  // --- 状态定义 ---
  const roomId = ref('1234');
  const isConnected = ref(false); // WebSocket 连接状态
  const isJoining = ref(false);
  const p2pStatus = ref<'disconnected' | 'new' | 'connecting' | 'connected' | 'failed'>('disconnected'); // P2P 状态
  const myRole = ref<'host' | 'guest' | ''>('');
  const logs = ref<string>('');
  
  // 待处理的访客 (Host专用)
  const isPendingApproval = ref(false);
  const pendingGuest = ref<{ name: string; id: number } | null>(null);

  // --- 内部变量 (非响应式) ---
  let socket: WebSocket | null = null;
  let peerConnection: RTCPeerConnection | null = null;
  let dataChannel: RTCDataChannel | null = null;

  // --- 外部回调 ---
  let onChannelOpened: ((channel: RTCDataChannel) => void) | null = null;
  
  // 解决时序问题的队列：在设置 RemoteDescription 之前收到的 Candidate 先存起来
  const candidateQueue: RTCIceCandidateInit[] = [];
  let isRemoteDescriptionSet = false;

  // WebRTC 配置
  const rtcConfig = ref<RTCConfiguration>({
    iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }], // 默认 STUN
    bundlePolicy: 'max-bundle',
    iceTransportPolicy: 'all'
  });

  // --- 辅助函数 ---
  const log = (msg: string) => {
    logs.value += `[${new Date().toLocaleTimeString()}] ${msg}\n`;
  };

  // --- 核心 WebRTC 逻辑 ---

  // 1. 初始化 PeerConnection
  const setupPeerConnection = () => {
    if (peerConnection) peerConnection.close();
    
    peerConnection = new RTCPeerConnection(rtcConfig.value);
    isRemoteDescriptionSet = false;
    candidateQueue.length = 0;

    // 收集本端的 ICE Candidate 并通过 WebSocket 发送给对方
    peerConnection.onicecandidate = (event) => {
      if (event.candidate && socket) {
        socket.send(JSON.stringify({ type: 'candidate', candidate: event.candidate }));
      }
    };

    // 监听连接状态变化
    peerConnection.onconnectionstatechange = () => {
      const state = peerConnection?.connectionState || 'unknown';
      // @ts-ignore
      p2pStatus.value = state; 
      log(`ICE 状态变更: ${state}`);
    };

    // 监听数据通道 (作为接收方时触发)
    peerConnection.ondatachannel = (event) => {
      log('收到数据通道请求');
      dataChannel = event.channel;
      setupDataChannelListeners(dataChannel);
    };
  };

  // 2. 处理信令消息 (Offer/Answer/Candidate)
  const handleSignalingMessage = async (msg: any) => {
    if (!peerConnection) return;

    try {
      if (msg.type === 'offer') {
        // 收到 Offer: 设置远端描述 -> 创建 Answer -> 设置本地描述 -> 发送 Answer
        await peerConnection.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        isRemoteDescriptionSet = true;
        processCandidateQueue(); // 处理之前堆积的 Candidate

        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        socket?.send(JSON.stringify({ type: 'answer', sdp: answer }));

      } else if (msg.type === 'answer') {
        // 收到 Answer: 设置远端描述
        await peerConnection.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        isRemoteDescriptionSet = true;
        processCandidateQueue();

      } else if (msg.type === 'candidate') {
        // 收到 ICE Candidate
        if (msg.candidate) {
          if (isRemoteDescriptionSet) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(msg.candidate));
          } else {
            candidateQueue.push(msg.candidate); // 还没 Ready，先入队
          }
        }
      }
    } catch (e) {
      console.error(e);
      log(`信令处理错误: ${e}`);
    }
  };

  const processCandidateQueue = async () => {
    for (const candidate of candidateQueue) {
      try { await peerConnection?.addIceCandidate(new RTCIceCandidate(candidate)); }
      catch (e) { console.warn(e); }
    }
    candidateQueue.length = 0;
  };

  const setupDataChannelListeners = (channel: RTCDataChannel) => {
    channel.onopen = () => {
      p2pStatus.value = 'connected';
      log('P2P 数据通道已开启');
      
      // [新增] 如果注册了外部回调，将通道实例传出去
      if (onChannelOpened) {
        onChannelOpened(channel);
      }
    };
    
    // 注意：onmessage 的监听权将移交给 useFileTransfer，这里不再处理
  };
  // 4. WebSocket 消息路由
  const handleSocketMessage = (msg: any) => {
    if (msg.type === 'role') {
        myRole.value = msg.role;
        log(`角色分配: ${msg.role}`);
        if (msg.role === 'guest') {
            isPendingApproval.value = true;
            socket?.send(JSON.stringify({ type: 'join_request' }));
        } else {
            isConnected.value = true; // Host 直接连接成功
        }
    } else if (msg.type === 'join_approve') {
        isPendingApproval.value = false;
        isConnected.value = true;
        log('房主同意，建立 P2P 中...');
    } else if (['offer', 'answer', 'candidate'].includes(msg.type)) {
        handleSignalingMessage(msg);
    } 
    // ... 其他业务消息 (join_request 等) 可通过回调暴露给组件，或在此处理状态
    else if (msg.type === 'join_request') {
        pendingGuest.value = { name: msg.deviceName, id: msg.guestId };
    }
  };

  // --- 暴露给组件的方法 ---

  const setDataChannelCallback = (fn: (channel: RTCDataChannel) => void) => {
    onChannelOpened = fn;
  };
  
  const connectSocket = (id: string) => {
    if (isJoining.value || isConnected.value) return;
    
    isJoining.value = true;
    roomId.value = id;

    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${wsProtocol}//${WORKER_HOST}/api/room?id=${id}`);

    socket.onopen = () => {
      isJoining.value = false;
      log('WebSocket 已连接，等待信令...');
      setupPeerConnection();
    };

    socket.onmessage = (event) => {
      handleSocketMessage(JSON.parse(event.data));
    };

    socket.onclose = () => {
      isConnected.value = false;
      p2pStatus.value = 'disconnected';
      log('WebSocket 断开');
    };
  };

  const startCall = async () => {
    if (!peerConnection) return;
    dataChannel = peerConnection.createDataChannel("file-transfer");
    setupDataChannelListeners(dataChannel);

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket?.send(JSON.stringify({ type: 'offer', sdp: offer }));
    log('已发送 Offer');
  };

  const approveGuest = () => {
      if (!socket || !pendingGuest.value) return;
      socket.send(JSON.stringify({ type: 'join_approve', guestId: pendingGuest.value.id }));
      pendingGuest.value = null;
      startCall(); // 房主同意后，主动发起 P2P 连接
  };

  const rejectGuest = () => {
    if (!socket || !pendingGuest.value) return;
    socket.send(JSON.stringify({ type: 'join_reject', guestId: pendingGuest.value.id }));
    pendingGuest.value = null;
  };

  onUnmounted(() => {
    socket?.close();
    peerConnection?.close();
  });

  return {
    roomId, isConnected, isJoining, p2pStatus, myRole, logs,
    isPendingApproval, pendingGuest,
    rtcConfig, // 暴露出去以便组件修改 ICE Server
    connectSocket,
    approveGuest,
    rejectGuest,
    log,
    setDataChannelCallback
  };
}