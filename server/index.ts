import { DurableObject } from "cloudflare:workers";

export interface Env {
	SIGNALING_DO: DurableObjectNamespace;
	TURN_KEY_ID: string;
	TURN_KEY_API_TOKEN: string;
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

export class SignalingDurableObject extends DurableObject {
	// 存储当前房间内的所有 WebSocket 连接
	sessions: WebSocket[] = [];

	async fetch(request: Request): Promise<Response> {
		// 创建 WebSocket 对
		const [client, server] = Object.values(new WebSocketPair());

		await this.handleSession(server);

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}

	async handleSession(webSocket: WebSocket) {
		// 接受连接
		webSocket.accept();
		this.sessions.push(webSocket);

		// 监听消息
		webSocket.addEventListener("message", async (msg) => {
			try {
				// 简单的广播逻辑：把收到的消息转发给房间里“除了自己以外”的所有人
				// 在 P2P 握手阶段，这用于交换 SDP 和 ICE Candidate
				this.broadcast(msg.data as string, webSocket);
			} catch (err) {
				console.error("Broadcast error", err);
			}
		});

		// 监听关闭
		webSocket.addEventListener("close", () => {
			this.sessions = this.sessions.filter((s) => s !== webSocket);
		});
	}

	broadcast(message: string, sender: WebSocket) {
		for (const session of this.sessions) {
			if (session !== sender && session.readyState === WebSocket.READY_STATE_OPEN) {
				session.send(message);
			}
		}
	}
}