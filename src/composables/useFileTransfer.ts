import { ref } from 'vue';
import streamSaver from 'streamsaver';
import { formatSize, formatTime } from '@/utils';

// --- 常量配置 ---
const CHUNK_SIZE = 16 * 1024; // 16KB 分片
const MAX_BUFFERED_AMOUNT = 64 * 1024; // 64KB 背压阈值

export function useFileTransfer(log: (msg: string) => void) {
  // --- 状态变量 ---
  const transferProgress = ref(0);
  const transferStatus = ref('');
  const receivedFileUrl = ref<string | null>(null); // Blob 模式下的下载链接
  const receivedFileName = ref('');
  const saverMethod = ref<'StreamSaver' | 'blob'>('StreamSaver');
  const transferSpeed = ref('0 B/s');
  const timeRemaining = ref('calculating...');

  // --- 内部变量 ---
  let fileWriter: WritableStreamDefaultWriter | null = null;
  let receivingMeta: { name: string; size: number; type: string } | null = null;
  let processedBytes = 0;
  let receivedChunks: Blob[] = []; // Blob 模式缓存
  let activeDataChannel: RTCDataChannel | null = null;
  let speedInterval: any = null;
  let lastBytes = 0;

  // --- 核心逻辑：绑定通道 ---
  const setupTransferChannel = (channel: RTCDataChannel) => {
    activeDataChannel = channel;
    channel.binaryType = 'arraybuffer'; // 确保接收二进制流
    
    // 根据当前模式绑定不同的处理函数
    channel.onmessage = (event) => {
      if (saverMethod.value === 'blob') {
        handleDataMessageBlob(event);
      } else {
        handleDataMessageStream(event);
      }
    };
  };

  const startSpeedTracker = (total: number) => {
    stopSpeedTracker(); // 防止重复开启
    processedBytes = 0;
    lastBytes = 0;
    let totalBytes = total;
    transferSpeed.value = '0 B/s';
    timeRemaining.value = '--';

    speedInterval = setInterval(() => {
      const currentBytes = processedBytes;
      const diff = currentBytes - lastBytes;
      const speedBytesPerSec = diff; // 因为我们每1秒执行一次，所以差值就是 B/s
      
      // 1. 更新速度显示
      transferSpeed.value = formatSize(speedBytesPerSec) + '/s';

      // 2. 更新剩余时间显示
      if (speedBytesPerSec > 0) {
        const remaining = totalBytes - currentBytes;
        const seconds = Math.ceil(remaining / speedBytesPerSec);
        timeRemaining.value = formatTime(seconds);
      } else {
        timeRemaining.value = '--';
      }

      lastBytes = currentBytes;
    }, 1000); // 每秒刷新一次
  };

  const stopSpeedTracker = () => {
    if (speedInterval) clearInterval(speedInterval);
    speedInterval = null;
    transferSpeed.value = ''; // 传输结束清空
    timeRemaining.value = '';
  };

  // --- 逻辑 A：发送端 (带背压控制) ---
  const sendFile = async (file: File) => {
    if (!activeDataChannel || activeDataChannel.readyState !== 'open') {
      throw new Error("P2P 通道未就绪");
    }

    transferProgress.value = 0;
    transferStatus.value = `准备发送: ${file.name}`;
    log(`⬆️ 开始发送: ${file.name}`);

    startSpeedTracker(file.size);

    try {
      // 1. 发送元数据
      activeDataChannel.send(JSON.stringify({
        type: 'meta', name: file.name, size: file.size, mime: file.type
      }));

      // 2. 分片发送循环
      let offset = 0;
      while (offset < file.size) {
        // 背压控制：如果缓冲区满了，暂停发送，防止浏览器崩溃
        while (activeDataChannel.bufferedAmount > MAX_BUFFERED_AMOUNT) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }

        const chunk = file.slice(offset, offset + CHUNK_SIZE);
        const buffer = await chunk.arrayBuffer();
        activeDataChannel.send(buffer);
        
        offset += CHUNK_SIZE;

        processedBytes = offset;
        transferProgress.value = Math.min(100, Math.floor((offset / file.size) * 100));
        transferStatus.value = "发送中...";
      }

      // 3. 确保最后的数据发完
      while (activeDataChannel.bufferedAmount > 0) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      activeDataChannel.send(JSON.stringify({ type: 'eof' }));

      transferStatus.value = '发送完成';
      log('⬆️ 发送完毕');
    } catch (e) {
      log(`发送出错: ${e}`);
      transferStatus.value = '发送中断';
      throw e;
    } finally {
      stopSpeedTracker();
    }
  };

  // --- 逻辑 B：接收端 (StreamSaver) ---
  const handleDataMessageStream = async (event: MessageEvent) => {
    const data = event.data;
    if (typeof data === 'string') {
      const msg = JSON.parse(data);
      if (msg.type === 'meta') {
        log(`⬇️ 开始下载(Stream): ${msg.name}`);
        receivingMeta = msg;
        processedBytes = 0;
        transferStatus.value = `正在下载: ${msg.name}`;

        startSpeedTracker(msg.size);
        
        const fileStream = streamSaver.createWriteStream(msg.name, { size: msg.size });
        fileWriter = fileStream.getWriter();
      } else if (msg.type === 'eof') {
        if (fileWriter) { await fileWriter.close(); fileWriter = null; }
        receivingMeta = null;
        stopSpeedTracker();
        transferStatus.value = '下载完成';
        log('⬇️ 文件写入完毕');
      }
    } else if (data instanceof ArrayBuffer && fileWriter && receivingMeta) {
      await fileWriter.write(new Uint8Array(data));
      processedBytes += data.byteLength;
      transferProgress.value = Math.floor((processedBytes / receivingMeta.size) * 100);
    }
  };

  // --- 逻辑 C：接收端 (Blob/Memory) ---
  const handleDataMessageBlob = (event: MessageEvent) => {
    const data = event.data;
    if (typeof data === 'string') {
      const msg = JSON.parse(data);
      if (msg.type === 'meta') {
        log(`⬇️ 开始接收(内存): ${msg.name}`);
        receivingMeta = msg;
        receivedChunks = [];
        processedBytes = 0;
        startSpeedTracker(msg.size);

        receivedFileUrl.value = null;
        transferStatus.value = `正在缓存: ${msg.name}`;
      } else if (msg.type === 'eof' && receivingMeta) {
        const fileBlob = new Blob(receivedChunks, { type: receivingMeta.type });
        receivedFileUrl.value = URL.createObjectURL(fileBlob);
        receivedFileName.value = receivingMeta.name;
        transferStatus.value = '接收完成';

        stopSpeedTracker();
        receivedChunks = [];
        receivingMeta = null;
      }
    } else if (data instanceof ArrayBuffer && receivingMeta) {
      receivedChunks.push(new Blob([data]));
      processedBytes += data.byteLength;
      transferProgress.value = Math.floor((processedBytes / receivingMeta.size) * 100);
    }
  };

  return {
    transferProgress, transferStatus,
    receivedFileUrl, receivedFileName,
    saverMethod,
    transferSpeed, timeRemaining,
    setupTransferChannel, sendFile
  };
}