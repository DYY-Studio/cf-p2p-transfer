import { ref, onUnmounted } from 'vue';
import { encryptMsg, decryptMsg } from '@/utils/crypto';
import PartySocket from 'partysocket';

const WORKER_HOST = import.meta.env.VITE_WORKER_HOST;

const MAX_RECONNECT_ATTEMPTS = 5; // 最大重连次数

export function useRoomConnection() {
  // --- 状态定义 ---
  const roomId = ref('');
  const isConnected = ref(false); // WebSocket 连接状态
  const isJoining = ref(false);
  const p2pStatus = ref<'disconnected' | 'new' | 'connecting' | 'connected' | 'failed'>('disconnected'); // P2P 状态
  const myRole = ref<'host' | 'guest' | ''>('');
  const logs = ref<string>('');
  const password = ref('');
  const sessionTicket = ref('');
  
  // 待处理的访客 (Host专用)
  const isPendingApproval = ref(false);
  const pendingGuest = ref<{ name: string; id: number } | null>(null);
  
  // --- 内部变量 (非响应式) ---
  let socket: PartySocket | null = null;
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
  
  const sendSignalingMessage = async (msg: any) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;

    const envelope: any = { 
        type: msg.type,
        guestId: msg.guestId, 
    };

    if (password.value && msg.type !== 'ping') {
      try {
        const encryptedData = await encryptMsg(msg, password.value, roomId.value);
        envelope.payload = encryptedData;
      } catch (e) {
        log(`❌ 加密失败: ${e}`);
        return;
      }
    } else {
      Object.assign(envelope, msg);
    }
    socket.send(JSON.stringify(envelope));
  };
  
  // 初始化 PeerConnection
  const setupPeerConnection = () => {
    if (peerConnection) {
      if (!['failed', 'closed'].includes(peerConnection.connectionState)) {
        return; 
      }
      peerConnection.close();
    }
    
    peerConnection = new RTCPeerConnection(rtcConfig.value);
    isRemoteDescriptionSet = false;
    candidateQueue.length = 0;
    
    // 收集本端的 ICE Candidate 并通过 WebSocket 发送给对方
    peerConnection.onicecandidate = (event) => {
      if (event.candidate && socket) {
        sendSignalingMessage({ type: 'candidate', candidate: event.candidate });
      }
    };
    
    // 监听连接状态变化
    peerConnection.onconnectionstatechange = () => {
      const state = peerConnection?.connectionState || 'unknown';
      // @ts-ignore
      p2pStatus.value = state; 
      log(`ICE 状态变更: ${state}`);
      
      if (state === 'failed' || state === 'disconnected') {
        log('检测到 P2P 断开，尝试重启...');
        restartIce();
      }
    };
    
    // 监听数据通道 (作为接收方时触发)
    peerConnection.ondatachannel = (event) => {
      log('收到数据通道请求');
      dataChannel = event.channel;
      setupDataChannelListeners(dataChannel);
    };
  };
  
  const restartIce = async () => {
    if (!peerConnection || !socket) return;
    // 只有 Host 有权发起重启，Guest 等待 Offer
    if (myRole.value === 'host') {
      try {
        const offer = await peerConnection.createOffer({ iceRestart: true });
        await peerConnection.setLocalDescription(offer);
        socket.send(JSON.stringify({ type: 'offer', sdp: offer }));
        log('已发起 ICE 重启协商');
      } catch (e) {
        log(`ICE 重启失败: ${e}`);
      }
    }
  };
  
  // 处理信令消息 (Offer/Answer/Candidate)
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
        sendSignalingMessage({ type: 'answer', sdp: answer });
        
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
      
      if (onChannelOpened) {
        onChannelOpened(channel);
      }
    };
  };
  // WebSocket 消息路由
  const handleSocketMessage = async (rawMsg: any) => {
    if (rawMsg.type === 'pong') return;

    let msg = rawMsg;

    if (rawMsg.payload && rawMsg.payload._enc) {
        if (!password.value) {
            log('收到加密消息但未设置密码，忽略');
            return;
        }
        try {
            msg = await decryptMsg(rawMsg.payload, password.value, roomId.value);
        } catch (e) {
            log('解密失败：对方密码可能不同');
            return; 
        }
    }

    if (msg.type === 'role') {
      myRole.value = msg.role;
      log(`角色分配: ${msg.role}`);
      if (msg.role === 'guest') {
        if (p2pStatus.value !== 'connected') {
          isPendingApproval.value = true;
          sendSignalingMessage({ type: 'join_request' });
        } else {
          isConnected.value = true;
        }
      } else {
        isConnected.value = true; // Host 直接连接成功
      }
    } else if (msg.type === 'join_approve') {
      isPendingApproval.value = false;
      isConnected.value = true;
      log('房主同意，建立 P2P 中...');
      
      if (peerConnection?.connectionState !== 'connected') {
        setupPeerConnection();
      }
    } else if (['offer', 'answer', 'candidate'].includes(msg.type)) {
      handleSignalingMessage(msg);
    } else if (msg.type === 'join_request') {
      pendingGuest.value = { name: msg.deviceName, id: msg.guestId };
    } else if (msg.type === 'session_token') {
      sessionTicket.value = msg.content;
    } else if (msg.type === 'rtc_config') {
      rtcConfig.value.iceServers = JSON.parse(msg.data).iceServers;
    }
  };
  
  // --- 暴露给组件的方法 ---
  
  const setDataChannelCallback = (fn: (channel: RTCDataChannel) => void) => {
    onChannelOpened = fn;
  };
  
  const connectSocket = (id: string, authData: {isRetry?: boolean, token?: string, useTURN?: boolean}) => {
    const {isRetry, token, useTURN} = authData

    if ((isJoining.value || isConnected.value) && !isRetry) return;
    
    if (!isRetry) {
      roomId.value = id;
    }
    
    isJoining.value = true;
    
    if (socket) {
      socket.onclose = null;
      socket.close();
    }
    
    const queryObj: Record<string, string> = {};
    if (isRetry && sessionTicket.value) {
      queryObj.ticket = sessionTicket.value;
      log('正在使用 Session Ticket 尝试重连...');
    } else if (token) {
      queryObj.token = token;
    } else {
      log('缺少验证凭据，无法连接');
      return;
    }
    if (useTURN) queryObj.turn = 'true';
    if (id) queryObj.id = id;

    socket = new PartySocket({
        host: WORKER_HOST,
        room: id,
        query: queryObj,
        maxRetries: MAX_RECONNECT_ATTEMPTS,
        protocol: 'wss'
    });
    
    socket.onopen = () => {
      isConnected.value = true;
      isJoining.value = false;
      log('WebSocket 已连接，等待信令...');
      
      if (!peerConnection) setupPeerConnection();
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
    sendSignalingMessage({ type: 'offer', sdp: offer });
    log('已发送 Offer');
  };
  
  const leaveRoom = () => {
    socket?.close();
    peerConnection?.close();
    isConnected.value = false;
    p2pStatus.value = 'disconnected';
  }
  
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
    leaveRoom()
  });
  
  return {
    roomId, isConnected, isJoining, p2pStatus, myRole, logs,
    isPendingApproval, pendingGuest, password,
    connectSocket, leaveRoom,
    approveGuest, rejectGuest,
    log, setDataChannelCallback
  };
}