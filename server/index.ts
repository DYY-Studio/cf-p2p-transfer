import { DurableObject } from "cloudflare:workers";
import { Server, Connection, ConnectionContext, WSMessage, routePartykitRequest, getServerByName } from "partyserver";
import { UAParser } from 'ua-parser-js';
import jwt from "@tsndr/cloudflare-worker-jwt"

export interface Env {
	SIGNALING_DO: DurableObjectNamespace<Server>;
	TURN_KEY_ID: string;
	TURN_KEY_API_TOKEN: string;
	TURNSTILE_SECRET_KEY: string;
	JWT_SECRET_KEY: string;
}

type checkResult = {
	status: number,
	reason: string		
}

export default {

	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		
		if (url.pathname.startsWith("/parties/main/")) {
			const upgradeHeader = request.headers.get("Upgrade");
			if (!upgradeHeader || upgradeHeader !== "websocket") {
				return new Response("Expected Upgrade: websocket", { status: 426 });
			}

			// 获取房间号，如果没有就报错
			const roomId = url.searchParams.get("id");
			if (!roomId) {
				return new Response("Must pass a Room ID", { status: 400 })
			}

			// 获取人机验证Token或者JWT，二者必有其一，否则报错
			if (!url.searchParams.has('token') && !url.searchParams.has('ticket')) {
				return new Response("Must pass either token or ticket", { status: 400 });
			}
			const token = url.searchParams.get('token');
			const ticket = url.searchParams.get('ticket');

			let rtcConfig = ''

			if (url.searchParams.get('turn') !== null) {
				rtcConfig = await this.generateIceServers(env);
			}

			let jwtoken = ''

			// 人机验证
			if (token) {
				const result = await this.turnstileCheck(request, env, token);
				if (result.status !== 200) {
					return new Response(result.reason, { status: result.status });
				} else {
					const jwt_nbf = Math.floor(Date.now() / 1000);
					const jwt_exp = Math.floor(Date.now() / 1000) + (2 * (60 * 60));

					jwtoken = await jwt.sign({
						jti: roomId,
						nbf: jwt_nbf,
						exp: jwt_exp
					}, env.JWT_SECRET_KEY);
				}
			} else if (ticket) {
				const decoded = await jwt.verify(ticket, env.JWT_SECRET_KEY);

				if (!decoded) {
					return new Response("Invalid Ticket", { status: 403 });
				}
				if (!decoded.payload.jti || decoded.payload.jti !== roomId) {
					return new Response("Invalid Ticket", { status: 403 });
				}
			}
			
			// 将请求转交给 Durable Object
			const dummyHeaders = Object.fromEntries(request.headers);
			if (jwtoken) {
				dummyHeaders["session-token"] = jwtoken;
				dummyHeaders["rtc-config"] = rtcConfig;
			}
			const dummyRequest = new Request(url, {
				method: 'GET',
				headers: dummyHeaders,
			})
			const stub = await getServerByName(env.SIGNALING_DO, roomId);
			return stub.fetch(dummyRequest);
		}

		return new Response("Not found", { status: 404 });
	},

	async generateIceServers(env: Env) {
		const endpoint = `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`;
		
		const cfResponse = await fetch(endpoint, {
			method: "POST",
			headers: {
				"Authorization": `Bearer ${env.TURN_KEY_API_TOKEN}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				ttl: 7200, // 凭证有效期 2 小时
			}),
		});

		const data = await cfResponse.json();
		
		return JSON.stringify(data);
	},
	
	async turnstileCheck(request: Request, env: Env, token: string): Promise<checkResult> {
		let clientToken = token;

		if (!clientToken) {
			return { reason: "Missing Turnstile token",  status: 403 };
		}

		const ip = request.headers.get("CF-Connecting-IP");

		const formData = new FormData();
		formData.append("secret", env.TURNSTILE_SECRET_KEY);
		formData.append("response", clientToken);
		if (ip) formData.append("remoteip", ip);

		const verifyUrl = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
		const verifyRes = await fetch(verifyUrl, {
			method: "POST",
			body: formData,
		});

		const verifyResult = await verifyRes.json() as any;

		if (!verifyResult.success) {
			console.log("Turnstile validation failed:", verifyResult);
			return { reason: "Invalid Captcha", status: 403 };
		}
		return { reason: 'OK', status: 200 }
	}
};

type SignalMessage = {
  type: 'role' | 'join_request' | 'join_approve' | 'join_reject' | 'offer' | 'answer' | 'candidate' | 'ping' | 'pong';
  [key: string]: any;
};

export class SignalingDurableObject extends Server<Env> {
	hostConnectionId: string | null = null;
	approvedIds: Set<string> = new Set();

	uaParser: UAParser = new UAParser();

	async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
		const request = ctx.request;

		const isHost = this.hostConnectionId === null;
		if (isHost) {
			this.hostConnectionId = connection.id;
			this.approvedIds.add(connection.id);
			const currAlarm = await this.ctx.storage.getAlarm();
			if (currAlarm) await this.ctx.storage.deleteAlarm();
		}

		connection.send(JSON.stringify({ 
			type: 'role', 
			role: isHost ? 'host' : 'guest' 
		}));

		if (request.headers.has('session-token')) {
			connection.send(JSON.stringify({
				type: 'session_token',
				content: request.headers.get('session-token')
			}));
		}

		if (request.headers.get('rtc-config')) {
			connection.send(JSON.stringify({
				type: 'rtc_config',
				data: request.headers.get('rtc-config') 
			}));
		}

		const ua = request.headers.get('User-Agent') || 'unknown';
		this.uaParser.setUA(ua);

		const parseResult = this.uaParser.getResult();
		(connection as any).deviceName = `${parseResult.device.type??'unknown device'} (${parseResult.os.name??'unknown os'}, ${parseResult.browser.name??'unknown browser'})`;
	}

	async onMessage(connection: Connection, message: WSMessage): Promise<void> {
		try {
			message = message as string;
			const msg = JSON.parse(message) as SignalMessage;
			if (msg.type === 'join_request') {
				const hostConn = this.getHostConnection();
				if (hostConn && hostConn.readyState === WebSocket.READY_STATE_OPEN) {
					hostConn.send(JSON.stringify({
						type: 'join_request',
						deviceName: (connection as any).deviceName, // 是谁在敲门~
						guestId: connection.id
					}));
				} else {
					// 房主不在，直接拒绝或提示
					connection.send(JSON.stringify({ type: 'error', message: 'Host not active' }));
				}
				return;
			}

			if (msg.type === 'join_approve') {
				if (connection.id !== this.hostConnectionId) return; // 只有房主能审批

				// 找到对应的 Guest
				const guestId = msg.guestId;
				const guestCoonn = this.getConnection(guestId);

				if (guestCoonn) {
					this.approvedIds.add(guestId); // 加入白名单
					guestCoonn.send(JSON.stringify({ type: 'join_approve' }));
				}
				return;
			}

			if (msg.type === 'join_reject') {
				if (connection.id !== this.hostConnectionId) return;
				const guestConn = this.getConnection(msg.guestId);
				if (guestConn) {
					guestConn.send(JSON.stringify({ type: 'join_reject' }));
					guestConn.close(); // 拒绝后直接断开
				}
				return;
			}

			if (this.approvedIds.has(connection.id)) {
				this.broadcast(message, [connection.id]);
			} else {
				console.warn("Blocked unauthorized signal from guest");
			}
		} catch (err) {
			console.error("Broadcast error", err);
		}
	}

	async onClose(connection: Connection, code: number, reason: string, wasClean: boolean): Promise<void> {
		this.approvedIds.delete(connection.id);
		
		// 如果房主走了（可能是掉线——）先等待10秒，还没恢复就给清理掉
		// 这时全走了就直接清理
		if (connection.id === this.hostConnectionId) {
			await this.ctx.storage.setAlarm(Date.now() + 10 * 1000);
		} else {
			const activeConns = [...this.getConnections()];
			if (activeConns.length === 0) {
				await this.ctx.storage.deleteAll();
			}
		}
	}

	getHostConnection() {
		return this.hostConnectionId ? this.getConnection(this.hostConnectionId) : null;
	}

	async alarm() {
		this.hostConnectionId = null;
		for (const conn of this.getConnections()) {
			conn.close(1000, "Host left");
		}
		await this.ctx.storage.deleteAll();
	}
}