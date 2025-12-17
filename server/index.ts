import { DurableObject } from "cloudflare:workers";
import { UAParser } from 'ua-parser-js';

export interface Env {
	SIGNALING_DO: DurableObjectNamespace;
	TURN_KEY_ID: string;
	TURN_KEY_API_TOKEN: string;
	TURNSTILE_SECRET_KEY: string;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		
		// 路由：只处理 /api/room 请求
		if (url.pathname === "/api/room") {
			const upgradeHeader = request.headers.get("Upgrade");
			if (!upgradeHeader || upgradeHeader !== "websocket") {
				return new Response("Expected Upgrade: websocket", { status: 426 });
			}

			// 获取房间号，如果没有则随机生成或者报错，这里假设前端必须传 room ID
			const roomId = url.searchParams.get("id") || "default-room";
			
			// 获取 Durable Object ID (根据房间号生成，保证同一个房间号总是去往同一个实例)
			const id = env.SIGNALING_DO.idFromName(roomId);
			const stub = env.SIGNALING_DO.get(id);

			// 将请求转交给 Durable Object
			return stub.fetch(request);
		}

		if (url.pathname === "/api/turn" && request.method === "POST") {
			let clientToken = "";
      
			try {
				const body = await request.json() as any;
				clientToken = body.token;
			} catch (e) {
				return new Response("Missing JSON body", { status: 400 });
			}

			if (!clientToken) {
				return new Response("Missing Turnstile token", { status: 403 });
			}

			// 1. 获取客户端 IP (Cloudflare Worker 会自动通过 header 传递)
			const ip = request.headers.get("CF-Connecting-IP");

			// 2. 构造验证请求
			const formData = new FormData();
			formData.append("secret", env.TURNSTILE_SECRET_KEY);
			formData.append("response", clientToken);
			if (ip) formData.append("remoteip", ip);

			// 3. 向 Cloudflare 验证 API 发起请求
			const verifyUrl = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
			const verifyRes = await fetch(verifyUrl, {
				method: "POST",
				body: formData,
			});

			const verifyResult = await verifyRes.json() as any;

			// 4. 判断验证结果
			if (!verifyResult.success) {
				console.log("Turnstile validation failed:", verifyResult);
				return new Response("Invalid Captcha", { status: 403 });
			}


			// 这里的 API 地址是 Cloudflare Calls 专用的
			const endpoint = `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`;
			
			const cfResponse = await fetch(endpoint, {
				method: "POST",
				headers: {
					"Authorization": `Bearer ${env.TURN_KEY_API_TOKEN}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					ttl: 86400, // 凭证有效期 24 小时
				}),
			});

			const data = await cfResponse.json();
			
			// Cloudflare 返回的数据里直接包含了 { iceServers: [...] }
			// 我们直接透传给前端
			return new Response(JSON.stringify(data), {
				headers: { 
					"Content-Type": "application/json",
					"Access-Control-Allow-Origin": "*" // 如果前后端分离开发，可能需要 CORS
				},
			});
		}

		return new Response("Not found", { status: 404 });
	},
};

type SignalMessage = {
  type: 'role' | 'join_request' | 'join_approve' | 'join_reject' | 'offer' | 'answer' | 'candidate';
  [key: string]: any;
};

export class SignalingDurableObject extends DurableObject {
	// 存储当前房间内的所有 WebSocket 连接
	sessions: WebSocket[] = [];
	hostSession: WebSocket | null = null;
	approvedSessions: Set<WebSocket> = new Set();

	uaParser: UAParser = new UAParser();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	async fetch(request: Request): Promise<Response> {
		let currentAlarm = await this.ctx.storage.getAlarm();
		if (currentAlarm !== null) {
			await this.ctx.storage.deleteAlarm();
		}

		// 创建 WebSocket 对
		const [client, server] = Object.values(new WebSocketPair());

		await this.handleSession(server, request);

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}

	async handleSession(webSocket: WebSocket, request: Request) {
		// 接受连接
		webSocket.accept();
		this.sessions.push(webSocket);

		const isHost = this.hostSession === null || (this.hostSession && webSocket === this.hostSession);
		if (isHost) {
			this.hostSession = webSocket;
			this.approvedSessions.add(webSocket);
			const currAlarm = await this.ctx.storage.getAlarm();
			if (currAlarm) { 
				await this.ctx.storage.deleteAlarm();
			}
		}

		webSocket.send(JSON.stringify({ 
			type: 'role', 
			role: isHost ? 'host' : 'guest' 
		}));

		const ua = request.headers.get('User-Agent') || 'unknown';
		this.uaParser.setUA(ua)

		const parseResult = this.uaParser.getResult();
		const deviceName = `${parseResult.device.type??'unknown device'} (${parseResult.os.name??'unknown os'}, ${parseResult.browser.name??'unknown browser'})`;

		// 监听消息
		webSocket.addEventListener("message", async (event) => {
			try {
				const msg = JSON.parse(event.data as string) as SignalMessage;
				// --- A. 处理敲门请求 (Guest -> Host) ---
				if (msg.type === 'join_request') {
				// 只有 Host 存在时才能申请
					if (this.hostSession && this.hostSession.readyState === WebSocket.READY_STATE_OPEN) {
						this.hostSession.send(JSON.stringify({
							type: 'join_request',
							deviceName: deviceName, // 告诉房主是谁在敲门
							guestId: this.sessions.indexOf(webSocket) // 简单用索引做 ID，实际可用 UUID
						}));
					} else {
						// 房主不在，直接拒绝或提示
						webSocket.send(JSON.stringify({ type: 'error', message: 'Host not active' }));
					}
					return;
				}

				// --- B. 处理审批结果 (Host -> Guest) ---
				if (msg.type === 'join_approve') {
					if (webSocket !== this.hostSession) return; // 只有房主能审批

					// 找到对应的 Guest
					const guestIndex = msg.guestId;
					const guestWs = this.sessions[guestIndex];

					if (guestWs) {
						this.approvedSessions.add(guestWs); // 加入白名单
						// 通知 Guest：你进来了
						guestWs.send(JSON.stringify({ type: 'join_approve' }));
					}
					return;
				}

				if (msg.type === 'join_reject') {
					if (webSocket !== this.hostSession) return;
					const guestWs = this.sessions[msg.guestId];
					if (guestWs) {
						guestWs.send(JSON.stringify({ type: 'join_reject' }));
						guestWs.close(); // 拒绝后直接断开
					}
					return;
				}

				if (this.approvedSessions.has(webSocket)) {
					this.broadcast(event.data as string, webSocket);
				} else {
				// 如果不在白名单却发 offer，说明是恶意连接或 Bug，忽略之
					console.warn("Blocked unauthorized signal from guest");
				}
			} catch (err) {
				console.error("Broadcast error", err);
			}
		});

		// 监听关闭
		webSocket.addEventListener("close", async () => {
			await this.userLeft(webSocket);
		});

		webSocket.addEventListener("error", async () => {
			await this.userLeft(webSocket);
		});
	}

	broadcast(message: string, sender: WebSocket) {
		this.sessions.forEach(session => {
			if (session !== sender && 
				session.readyState === WebSocket.READY_STATE_OPEN &&
				this.approvedSessions.has(session) 
			) {
				session.send(message);
			}
		});
	}

	async alarm() {
		this.hostSession = null;
		this.sessions.forEach(s => s.close(1000, "Host left"));
		await this.ctx.storage.deleteAll();
	}

	async userLeft(ws: WebSocket) {
		this.sessions = this.sessions.filter(s => s !== ws);
		this.approvedSessions.delete(ws);
		
		// 如果房主走了，房间重置 (或者你可以设计让下一个顺位成为房主)
		if (ws === this.hostSession) {
			await this.ctx.storage.setAlarm(Date.now() + 10);
		} else if (this.sessions.length == 0) {
			await this.alarm();
		}
	}
}