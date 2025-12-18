const getKey = async (password: string, salt: string): Promise<CryptoKey> => {
  const enc = new TextEncoder();
  const keyMaterial = await window.crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );

  return window.crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: enc.encode(salt),
      iterations: 100000, // 迭代次数，越高越安全但越慢
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
};

export const encryptMsg = async (data: any, password: string, roomId: string) => {
  try {
    const key = await getKey(password, roomId);
    const iv = window.crypto.getRandomValues(new Uint8Array(12)); // 随机初始化向量
    const encodedData = new TextEncoder().encode(JSON.stringify(data));

    const encryptedContent = await window.crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv },
      key,
      encodedData
    );

    return {
      _enc: true, // 标记这是加密消息
      iv: btoa(String.fromCharCode(...iv)),
      content: btoa(String.fromCharCode(...new Uint8Array(encryptedContent)))
    };
  } catch (e) {
    console.error("Encryption failed:", e);
    throw e;
  }
};


export const decryptMsg = async (wrapper: any, password: string, roomId: string) => {
  try {
    if (!wrapper._enc) return wrapper; // 如果不是加密消息，直接返回（兼容旧版或系统消息）

    const key = await getKey(password, roomId);
    
    const iv = Uint8Array.from(atob(wrapper.iv), c => c.charCodeAt(0));
    const content = Uint8Array.from(atob(wrapper.content), c => c.charCodeAt(0));

    const decryptedBuffer = await window.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv },
      key,
      content
    );

    const decoded = new TextDecoder().decode(decryptedBuffer);
    return JSON.parse(decoded);
  } catch (e) {
    // 解密失败通常意味着密码错误
    throw new Error("Decryption failed (Wrong Password?)");
  }
};